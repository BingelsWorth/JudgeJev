import { describe, expect, it, vi } from "vitest";
import { callJevJudge } from "../src/jev-client.js";
import type { RetryOptions } from "../src/providers/errors.js";
import { v1JevRequest, v1JevResponse } from "./fixtures/contracts.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const noRetry: RetryOptions = { maxAttempts: 1, sleep: async () => {} };

describe("callJevJudge", () => {
  it("posts the type-safe V1JevRequest payload as-is and returns the parsed winner", async () => {
    const fetchImpl = mockFetch(200, v1JevResponse);

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
      apiKey: "jev-key",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.response.winnerCandidateId).toBe(v1JevRequest.candidates[0].id);
    expect(result.response.endpoint).toBe("responses");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://jev.internal/judge");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jev-key");
    expect(JSON.parse(init.body)).toEqual(v1JevRequest);
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = mockFetch(200, v1JevResponse);

    await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("rejects a winnerCandidateId that was not among the submitted candidates", async () => {
    const fetchImpl = mockFetch(200, { ...v1JevResponse, winnerCandidateId: "not-a-real-candidate" });

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.status).toBe(502);
  });

  it("rejects a response body missing winnerCandidateId", async () => {
    const fetchImpl = mockFetch(200, { requestId: v1JevRequest.requestId, endpoint: "responses" });

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/winnerCandidateId/);
  });

  it("rejects a non-JSON response body", async () => {
    const fetchImpl = mockFetch(200, "not json");

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
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
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    // Always reports 502 regardless of the judge endpoint's own status - JudgeJev is
    // the gateway, so client-facing codes describe its contract, not a dependency's.
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe("judge is overloaded");
  });

  it("retries a transient endpoint failure before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(v1JevResponse), { status: 200 })) as unknown as typeof fetch;

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
      retry: { maxAttempts: 2, sleep: async () => {} },
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an authentication failure", async () => {
    const fetchImpl = mockFetch(401, { error: { message: "bad jev api key" } });

    const result = await callJevJudge(v1JevRequest, {
      endpoint: "https://jev.internal/judge",
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
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.retryable).toBe(true);
  });

  it("rejects before making a request when there are no candidates", async () => {
    const fetchImpl = mockFetch(200, v1JevResponse);

    const result = await callJevJudge({ ...v1JevRequest, candidates: [] }, {
      endpoint: "https://jev.internal/judge",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
