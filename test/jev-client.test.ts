import { describe, expect, it, vi } from "vitest";
import { buildJudgePromptMessages, callJevJudge } from "../src/jev/client.js";
import type { RetryOptions } from "../src/providers/errors.js";
import { v1JevRequest } from "./fixtures/v1-contracts.js";

const encoder = new TextEncoder();

function sseChunk(content: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
}

const doneChunk = encoder.encode("data: [DONE]\n\n");

/**
 * A streaming Response whose body yields one SSE chunk per pull(), so the
 * reader's real read-loop drives progress one delta at a time - this lets
 * tests prove early cancellation actually stops before the stream ends,
 * rather than everything being buffered up front.
 */
function streamResponse(
  deltas: string[],
  options: { status?: number; onCancel?: () => void; appendDone?: boolean } = {},
): Response {
  const { status = 200, onCancel, appendDone = true } = options;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < deltas.length) {
        controller.enqueue(sseChunk(deltas[index]));
        index++;
        return;
      }
      if (appendDone) controller.enqueue(doneChunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

function mockFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function nonStreamJsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noRetry: RetryOptions = { maxAttempts: 1, sleep: async () => {} };
const winnerId = v1JevRequest.candidates[0].id;

describe("buildJudgePromptMessages", () => {
  it("includes the rubric questions and every candidate id/content", () => {
    const messages = buildJudgePromptMessages(v1JevRequest);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("correctness");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain(winnerId);
    expect(messages[1].content).toContain(v1JevRequest.candidates[0].content);
  });
});

describe("callJevJudge", () => {
  it("requests a streamed completion and decodes the verdict once it fully arrives", async () => {
    const response = streamResponse([
      "Sure, let me think.\n",
      `{"winnerCandidateId": "${winnerId}", `,
      `"notes": ["best fit"]}`,
    ]);
    const fetchImpl = mockFetch(response);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.response.winnerCandidateId).toBe(winnerId);
    expect(result.response.notes).toEqual(["best fit"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://192.168.2.106:8000/v1/chat/completions");
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe("Qwen/Qwen3-1.7B");
    expect(sentBody.stream).toBe(true);
    // Thinking is never disabled - it's genuinely useful for judgment quality.
    expect(sentBody.chat_template_kwargs).toBeUndefined();
  });

  it("keeps reasoning content before </think> and decodes the verdict that follows it", async () => {
    const response = streamResponse([
      "<think>\nLet me weigh both candidates carefully",
      " and consider the rubric in detail.\n</think>\n\n",
      `{"winnerCandidateId": "${winnerId}", "notes": ["reasoned through it"]}`,
    ]);
    const fetchImpl = mockFetch(response);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.response.winnerCandidateId).toBe(winnerId);
  });

  it("cancels the stream as soon as a complete verdict appears, without waiting for [DONE]", async () => {
    const onCancel = vi.fn();
    const response = streamResponse(
      [
        "<think>reasoning</think>\n",
        `{"winnerCandidateId": "${winnerId}"}`,
        "this extra chunk should never be pulled",
      ],
      { onCancel },
    );
    const fetchImpl = mockFetch(response);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to reading a non-streamed JSON body if the response has no stream", async () => {
    const body = {
      choices: [{ message: { role: "assistant", content: `{"winnerCandidateId": "${winnerId}"}` } }],
    };
    // Response bodies constructed from a plain string still expose a ReadableStream in
    // most environments, so simulate a body-less response directly to exercise the
    // non-streaming fallback path.
    const fakeResponse = {
      ok: true,
      status: 200,
      body: null,
      json: async () => body,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => fakeResponse) as unknown as typeof fetch;

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.response.winnerCandidateId).toBe(winnerId);
  });

  it("falls back to whatever content streamed if no complete verdict ever appears, then fails to decode it", async () => {
    const response = streamResponse(["<think>still thinking, never finishes cleanly"]);
    const fetchImpl = mockFetch(response);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/decodable JSON verdict/);
  });

  it("rejects a winnerCandidateId that was not among the submitted candidates", async () => {
    const response = streamResponse([`{"winnerCandidateId": "not-a-real-candidate"}`]);
    const fetchImpl = mockFetch(response);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.status).toBe(502);
  });

  it("maps a non-2xx endpoint error to a judge_error", async () => {
    const fetchImpl = mockFetch(nonStreamJsonResponse(500, { error: { message: "judge is overloaded" } }));

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe("judge is overloaded");
  });

  it("retries a transient endpoint failure before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(nonStreamJsonResponse(503, { error: { message: "temporarily unavailable" } }))
      .mockResolvedValueOnce(streamResponse([`{"winnerCandidateId": "${winnerId}"}`])) as unknown as typeof fetch;

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: { maxAttempts: 2, sleep: async () => {} },
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an authentication failure", async () => {
    const fetchImpl = mockFetch(nonStreamJsonResponse(401, { error: { message: "bad jev api key" } }));

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: { maxAttempts: 3, sleep: async () => {} },
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to a retryable judge_error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.retryable).toBe(true);
  });

  it("rejects before making a request when there are no candidates", async () => {
    const fetchImpl = mockFetch(streamResponse(["{}"]));

    const result = await callJevJudge({ ...v1JevRequest, candidates: [] }, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a caller-supplied maxTokens as the safety ceiling", async () => {
    const fetchImpl = mockFetch(streamResponse([`{"winnerCandidateId": "${winnerId}"}`]));

    await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      maxTokens: 8000,
      retry: noRetry,
      fetch: fetchImpl,
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body).max_tokens).toBe(8000);
  });
});
