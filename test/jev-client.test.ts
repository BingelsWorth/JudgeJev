import { describe, expect, it, vi } from "vitest";
import { buildJudgePromptMessages, callJevJudge } from "../src/jev/client.js";
import type { RetryOptions } from "../src/providers/errors.js";
import { v1JevRequest } from "./fixtures/v1-contracts.js";

function chatCompletion(content: string) {
  return {
    id: "chatcmpl-judge",
    object: "chat.completion",
    created: 1720000000,
    model: "Qwen/Qwen3-1.7B",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
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
  it("prompts the configured model and decodes a JSON verdict", async () => {
    const fetchImpl = mockFetch(200, chatCompletion(JSON.stringify({ winnerCandidateId: winnerId, notes: ["best fit"] })));

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
    expect(sentBody.messages).toHaveLength(2);
  });

  it("strips a trailing slash from the endpoint before appending the path", async () => {
    const fetchImpl = mockFetch(200, chatCompletion(JSON.stringify({ winnerCandidateId: winnerId })));

    await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1/",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://192.168.2.106:8000/v1/chat/completions");
  });

  it("omits the Authorization header when unauthenticated", async () => {
    const fetchImpl = mockFetch(200, chatCompletion(JSON.stringify({ winnerCandidateId: winnerId })));

    await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("recovers a JSON verdict embedded in extra prose", async () => {
    const messy = `Sure thing! Here is my verdict:\n{"winnerCandidateId": "${winnerId}", "notes": ["clean"]}\nHope that helps.`;
    const fetchImpl = mockFetch(200, chatCompletion(messy));

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

  it("rejects a winnerCandidateId that was not among the submitted candidates", async () => {
    const fetchImpl = mockFetch(200, chatCompletion(JSON.stringify({ winnerCandidateId: "not-a-real-candidate" })));

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

  it("rejects a reply with no decodable JSON verdict", async () => {
    const fetchImpl = mockFetch(200, chatCompletion("I like candidate A best, no particular reason."));

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

  it("rejects a response with no message content", async () => {
    const fetchImpl = mockFetch(200, { choices: [] });

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/no message content/);
  });

  it("rejects a non-JSON HTTP response body", async () => {
    const fetchImpl = mockFetch(200, "not json");

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/non-JSON/);
  });

  it("maps a non-2xx endpoint error to a judge_error", async () => {
    const fetchImpl = mockFetch(500, { error: { message: "judge is overloaded" } });

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.message).toBe("judge is overloaded");
  });

  it("retries a transient endpoint failure before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(chatCompletion(JSON.stringify({ winnerCandidateId: winnerId }))), { status: 200 }),
      ) as unknown as typeof fetch;

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
    const fetchImpl = mockFetch(401, { error: { message: "bad jev api key" } });

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
    const fetchImpl = mockFetch(200, chatCompletion("{}"));

    const result = await callJevJudge({ ...v1JevRequest, candidates: [] }, {
      endpoint: "http://192.168.2.106:8000/v1",
      model: "Qwen/Qwen3-1.7B",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
