import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createV1Router } from "../src/api/v1.js";

/**
 * Full v1 plumbing, no mocked graph or provider layer: a real request runs
 * through the proxy -> concurrent provider fan-out -> Jev judging call,
 * against a fake global fetch standing in for both the provider box and the
 * (for now, LLM-as-judge) Jev endpoint. This is the only test that exercises
 * the real wiring between those pieces rather than a mocked graph.
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

/** callJevJudge requests `stream: true` - the Jev endpoint mock must actually speak SSE. */
function jevVerdictStream(winnerCandidateId: string, notes: string[] = []): Response {
  const encoder = new TextEncoder();
  const content = JSON.stringify({ winnerCandidateId, notes });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const env = {
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "https://fake-openai.test/v1",
  JEV_API_ENDPOINT: "https://fake-jev.test/v1",
  JEV_MODEL: "judge-model",
};

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
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}"));

      if (url.startsWith("https://fake-openai.test/")) {
        const content = body.model === "model-a" ? "candidate A: a short fix" : "candidate B: a thorough, well-explained fix";
        return jsonResponse(openAIChatCompletion(body.model, content));
      }

      if (url.startsWith("https://fake-jev.test/")) {
        // The local longest-content bypass heuristic would pick worker-1 (candidate B,
        // longer). Have Jev deliberately pick worker-0 (the shorter one) instead, so this
        // test actually proves Jev's own decision - not the bypass - drives the response,
        // rather than the two coincidentally agreeing.
        return jevVerdictStream("worker-0", ["candidate A was more direct and equally correct"]);
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
            { name: "worker-a", provider: "openai", model: "model-a", fanout: { fast: 1 } },
            { name: "worker-b", provider: "openai", model: "model-b", fanout: { fast: 1 } },
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

    // Both provider attempts must complete before the Jev judging call fires.
    const jevCallIndex = calls.findIndex((url) => url.startsWith("https://fake-jev.test/"));
    const providerCallIndexes = calls
      .map((url, index) => (url.startsWith("https://fake-openai.test/") ? index : -1))
      .filter((index) => index >= 0);

    expect(providerCallIndexes).toHaveLength(2);
    expect(jevCallIndex).toBeGreaterThan(Math.max(...providerCallIndexes));

    // Prove the Jev call itself is really the streamed judge contract, not a plain request.
    const jevInit = fetchImpl.mock.calls[jevCallIndex][1] as RequestInit;
    expect(JSON.parse(String(jevInit.body)).stream).toBe(true);
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
      if (url.startsWith("https://fake-jev.test/")) {
        return jevVerdictStream("worker-1");
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
            { name: "worker-a", provider: "openai", model: "model-a", fanout: { fast: 1 }, priority: 0 },
            { name: "worker-b", provider: "openai", model: "model-b", fanout: { fast: 1 } },
          ],
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.choices[0].message.content).toBe("candidate B: the only survivor");
  });

  it("returns no_viable_candidates and never calls Jev when every provider attempt fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://fake-openai.test/")) {
        return jsonResponse({ error: { message: "model not found", code: "model_not_found" } }, 404);
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
          modelConfigs: [{ name: "worker-a", provider: "openai", model: "model-a", fanout: { fast: 1 } }],
        }),
      },
      env,
    );

    expect(res.status).toBe(502);
    const json: any = await res.json();
    expect(json.error.code).toBe("no_viable_candidates");
    expect(fetchImpl.mock.calls.every(([input]) => !String(input).startsWith("https://fake-jev.test/"))).toBe(true);
  });
});
