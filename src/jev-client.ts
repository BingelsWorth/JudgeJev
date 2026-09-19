import { fetchOk, isAbortError, UpstreamError, type RetryOptions } from "./providers/errors.js";
import type { V1Endpoint, V1Error, V1JevRequest, V1JevResponse } from "./contracts.js";

/**
 * Client for the actual Jev judging endpoint. JudgeJev is an LLM fan-out proxy:
 * it fans a request out to every configured provider/model, then hands the
 * type-safe V1JevRequest (original request + every candidate + the rubric) to
 * Jev, a separate typesafe judging service - not an LLM we prompt ourselves,
 * and not one of the models in our own fan-out/model list. Jev decides which
 * candidate wins and this client just posts the request and decodes its
 * V1JevResponse.
 */
export interface JevClientOptions {
  /** Base URL of the Jev judging API. */
  endpoint: string;
  apiKey?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export type JevJudgeResult<E extends V1Endpoint> =
  | { ok: true; response: V1JevResponse<E> }
  | { ok: false; error: V1Error };

export async function callJevJudge<E extends V1Endpoint>(
  request: V1JevRequest<E>,
  options: JevClientOptions,
): Promise<JevJudgeResult<E>> {
  const { endpoint, apiKey, retry, fetch = globalThis.fetch } = options;

  if (request.candidates.length === 0) {
    return {
      ok: false,
      error: { code: "judge_error", message: "No candidates were submitted for judging", status: 502 },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetchOk(
      () => fetch(endpoint, { method: "POST", headers, body: JSON.stringify(request) }),
      retry,
    );
  } catch (error) {
    return { ok: false, error: toJevError(error) };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev endpoint returned a non-JSON response", status: 502 },
    };
  }

  return decodeVerdict(parsed, request);
}

function decodeVerdict<E extends V1Endpoint>(
  parsed: unknown,
  request: V1JevRequest<E>,
): JevJudgeResult<E> {
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev response was not a JSON object", status: 502 },
    };
  }

  const body = parsed as Record<string, unknown>;
  const winnerCandidateId = body.winnerCandidateId;
  if (typeof winnerCandidateId !== "string" || !winnerCandidateId.trim()) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev response missing winnerCandidateId", status: 502 },
    };
  }

  const matchesKnownCandidate = request.candidates.some((candidate) => candidate.id === winnerCandidateId);
  if (!matchesKnownCandidate) {
    return {
      ok: false,
      error: {
        code: "judge_error",
        message: `Jev selected an unknown candidate id: ${winnerCandidateId}`,
        status: 502,
      },
    };
  }

  const notes = Array.isArray(body.notes)
    ? body.notes.filter((note): note is string => typeof note === "string")
    : undefined;
  const metadata = body.metadata && typeof body.metadata === "object"
    ? (body.metadata as Record<string, unknown>)
    : undefined;

  const response: V1JevResponse<E> = {
    requestId: typeof body.requestId === "string" ? body.requestId : request.requestId,
    endpoint: request.endpoint,
    winnerCandidateId,
    notes,
    metadata,
  };

  return { ok: true, response };
}

function toJevError(error: unknown): V1Error {
  // Always report 502 (Bad Gateway) rather than passing the judge endpoint's raw
  // status through: JudgeJev is the gateway here, and a client-facing 4xx/5xx
  // should describe JudgeJev's own contract, not an internal dependency's.
  if (isAbortError(error)) {
    return { code: "judge_error", message: "Jev judging request timed out", status: 502, retryable: true };
  }
  if (error instanceof UpstreamError) {
    return {
      code: "judge_error",
      message: error.message,
      status: 502,
      retryable: error.retryable,
    };
  }
  return {
    code: "judge_error",
    message: error instanceof Error ? error.message : "Jev judging request failed",
    status: 502,
    retryable: true,
  };
}
