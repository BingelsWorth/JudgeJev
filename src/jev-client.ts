import { fetchOk, isAbortError, UpstreamError, type RetryOptions } from "./providers/errors.js";
import type { V1Endpoint, V1Error, V1JevRequest, V1JevResponse } from "./contracts.js";

/**
 * Client for the actual Jev judging endpoint. JudgeJev is an LLM fan-out proxy:
 * it fans a request out to every configured provider/model, then hands the
 * type-safe V1JevRequest (original request + every candidate + the rubric) to
 * Jev - TypeSafe's decision model (https://docs.typesafe.ai), a fixed public
 * API, not an LLM we prompt ourselves and not one of the models in our own
 * fan-out/model list. This client adapts V1JevRequest into a single TypeSafe
 * "choice" question (candidates as the options) and decodes its answer back
 * into a V1JevResponse.
 */

/** TypeSafe's API is at a fixed, well-known address - not something each deployment configures. */
const TYPESAFE_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

export interface JevClientOptions {
  /** Overrides the default TypeSafe endpoint - mainly for tests/mocks. */
  endpoint?: string;
  apiKey?: string;
  /** Jev model version to use. Defaults to "jev-latest" (TypeSafe's recommended default). */
  model?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export type JevJudgeResult<E extends V1Endpoint> =
  | { ok: true; response: V1JevResponse<E> }
  | { ok: false; error: V1Error };

interface TypesafeChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface TypesafeResponse {
  model?: string;
  answers?: { winner?: TypesafeChoiceAnswer };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function callJevJudge<E extends V1Endpoint>(
  request: V1JevRequest<E>,
  options: JevClientOptions,
): Promise<JevJudgeResult<E>> {
  const {
    endpoint = TYPESAFE_API_ENDPOINT,
    apiKey,
    model = DEFAULT_MODEL,
    retry,
    fetch = globalThis.fetch,
  } = options;

  if (request.candidates.length === 0) {
    return {
      ok: false,
      error: { code: "judge_error", message: "No candidates were submitted for judging", status: 502 },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = JSON.stringify(buildTypesafeRequest(request, model));

  let response: Response;
  try {
    response = await fetchOk(() => fetch(endpoint, { method: "POST", headers, body }), retry);
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

  return decodeVerdict(parsed as TypesafeResponse, request);
}

/**
 * Adapts our internal V1JevRequest into a single TypeSafe "choice" question:
 * the candidates become the options (their content lives in `state`, per
 * TypeSafe's own guidance to keep judged material in state and the question
 * itself free of it), and the rubric becomes the instructions.
 */
function buildTypesafeRequest<E extends V1Endpoint>(request: V1JevRequest<E>, model: string) {
  const criteria: Record<string, null> = {};
  for (const candidate of request.candidates) criteria[candidate.id] = null;

  return {
    model,
    state: {
      original_request: request.request,
      candidates: request.candidates.map((candidate) => ({ id: candidate.id, content: candidate.content })),
    },
    questions: {
      winner: {
        type: "choice",
        instructions: buildInstructions(request.rubric),
        criteria,
      },
    },
  };
}

function buildInstructions<E extends V1Endpoint>(rubric: V1JevRequest<E>["rubric"]): string {
  const questionLines = rubric.questions.map((question) => `- ${question.id}: ${question.prompt}`).join("\n");
  return [
    rubric.instruction,
    "",
    "Weigh these questions when comparing candidates:",
    questionLines,
    "",
    'Select the id (from "candidates" in the state) of the single best overall candidate.',
  ].join("\n");
}

function decodeVerdict<E extends V1Endpoint>(
  parsed: TypesafeResponse,
  request: V1JevRequest<E>,
): JevJudgeResult<E> {
  const answer = parsed?.answers?.winner;
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string" || !answer.choice.trim()) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev response missing a decodable winner choice", status: 502 },
    };
  }

  const winnerCandidateId = answer.choice;
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

  const response: V1JevResponse<E> = {
    requestId: request.requestId,
    endpoint: request.endpoint,
    winnerCandidateId,
    metadata: {
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      jevModel: parsed.model,
      usage: parsed.usage,
    },
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
