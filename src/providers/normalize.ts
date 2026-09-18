import type { V1AttemptErrorCode, V1Candidate, V1Endpoint, V1FailedAttemptForEndpoint, V1FinishReasonForProtocol, V1ModelMetadata, V1ProtocolForEndpoint, V1Usage } from "../v1/contracts.js";
import type { ProviderCompletion, ProviderCompletionError } from "./types.js";
import { toProviderCompletionError } from "./errors.js";

export interface NormalizeCandidateOptions {
  requestId: string;
  endpoint: V1Endpoint;
  id: string;
  model: V1ModelMetadata;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export function normalizeProviderCompletion(
  completion: ProviderCompletion,
  options: NormalizeCandidateOptions,
): V1Candidate<V1Endpoint> {
  return {
    requestId: options.requestId,
    id: options.id,
    endpoint: options.endpoint,
    protocol: options.endpoint === "messages" ? "anthropic_messages" : options.endpoint === "chat/completions" ? "openai_chat_completions" : "openai_responses",
    status: "succeeded",
    model: options.model,
    durationMs: options.durationMs,
    response: completion.raw as never,
    content: completion.content,
    usage: normalizeUsage(completion.usage),
    finishReason: normalizeFinishReason(completion.finishReason, options.endpoint),
    metadata: options.metadata,
  };
}

export function normalizeProviderError(
  error: unknown,
  provider: string,
  upstreamModel: string,
  options: Omit<NormalizeCandidateOptions, "model"> & { model: V1ModelMetadata },
): V1FailedAttemptForEndpoint<V1Endpoint> {
  const normalized = toProviderCompletionError(error, provider as never, upstreamModel, options.metadata);
  return {
    requestId: options.requestId,
    id: options.id,
    endpoint: options.endpoint,
    protocol: options.endpoint === "messages" ? "anthropic_messages" : options.endpoint === "chat/completions" ? "openai_chat_completions" : "openai_responses",
    status: "failed",
    model: options.model,
    error: {
      attemptId: options.id,
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      status: normalized.status,
      retryAfterMs: normalized.retryAfterMs,
      provider: normalized.provider,
      upstreamModel: normalized.upstreamModel,
      details: normalized.details,
    },
  };
}

export function normalizeUsage(usage?: { inputTokens: number; outputTokens: number }): V1Usage | undefined {
  if (!usage) return undefined;
  const inputTokens = Number(usage.inputTokens);
  const outputTokens = Number(usage.outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function normalizeFinishReason(
  finishReason: string | undefined,
  endpoint: V1Endpoint,
): V1FinishReasonForProtocol<V1ProtocolForEndpoint<V1Endpoint>> | undefined {
  if (!finishReason) return undefined;
  if (endpoint === "messages") {
    return normalizeAnthropicFinishReason(finishReason) as never;
  }
  return normalizeOpenAIFinishReason(finishReason) as never;
}

function normalizeOpenAIFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
    case "function_call":
      return reason;
    case "MAX_TOKENS":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    case "STOP":
      return "stop";
    default:
      return reason;
  }
}

function normalizeAnthropicFinishReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "tool_use":
    case "pause_turn":
      return reason;
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return reason;
  }
}

export function isRetryableAttemptError(error: ProviderCompletionError): boolean {
  return error.retryable;
}

export function attemptErrorCodeFromProvider(error: ProviderCompletionError): V1AttemptErrorCode {
  return error.code;
}