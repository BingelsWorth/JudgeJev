import type { ProviderCompletionError, ProviderId } from "./types.js";

export type RetryableFailureClass = "rate_limited" | "transient" | "persistent";

export interface UpstreamErrorOptions {
  status?: number;
  code?: string;
  errorType?: string;
  param?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export class UpstreamError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly errorType?: string;
  readonly param?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: UpstreamErrorOptions = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = options.status;
    this.code = options.code;
    this.errorType = options.errorType;
    this.param = options.param;
    this.retryable = options.retryable ?? classifyRetryableFailure(options.status, options.code, options.errorType) !== "persistent";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function classifyRetryableFailure(
  status?: number,
  code?: string,
  errorType?: string,
): RetryableFailureClass {
  const signal = `${code ?? ""} ${errorType ?? ""}`.trim().toLowerCase();

  if (status === 429 || signal.includes("rate_limit") || signal.includes("too_many_requests")) {
    return "rate_limited";
  }

  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 407 ||
    status === 410 ||
    status === 415 ||
    status === 426 ||
    status === 451 ||
    signal.includes("authentication_error") ||
    signal.includes("invalid_api_key") ||
    signal.includes("model_not_found") ||
    signal.includes("model_not_supported") ||
    signal.includes("unsupported_model") ||
    signal.includes("quota_exceeded") ||
    signal.includes("insufficient_quota") ||
    signal.includes("permission_denied")
  ) {
    return "persistent";
  }

  if (
    status === 408 ||
    (status !== undefined && status >= 500 && status < 600) ||
    signal.includes("overloaded") ||
    signal.includes("server_error") ||
    signal.includes("service_unavailable") ||
    signal.includes("temporarily_unavailable")
  ) {
    return "transient";
  }

  return "persistent";
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof UpstreamError) return error.retryable;
  return true;
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 30_000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isRetryableError(error)) {
        throw error;
      }

      const retryAfterMs = error instanceof UpstreamError ? error.retryAfterMs : undefined;
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = retryAfterMs ?? (options.jitter ? Math.floor(exponentialDelay / 2 + Math.random() * (exponentialDelay / 2)) : exponentialDelay);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function fetchOk(
  fetchRequest: () => Promise<Response>,
  options?: RetryOptions,
): Promise<Response> {
  return retryWithBackoff(async () => {
    const response = await fetchRequest();
    if (!response.ok) throw await readUpstreamError(response);
    return response;
  }, options);
}

export async function readUpstreamError(response: Response): Promise<UpstreamError> {
  const status = response.status;
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  const envelope = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const error = envelope?.error && typeof envelope.error === "object" ? (envelope.error as Record<string, unknown>) : envelope;
  const structuredMessage = typeof error?.message === "string" ? error.message.trim() : "";
  const message = structuredMessage || (status ? `upstream request failed with status ${status}` : "upstream request failed");
  const code = scalarString(error?.code) ?? scalarString(envelope?.code);
  const errorType = scalarString(error?.type) ?? scalarString(envelope?.type);
  const param = scalarString(error?.param) ?? scalarString(envelope?.param);
  const retryable = classifyRetryableFailure(status, code, errorType) !== "persistent";

  return new UpstreamError(message, {
    status,
    code,
    errorType,
    param,
    retryable,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function toProviderCompletionError(
  error: unknown,
  provider: ProviderId,
  upstreamModel: string,
  details?: Record<string, unknown>,
): ProviderCompletionError {
  if (error instanceof UpstreamError) {
    return {
      code: classifyToAttemptErrorCode(error.status, error.code, error.errorType),
      message: error.message,
      retryable: error.retryable,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      provider,
      upstreamModel,
      details: { ...details, code: error.code, errorType: error.errorType, param: error.param },
    };
  }

  if (error instanceof Error) {
    const isAbort = isAbortError(error);
    return {
      code: isAbort ? "timeout" : "network_error",
      message: error.message,
      retryable: !isAbort,
      provider,
      upstreamModel,
      details,
    };
  }

  return {
    code: "network_error",
    message: typeof error === "string" ? error : "unknown provider error",
    retryable: true,
    provider,
    upstreamModel,
    details,
  };
}

function classifyToAttemptErrorCode(
  status?: number,
  code?: string,
  errorType?: string,
): ProviderCompletionError["code"] {
  const signal = `${code ?? ""} ${errorType ?? ""}`.trim().toLowerCase();

  if (status === 401 || status === 403 || signal.includes("authentication") || signal.includes("invalid_api_key")) {
    return "authentication_error";
  }
  if (
    status === 404 ||
    status === 410 ||
    signal.includes("model_not_found") ||
    signal.includes("model_not_supported") ||
    signal.includes("unsupported_model")
  ) {
    return "unsupported_model";
  }
  if (status === 429 || signal.includes("rate_limit") || signal.includes("too_many_requests")) {
    return "rate_limited";
  }
  if (status === 408 || (status !== undefined && status >= 500 && status < 600)) {
    return "upstream_error";
  }
  if (status === 400 || status === 402 || status === 415 || status === 422 || status === 426 || status === 451) {
    return "upstream_error";
  }
  if (signal.includes("invalid") || signal.includes("malformed") || signal.includes("parse")) {
    return "invalid_response";
  }
  return "upstream_error";
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
