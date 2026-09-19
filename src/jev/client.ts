import { fetchOk, isAbortError, UpstreamError, type RetryOptions } from "../providers/errors.js";
import type { V1Endpoint, V1Error, V1JevRequest, V1JevResponse } from "../v1/contracts.js";

/**
 * There is no standalone Jev judging service yet. "The actual Jev endpoint" is,
 * for now, a plain OpenAI-compatible chat completions server (e.g. a local vLLM
 * box) prompted to act as the judge. This client builds that prompt from the
 * type-safe V1JevRequest, sends it, and decodes the model's JSON verdict back
 * into a V1JevResponse. Swapping in a purpose-built Jev service later only
 * requires changing this module - the V1JevRequest/V1JevResponse contract at
 * the call site does not change.
 */
export interface JevClientOptions {
  /** Base URL of an OpenAI-compatible chat completions server, e.g. "http://host:8000/v1". */
  endpoint: string;
  /** Model name to prompt as the judge on that server. */
  model: string;
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
  const { endpoint, model, apiKey, retry, fetch = globalThis.fetch } = options;

  if (request.candidates.length === 0) {
    return {
      ok: false,
      error: { code: "judge_error", message: "No candidates were submitted for judging", status: 502 },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 2000,
    messages: buildJudgePromptMessages(request),
    // Reasoning models (e.g. Qwen3 on vLLM) default to emitting a <think>...</think>
    // block before any answer, which can burn the whole token budget before ever
    // reaching the verdict JSON. This is vLLM's documented way to turn that off;
    // servers that don't recognize the field just ignore it.
    chat_template_kwargs: { enable_thinking: false },
  });

  let response: Response;
  try {
    response = await fetchOk(() => fetch(url, { method: "POST", headers, body }), retry);
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

  const content = extractMessageContent(parsed);
  if (content === undefined) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev endpoint response had no message content", status: 502 },
    };
  }

  return decodeVerdict(content, request);
}

export function buildJudgePromptMessages<E extends V1Endpoint>(
  request: V1JevRequest<E>,
): Array<{ role: "system" | "user"; content: string }> {
  const { rubric } = request;
  const questionLines = rubric.questions.map((question) => `- ${question.id}: ${question.prompt}`).join("\n");

  const system = [
    rubric.instruction,
    "",
    "Questions to weigh when comparing candidates:",
    questionLines,
    "",
    "Respond with strict JSON only, no prose, matching exactly this shape:",
    '{"winnerCandidateId": "<one of the candidate ids below>", "notes": ["short justification"]}',
  ].join("\n");

  const candidateBlocks = request.candidates
    .map((candidate) => `### Candidate ${candidate.id}\n${candidate.content}`)
    .join("\n\n");

  const user = [
    "Original request:",
    JSON.stringify(request.request),
    "",
    "Candidates:",
    candidateBlocks,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function extractMessageContent(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function decodeVerdict<E extends V1Endpoint>(
  content: string,
  request: V1JevRequest<E>,
): JevJudgeResult<E> {
  const verdict = parseVerdictJson(content);
  if (!verdict) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev judge did not return a decodable JSON verdict", status: 502 },
    };
  }

  const winnerCandidateId = verdict.winnerCandidateId;
  if (typeof winnerCandidateId !== "string" || !winnerCandidateId.trim()) {
    return {
      ok: false,
      error: { code: "judge_error", message: "Jev verdict missing winnerCandidateId", status: 502 },
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

  const notes = Array.isArray(verdict.notes)
    ? verdict.notes.filter((note): note is string => typeof note === "string")
    : undefined;

  const response: V1JevResponse<E> = {
    requestId: request.requestId,
    endpoint: request.endpoint,
    winnerCandidateId,
    notes,
  };

  return { ok: true, response };
}

function parseVerdictJson(content: string): { winnerCandidateId?: unknown; notes?: unknown } | undefined {
  // Defense-in-depth: strip a leading <think>...</think> reasoning block in case the
  // server ignored (or doesn't support) the enable_thinking:false request above.
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const attempts = [content.trim(), withoutThinking];
  const match = withoutThinking.match(/\{[\s\S]*\}/) ?? content.match(/\{[\s\S]*\}/);
  if (match) attempts.push(match[0]);

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate substring
    }
  }
  return undefined;
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
