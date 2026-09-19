import { describe, expect, it, vi } from "vitest";
import { callJevJudge, selectRubric } from "../src/jev-client.js";
import type { RetryOptions } from "../src/providers/errors.js";
import { v1JevRequest } from "./fixtures/contracts.js";
import { RUBRICS, listRubrics } from "../src/rubrics.js";

function typesafeResponse(choice: string, extra: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      winner: {
        type: "choice",
        choice,
        confidence: 0.92,
        probabilities: { [choice]: 0.92 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
    ...extra,
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

describe("callJevJudge", () => {
  it("posts a TypeSafe choice question built from the candidates and rubric, to the fixed endpoint by default", async () => {
    const fetchImpl = mockFetch(200, typesafeResponse(winnerId));

    const result = await callJevJudge(v1JevRequest, {
      apiKey: "jev-key",
      retry: noRetry,
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.response.winnerCandidateId).toBe(winnerId);
    expect(result.response.metadata?.confidence).toBe(0.92);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jev-key");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("jev-latest");
    expect(body.state.candidates).toEqual(
      v1JevRequest.candidates.map((c) => ({ id: c.id, content: c.content })),
    );
    expect(body.questions.winner.type).toBe("choice");
    expect(Object.keys(body.questions.winner.criteria)).toEqual(
      v1JevRequest.candidates.map((c) => c.id),
    );
  });

  it("uses a caller-supplied endpoint and model instead of the defaults", async () => {
    const fetchImpl = mockFetch(200, typesafeResponse(winnerId));

    await callJevJudge(v1JevRequest, {
      endpoint: "https://mock.test/systemone",
      model: "jev-preview",
      retry: noRetry,
      fetch: fetchImpl,
    });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://mock.test/systemone");
    expect(JSON.parse(init.body).model).toBe("jev-preview");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = mockFetch(200, typesafeResponse(winnerId));

    await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("rejects a winner choice that was not among the submitted candidates", async () => {
    const fetchImpl = mockFetch(200, typesafeResponse("not-a-real-candidate"));

    const result = await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.status).toBe(502);
  });

  it("rejects a response with no winner answer", async () => {
    const fetchImpl = mockFetch(200, { model: "jev-1.13.0", answers: {}, usage: {} });

    const result = await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/decodable winner choice/);
  });

  it("rejects a non-JSON response body", async () => {
    const fetchImpl = mockFetch(200, "not json");

    const result = await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/non-JSON/);
  });

  it("maps a non-2xx endpoint error to a judge_error", async () => {
    const fetchImpl = mockFetch(401, { detail: "Missing or invalid API key" });

    const result = await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    // Always reports 502 regardless of the judge endpoint's own status - JudgeJev is
    // the gateway, so client-facing codes describe its contract, not a dependency's.
    expect(result.error.status).toBe(502);
  });

  it("retries a 529 (TypeSafe's overloaded status) before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "overloaded" }), { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(typesafeResponse(winnerId)), { status: 200 })) as unknown as typeof fetch;

    const result = await callJevJudge(v1JevRequest, {
      retry: { maxAttempts: 2, sleep: async () => {} },
      fetch: fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = mockFetch(401, { detail: "Missing or invalid API key" });

    const result = await callJevJudge(v1JevRequest, {
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

    const result = await callJevJudge(v1JevRequest, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.retryable).toBe(true);
  });

  it("rejects before making a request when there are no candidates", async () => {
    const fetchImpl = mockFetch(200, typesafeResponse(winnerId));

    const result = await callJevJudge({ ...v1JevRequest, candidates: [] }, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function typesafeRubricResponse(rubricId: string) {
  return {
    model: "jev-1.13.0",
    answers: { rubric: { type: "choice", choice: rubricId, confidence: 0.81 } },
    usage: { input_tokens: 40, output_tokens: 6 },
  };
}

describe("selectRubric", () => {
  const request = v1JevRequest.request;
  const rubrics = listRubrics();

  it("posts every rubric as a choice option, keyed by id, and returns the one Jev picks", async () => {
    const fetchImpl = mockFetch(200, typesafeRubricResponse("coding-v1"));

    const result = await selectRubric(request, rubrics, { apiKey: "jev-key", retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.rubricId).toBe("coding-v1");
    expect(result.confidence).toBe(0.81);

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init.body);
    expect(body.questions.rubric.type).toBe("choice");
    expect(body.questions.rubric.criteria).toEqual(
      Object.fromEntries(rubrics.map((r) => [r.id, r.description])),
    );
    expect(body.state.request).toEqual(request);
  });

  it("rejects a rubric choice that was not among the offered rubrics", async () => {
    const fetchImpl = mockFetch(200, typesafeRubricResponse("not-a-real-rubric"));

    const result = await selectRubric(request, rubrics, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
  });

  it("rejects a response with no rubric answer", async () => {
    const fetchImpl = mockFetch(200, { model: "jev-1.13.0", answers: {}, usage: {} });

    const result = await selectRubric(request, rubrics, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.message).toMatch(/decodable rubric choice/);
  });

  it("rejects before making a request when no rubrics are offered", async () => {
    const fetchImpl = mockFetch(200, typesafeRubricResponse("coding-v1"));

    const result = await selectRubric(request, [], { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx endpoint error to a judge_error", async () => {
    const fetchImpl = mockFetch(500, { detail: "overloaded" });

    const result = await selectRubric(request, rubrics, { retry: noRetry, fetch: fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error.code).toBe("judge_error");
    expect(result.error.status).toBe(502);
  });

  it("offers the real rubric registry by default", () => {
    expect(rubrics.map((r) => r.id)).toEqual(Object.keys(RUBRICS));
  });
});
