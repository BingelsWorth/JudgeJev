import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createV1Router } from "../src/api/proxy.js";

/**
 * Full v1 plumbing, no mocked graph or provider layer: a real request runs
 * through the proxy -> concurrent provider fan-out (alongside rubric
 * selection) -> Jev judging call, against a fake global fetch standing in for
 * both the provider box and the separate, typesafe Jev endpoint (which now
 * fields two kinds of calls: picking a rubric, and judging candidates against
 * it). This is the only test that exercises the real wiring between those
 * pieces rather than a mocked graph.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function openAIChatCompletion(model: string, content: string) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    created: 1720000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function jevRubricVerdict(rubricId: string) {
  return {
    model: "jev-1.13.0",
    answers: { rubric: { type: "choice", choice: rubricId, confidence: 0.95 } },
    usage: { input_tokens: 80, output_tokens: 8 },
  };
}

function jevJudgeVerdict(choice: string) {
  return {
    model: "jev-1.13.0",
    answers: { winner: { type: "choice", choice, confidence: 0.88, probabilities: { [choice]: 0.88 } } },
    usage: { input_tokens: 200, output_tokens: 15 },
  };
}

/** Distinguishes the two Jev call shapes by which question they ask. */
function isRubricSelectionBody(body: any): boolean {
  return Boolean(body?.questions?.rubric);
}

const env = {
  JEV_API_KEY: "jev-key",
  JEV_API_ENDPOINT: "https://fake-jev.test/judge",
};

const FAKE_OPENAI_ENDPOINT = "https://fake-openai.test/v1";

function createApp() {
  const app = new Hono<{ Bindings: typeof env }>();
  app.route("/", createV1Router());
  return app;
}

describe("v1 end-to-end plumbing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fans out to every registered route, waits for all attempts, then returns Jev's chosen winner unchanged", async () => {
    const calls: Array<{ url: string; kind: "provider" | "jev-rubric" | "jev-judge" }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (url.startsWith("https://fake-openai.test/")) {
        calls.push({ url, kind: "provider" });
        const content = body.model === "model-a" ? "candidate A: a short fix" : "candidate B: a thorough, well-explained fix";
        return jsonResponse(openAIChatCompletion(body.model, content));
      }

      if (url.startsWith("https://fake-jev.test/") && isRubricSelectionBody(body)) {
        calls.push({ url, kind: "jev-rubric" });
        return jsonResponse(jevRubricVerdict("coding"));
      }

      if (url.startsWith("https://fake-jev.test/")) {
        calls.push({ url, kind: "jev-judge" });
        // The local longest-content bypass heuristic would pick worker-1 (candidate B,
        // longer). Have Jev deliberately pick worker-0 (the shorter one) instead, so this
        // test actually proves Jev's own decision - not the bypass - drives the response,
        // rather than the two coincidentally agreeing.
        return jsonResponse(jevJudgeVerdict("worker-0"));
      }

      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = createApp();
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "Fix this off-by-one bug." }],
          modelConfigs: [
            { name: "worker-a", provider: "openai", model: "model-a", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 } },
            { name: "worker-b", provider: "openai", model: "model-b", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 } },
          ],
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("candidate A: a short fix");
    expect(json.stream).toBeUndefined();

    // Rubric selection is a real, separate Jev call, and the judge call carries the
    // rubric it picked.
    expect(calls.filter((c) => c.kind === "jev-rubric")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "jev-judge")).toHaveLength(1);

    // Both provider attempts must complete before the *judging* call fires - rubric
    // selection is allowed (expected) to fire concurrently with the fan-out.
    const judgeCallIndex = calls.findIndex((c) => c.kind === "jev-judge");
    const providerCallIndexes = calls.map((c, index) => (c.kind === "provider" ? index : -1)).filter((i) => i >= 0);
    expect(providerCallIndexes).toHaveLength(2);
    expect(judgeCallIndex).toBeGreaterThan(Math.max(...providerCallIndexes));

    // Each fanned-out model must receive the caller's actual message, not the
    // JSON-encoded request envelope wrapping it.
    for (const index of providerCallIndexes) {
      const providerBody = JSON.parse(String(fetchImpl.mock.calls[index][1]?.body));
      expect(providerBody.messages).toEqual([{ role: "user", content: "Fix this off-by-one bug." }]);
    }

    // Prove the judge call carries both candidates and the selected rubric as a
    // TypeSafe "choice" question, not just a lightweight prompt.
    const judgeInit = fetchImpl.mock.calls[judgeCallIndex][1] as RequestInit;
    const judgeRequest = JSON.parse(String(judgeInit.body));
    expect(judgeRequest.state.candidates).toHaveLength(2);
    expect(judgeRequest.questions.winner.type).toBe("choice");
    expect(Object.keys(judgeRequest.questions.winner.criteria)).toEqual(["worker-0", "worker-1"]);

    // The rubric call itself offers every registered rubric as an option.
    const rubricCallIndex = calls.findIndex((c) => c.kind === "jev-rubric");
    const rubricInit = fetchImpl.mock.calls[rubricCallIndex][1] as RequestInit;
    const rubricRequest = JSON.parse(String(rubricInit.body));
    expect(rubricRequest.questions.rubric.criteria).toHaveProperty("general");
    expect(rubricRequest.questions.rubric.criteria).toHaveProperty("coding");
  });

  it("still calls Jev with the surviving candidate when one provider attempt fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (url.startsWith("https://fake-openai.test/") && body.model === "model-a") {
        // A persistent (non-retryable) failure keeps this test fast and deterministic.
        return jsonResponse({ error: { message: "model not found", code: "model_not_found" } }, 404);
      }
      if (url.startsWith("https://fake-openai.test/")) {
        return jsonResponse(openAIChatCompletion(body.model, "candidate B: the only survivor"));
      }
      if (url.startsWith("https://fake-jev.test/") && isRubricSelectionBody(body)) {
        return jsonResponse(jevRubricVerdict("general"));
      }
      if (url.startsWith("https://fake-jev.test/")) {
        return jsonResponse(jevJudgeVerdict("worker-1"));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = createApp();
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "Fix this off-by-one bug." }],
          modelConfigs: [
            { name: "worker-a", provider: "openai", model: "model-a", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 }, priority: 0 },
            { name: "worker-b", provider: "openai", model: "model-b", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 } },
          ],
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.choices[0].message.content).toBe("candidate B: the only survivor");
  });

  it("returns no_viable_candidates and never calls Jev to judge (though rubric selection still fires speculatively) when every provider attempt fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://fake-openai.test/")) {
        return jsonResponse({ error: { message: "model not found", code: "model_not_found" } }, 404);
      }
      if (url.startsWith("https://fake-jev.test/")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (isRubricSelectionBody(body)) return jsonResponse(jevRubricVerdict("general"));
        throw new Error("judge should never be called when there are no candidates");
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = createApp();
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fast",
          messages: [{ role: "user", content: "Fix this off-by-one bug." }],
          modelConfigs: [{ name: "worker-a", provider: "openai", model: "model-a", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 } }],
        }),
      },
      env,
    );

    expect(res.status).toBe(502);
    const json: any = await res.json();
    expect(json.error.code).toBe("no_viable_candidates");
  });

  it("/v1/completions hits the provider's raw /completions endpoint, not /chat/completions, and forwards stop/max_tokens", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (url === `${FAKE_OPENAI_ENDPOINT}/completions`) {
        return jsonResponse({
          id: "cmpl-1",
          object: "text_completion",
          created: 1720000000,
          model: body.model,
          choices: [{ text: "    return a + b\n", index: 0, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        });
      }

      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const app = createApp();
    const res = await app.request(
      "/v1/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fast",
          prompt: "def add(a, b):\n",
          max_tokens: 128,
          stop: ["\ndef", "\nclass"],
          modelConfigs: [
            { name: "worker-a", provider: "openai", model: "model-a", endpoint: FAKE_OPENAI_ENDPOINT, apiKey: "test-key", fanout: { fast: 1 } },
          ],
        }),
      },
      { JEV_API_KEY: undefined },
    );

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.object).toBe("text_completion");
    expect(json.choices[0].text).toBe("    return a + b\n");

    // Never wrapped into a chat message, and never sent to /chat/completions.
    expect(fetchImpl.mock.calls.some(([reqUrl]) => String(reqUrl).endsWith("/chat/completions"))).toBe(false);
    const [, init] = fetchImpl.mock.calls[0];
    const providerBody = JSON.parse(String(init?.body));
    expect(providerBody.prompt).toBe("def add(a, b):\n");
    expect(providerBody.messages).toBeUndefined();
    expect(providerBody.max_tokens).toBe(128);
    expect(providerBody.stop).toEqual(["\ndef", "\nclass"]);
  });
});
