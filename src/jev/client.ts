import { isAbortError, readUpstreamError, retryWithBackoff, UpstreamError, type RetryOptions } from "../providers/errors.js";
import type { V1Endpoint, V1Error, V1JevRequest, V1JevResponse } from "../v1/contracts.js";

/**
 * There is no standalone Jev judging service yet. "The actual Jev endpoint" is,
 * for now, a plain OpenAI-compatible chat completions server (e.g. a local vLLM
 * box) prompted to act as the judge. This client builds that prompt from the
 * type-safe V1JevRequest, sends it, and decodes the model's JSON verdict back
 * into a V1JevResponse. Swapping in a purpose-built Jev service later only
 * requires changing this module - the V1JevRequest/V1JevResponse contract at
 * the call site does not change.
 *
 * Reasoning models (e.g. Qwen3 on vLLM) emit a <think>...</think> block before
 * answering, and that reasoning is genuinely useful for judgment quality - it
 * should not be disabled. The performance problem is a non-streaming call has
 * to wait for the *entire* completion, think block included, before returning
 * anything. So this client requests a streamed completion internally (an
 * implementation detail; the downstream JudgeJev API this call sits behind
 * still emits no streaming events) and cuts the connection the moment a
 * syntactically complete, parseable verdict appears after </think> - the full
 * reasoning budget stays available, but a fast answer doesn't wait for the
 * server-side max_tokens ceiling to be reached.
 */
export interface JevClientOptions {
  /** Base URL of an OpenAI-compatible chat completions server, e.g. "http://host:8000/v1". */
  endpoint: string;
  /** Model name to prompt as the judge on that server. */
  model: string;
  apiKey?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
  /**
   * Safety ceiling on completion tokens, in case the model never produces a
   * parseable verdict. Streaming lets us stop as soon as one appears, so in
   * the common case this budget is not actually spent.
   */
  maxTokens?: number;
}

export type JevJudgeResult<E extends V1Endpoint> =
  | { ok: true; response: V1JevResponse<E> }
  | { ok: false; error: V1Error };

export async function callJevJudge<E extends V1Endpoint>(
  request: V1JevRequest<E>,
  options: JevClientOptions,
): Promise<JevJudgeResult<E>> {
  const { endpoint, model, apiKey, retry, fetch = globalThis.fetch, maxTokens = 4000 } = options;

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
    max_tokens: maxTokens,
    stream: true,
    messages: buildJudgePromptMessages(request),
  });

  let content: string;
  try {
    content = await retryWithBackoff(() => requestJudgeVerdict(url, headers, body, fetch), retry);
  } catch (error) {
    return { ok: false, error: toJevError(error) };
  }

  return decodeVerdict(content, request);
}

async function requestJudgeVerdict(
  url: string,
  headers: Record<string, string>,
  body: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, { method: "POST", headers, body });
  if (!response.ok) throw await readUpstreamError(response);

  const reader = response.body?.getReader();
  if (!reader) {
    // No streamable body (e.g. a server that ignores `stream: true`) - fall back
    // to reading it as a single JSON completion.
    const json: unknown = await response.json();
    return extractMessageContent(json) ?? "";
  }

  const decoder = new TextDecoder();
  let lineBuffer = "";
  let content = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]") return content;

        const delta = extractDeltaContent(payload);
        if (delta) {
          content += delta;
          if (hasCompleteVerdict(content)) {
            await reader.cancel().catch(() => {});
            return content;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return content;
}

function extractDeltaContent(ssePayload: string): string | undefined {
  try {
    const parsed = JSON.parse(ssePayload);
    const delta = parsed?.choices?.[0]?.delta?.content;
    return typeof delta === "string" ? delta : undefined;
  } catch {
    return undefined;
  }
}

/** The portion of the streamed content after the last </think>, or all of it if there was none. */
function activeSegment(content: string): string {
  const closeTag = /<\/think>/gi;
  let lastIndex: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = closeTag.exec(content))) {
    lastIndex = match.index + match[0].length;
  }
  return lastIndex === undefined ? content : content.slice(lastIndex);
}

/** First balanced top-level {...} in text, string-literal aware. Undefined if unterminated. */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (char === "\\") escapeNext = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function hasCompleteVerdict(content: string): boolean {
  const json = extractBalancedJson(activeSegment(content));
  if (!json) return false;
  try {
    const parsed = JSON.parse(json);
    return Boolean(parsed && typeof parsed === "object" && typeof parsed.winnerCandidateId === "string");
  } catch {
    return false;
  }
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
    "You may reason first. Once you're done, respond with strict JSON, matching exactly this shape, and nothing after it:",
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
  const segment = activeSegment(content);
  const attempts = [segment.trim(), content.trim()];
  const balanced = extractBalancedJson(segment) ?? extractBalancedJson(content);
  if (balanced) attempts.unshift(balanced);

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
