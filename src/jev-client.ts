import { fetchOk, isAbortError, UpstreamError, type RetryOptions } from "./providers/errors.js";
import type { V1DownstreamRequest, V1Endpoint, V1Error, V1JevRequest, V1JevResponse, V1Rubric } from "./contracts.js";

/**
 * Client for the actual Jev judging endpoint. JudgeJev is an LLM fan-out proxy:
 * it fans a request out to every configured provider/model, then hands the
 * type-safe V1JevRequest (original request + every candidate + the rubric) to
 * Jev - TypeSafe's decision model (https://docs.typesafe.ai), a fixed public
 * API, not an LLM we prompt ourselves and not one of the models in our own
 * fan-out/model list. This client adapts V1JevRequest into a single TypeSafe
 * "choice" question (candidates as the options) and decodes its answer back
 * into a V1JevResponse. It also exposes `selectRubric`, a separate choice
 * question that has Jev pick which rubric fits a request - meant to run in
 * parallel with the fan-out, so the rubric is already known by the time
 * candidates are ready to judge.
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

export type JevRubricSelectionResult =
  | { ok: true; rubricId: string; confidence?: number }
  | { ok: false; error: V1Error };

interface TypesafeChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface TypesafeResponse {
  model?: string;
  answers?: Record<string, TypesafeChoiceAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface TypesafeChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

async function postTypesafeQuestion(
  state: unknown,
  questions: Record<string, TypesafeChoiceQuestion>,
  options: JevClientOptions,
): Promise<{ ok: true; response: TypesafeResponse } | { ok: false; error: V1Error }> {
  const { endpoint = TYPESAFE_API_ENDPOINT, apiKey, model = DEFAULT_MODEL, retry, fetch = globalThis.fetch } = options;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = JSON.stringify({ model, state, questions });

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

  return { ok: true, response: parsed as TypesafeResponse };
}

export async function callJevJudge<E extends V1Endpoint>(
  request: V1JevRequest<E>,
  options: JevClientOptions,
): Promise<JevJudgeResult<E>> {
  if (request.candidates.length === 0) {
    return {
      ok: false,
      error: { code: "judge_error", message: "No candidates were submitted for judging", status: 502 },
    };
  }

  const criteria: Record<string, null> = {};
  for (const candidate of request.candidates) criteria[candidate.id] = null;

  const state = {
    original_request: request.request,
    candidates: request.candidates.map((candidate) => ({ id: candidate.id, content: candidate.content })),
  };
  const questions = {
    winner: {
      type: "choice" as const,
      instructions: buildJudgeInstructions(request.rubric),
      criteria,
    },
  };

  const outcome = await postTypesafeQuestion(state, questions, options);
  if (!outcome.ok) return outcome;

  return decodeJudgeVerdict(outcome.response, request);
}

function buildJudgeInstructions(rubric: V1Rubric): string {
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

function decodeJudgeVerdict<E extends V1Endpoint>(
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

/**
 * Asks Jev which of the given rubrics best fits the original request - no
 * candidates involved, so this can run concurrently with the fan-out and be
 * ready by the time there's anything to judge.
 */
export async function selectRubric(
  request: V1DownstreamRequest,
  rubrics: readonly V1Rubric[],
  options: JevClientOptions,
): Promise<JevRubricSelectionResult> {
  if (rubrics.length === 0) {
    return {
      ok: false,
      error: { code: "judge_error", message: "No rubrics were offered for selection", status: 502 },
    };
  }

  const criteria: Record<string, string> = {};
  for (const rubric of rubrics) criteria[rubric.id] = rubric.description;

  const state = { request };
  const questions = {
    rubric: {
      type: "choice" as const,
      instructions: 'Pick the rubric (by id, from "criteria" below) best suited to judging responses to this request.',
      criteria,
    },
  };

  const outcome = await postTypesafeQuestion(state, questions, options);
  if (!outcome.ok) return outcome;

  const answer = outcome.response?.answers?.rubric;
  if (!answer || typeof answer !== "object" || typeof answer.choice !== "string" || !answer.choice.trim()) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev response missing a decodable rubric choice", status: 502 },
    };
  }

  const rubricId = answer.choice;
  if (!rubrics.some((rubric) => rubric.id === rubricId)) {
    return {
      ok: false,
      error: { code: "judge_error", message: `Jev selected an unknown rubric id: ${rubricId}`, status: 502 },
    };
  }

  return { ok: true, rubricId, confidence: answer.confidence };
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
