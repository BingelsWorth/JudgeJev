import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { V1Error } from "../src/contracts.js";

const mockInvoke = vi.fn();
const mockBuildJevGraph = vi.fn(() => ({ invoke: mockInvoke }));

vi.mock("../src/graph/jev-graph.js", () => ({
  buildJevGraph: mockBuildJevGraph,
}));

vi.mock("../src/providers/factory.js", () => ({
  buildModel: vi.fn(),
  configFromRoute: vi.fn(),
}));

const { createV1Router } = await import("../src/api/proxy.js");

function createTestApp(env: Record<string, string | undefined> = {}) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.route("/", createV1Router());
  return app;
}

function createMockEnv(overrides: Record<string, string | undefined> = {}) {
  return { ...overrides };
}

describe("v1 API endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /v1/responses", () => {
    it("returns 400 for missing model", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "test" }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("returns 400 for missing input", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o" }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("normalizes registered fan-out configuration", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "fast",
          input: "test",
          modelConfigs: [{
            name: "local-qwen",
            provider: "openai",
            model: "qwen3.5-9b",
            endpoint: "http://localhost:8000/v1",
            apiKey: "local-key",
            aliases: [" Alias "],
            fanout: { fast: 2 },
          }],
        }),
      });

      expect(res.status).toBe(502);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      const state = mockInvoke.mock.calls[0][0];
      expect(state.models).toEqual(["fast"]);
      expect(state.modelConfigs).toEqual([{
        name: "local-qwen",
        logicalModel: "local-qwen",
        provider: "openai",
        upstreamModel: "qwen3.5-9b",
        model: "qwen3.5-9b",
        endpoint: "http://localhost:8000/v1",
        apiKey: "local-key",
        aliases: ["Alias"],
        priority: 0,
        enabled: true,
        fanout: { fast: 2 },
      }]);
    });

    it("uses the default route when modelConfigs is explicitly empty", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "fast", input: "test", modelConfigs: [] }),
      });

      expect(res.status).toBe(502);
      const state = mockInvoke.mock.calls[0][0];
      expect(state.models).toEqual(["fast"]);
      expect(state.modelConfigs).toEqual([{
        logicalModel: "fast",
        provider: "openai",
        upstreamModel: "fast",
        priority: 0,
        enabled: true,
      }]);
    });

    it("falls back to MODEL_CONFIGS from the environment when the request supplies no modelConfigs", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const env = createMockEnv({
        MODEL_CONFIGS: JSON.stringify([
          { name: "local-qwen", provider: "openai", model: "Qwen/Qwen3-1.7B", endpoint: "http://192.168.2.106:8000/v1", fanout: { fast: 1 } },
        ]),
      });
      const app = createTestApp(env);
      const res = await app.request(
        "/v1/responses",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "fast", input: "test" }),
        },
        env,
      );

      expect(res.status).toBe(502);
      const state = mockInvoke.mock.calls[0][0];
      expect(state.modelConfigs).toEqual([{
        name: "local-qwen",
        logicalModel: "local-qwen",
        provider: "openai",
        upstreamModel: "Qwen/Qwen3-1.7B",
        model: "Qwen/Qwen3-1.7B",
        endpoint: "http://192.168.2.106:8000/v1",
        priority: 0,
        enabled: true,
        fanout: { fast: 1 },
      }]);
    });

    it("prefers a request-supplied modelConfigs over MODEL_CONFIGS from the environment", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const env = createMockEnv({ MODEL_CONFIGS: JSON.stringify([{ logicalModel: "from-env", provider: "openai" }]) });
      const app = createTestApp(env);
      const res = await app.request(
        "/v1/responses",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "fast",
            input: "test",
            modelConfigs: [{ logicalModel: "from-body", provider: "anthropic", upstreamModel: "claude" }],
          }),
        },
        env,
      );

      expect(res.status).toBe(502);
      const state = mockInvoke.mock.calls[0][0];
      expect(state.modelConfigs).toEqual([{
        logicalModel: "from-body",
        provider: "anthropic",
        upstreamModel: "claude",
        priority: 0,
        enabled: true,
      }]);
    });

    it("returns winner response on success", async () => {
      mockInvoke.mockResolvedValue({
        winner: {
          id: "worker-0",
          model: "gpt-4o",
          upstreamModel: "gpt-4o",
          provider: "openai",
          content: "Test response",
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
      });
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.object).toBe("response");
      expect(json.output[0].content[0].text).toBe("Test response");
      expect(json.usage.inputTokens).toBe(10);
      expect(json.usage.outputTokens).toBe(20);
    });
  });

  describe("POST /v1/chat/completions", () => {
    it("returns 400 for missing model", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("returns 400 for missing messages", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o" }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("returns 502 when no viable candidates", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(502);
      const json: any = await res.json();
      expect(json.error.code).toBe("no_viable_candidates");
    });

    it("returns winner response on success", async () => {
      mockInvoke.mockResolvedValue({
        winner: {
          id: "worker-0",
          model: "gpt-4o",
          upstreamModel: "gpt-4o",
          provider: "openai",
          content: "Test response",
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.object).toBe("chat.completion");
      expect(json.choices[0].message.content).toBe("Test response");
      expect(json.usage.inputTokens).toBe(10);
      expect(json.usage.outputTokens).toBe(20);
    });
  });

  describe("POST /v1/messages", () => {
    it("returns 400 for missing model", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("returns 400 for missing messages", async () => {
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-sonnet" }),
      });
      expect(res.status).toBe(400);
      const json: any = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("returns 502 when no viable candidates", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-sonnet", messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(502);
      const json: any = await res.json();
      expect(json.error.code).toBe("no_viable_candidates");
    });

    it("returns winner response on success", async () => {
      mockInvoke.mockResolvedValue({
        winner: {
          id: "worker-0",
          model: "claude-3-sonnet",
          upstreamModel: "claude-3-sonnet",
          provider: "anthropic",
          content: "Test response",
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-sonnet", messages: [{ role: "user", content: "test" }] }),
      });
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.type).toBe("message");
      expect(json.content[0].text).toBe("Test response");
      expect(json.usage.inputTokens).toBe(10);
      expect(json.usage.outputTokens).toBe(20);
    });
  });

  describe("Jev judging integration", () => {
    const workers = [
      {
        id: "worker-0",
        model: "gpt-4o",
        upstreamModel: "gpt-4o",
        provider: "openai",
        status: "succeeded",
        content: "short answer",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        id: "worker-1",
        model: "gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        provider: "openai",
        status: "succeeded",
        content: "a much longer, more thorough answer",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ];

    function jevEnv(overrides: Record<string, string | undefined> = {}) {
      return createMockEnv({
        JEV_API_KEY: "jev-key",
        ...overrides,
      });
    }

    function jevJsonResponse(choice: string): Response {
      const body = {
        model: "jev-1.13.0",
        answers: { winner: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } },
        usage: { input_tokens: 100, output_tokens: 10 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    function jevRubricResponse(rubricId: string): Response {
      const body = {
        model: "jev-1.13.0",
        answers: { rubric: { type: "choice", choice: rubricId, confidence: 0.9 } },
        usage: { input_tokens: 50, output_tokens: 6 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns the candidate Jev selects, even when it differs from the local heuristic", async () => {
      // The local longest-content heuristic would pick worker-1; have Jev pick worker-0 instead
      // to prove the real judge's decision - not the bypass - drives the response.
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jevJsonResponse("worker-0")),
      );

      const app = createTestApp(jevEnv());
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        jevEnv(),
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toBe("short answer");
    });

    it("falls back to the local heuristic winner when the Jev call fails and JEV_ON_FAILURE is unset", async () => {
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

      const app = createTestApp(jevEnv());
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        jevEnv(),
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toBe("a much longer, more thorough answer");
    });

    it("returns a judge_error when the Jev call fails and JEV_ON_FAILURE=error", async () => {
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

      const env = jevEnv({ JEV_ON_FAILURE: "error" });
      const app = createTestApp(env);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        env,
      );

      expect(res.status).toBe(502);
      const json: any = await res.json();
      expect(json.error.code).toBe("judge_error");
    });

    it("does not call Jev when JEV_API_KEY is not configured", async () => {
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const app = createTestApp(createMockEnv());
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        createMockEnv(),
      );

      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      const json: any = await res.json();
      expect(json.choices[0].message.content).toBe("a much longer, more thorough answer");
    });

    it("uses the rubric Jev selects for the judging call's instructions", async () => {
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      const fetchImpl = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.questions?.rubric) return jevRubricResponse("coding");
        return jevJsonResponse("worker-0");
      });
      vi.stubGlobal("fetch", fetchImpl);

      const app = createTestApp(jevEnv());
      await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        jevEnv(),
      );

      const judgeCall = fetchImpl.mock.calls.find(([, init]) => JSON.parse(String(init?.body ?? "{}")).questions?.winner);
      expect(judgeCall).toBeDefined();
      const judgeBody = JSON.parse(String(judgeCall![1]?.body));
      expect(judgeBody.questions.winner.instructions).toContain("coding request");
    });

    it("falls back to the default rubric, without affecting JEV_ON_FAILURE, when rubric selection itself fails", async () => {
      mockInvoke.mockResolvedValue({ winner: workers[1], workers });
      const fetchImpl = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.questions?.rubric) return new Response("boom", { status: 500 });
        return jevJsonResponse("worker-0");
      });
      vi.stubGlobal("fetch", fetchImpl);

      const env = jevEnv({ JEV_ON_FAILURE: "error" });
      const app = createTestApp(env);
      const res = await app.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }),
        },
        env,
      );

      // Rubric selection failing silently falls back to the default rubric - it never
      // triggers JEV_ON_FAILURE (that only governs the judging call itself), so the
      // judging call still goes ahead and its own success still wins.
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.choices[0].message.content).toBe("short answer");

      const judgeCall = fetchImpl.mock.calls.find(([, init]) => JSON.parse(String(init?.body ?? "{}")).questions?.winner);
      const judgeBody = JSON.parse(String(judgeCall![1]?.body));
      expect(judgeBody.questions.winner.instructions).not.toContain("coding request");
    });
  });

  describe("Error handling", () => {
    it("returns authentication error for missing API key", async () => {
      mockInvoke.mockRejectedValue(new Error("No API key configured for provider: openai"));
      const app = createTestApp();
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
      });
      expect(res.status).toBe(401);
      const json: any = await res.json();
      expect(json.error.code).toBe("authentication_failed");
    });

    it("returns provider error for rate limit", async () => {
      mockInvoke.mockRejectedValue(new Error("Rate limit exceeded 429"));
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
      });
      expect(res.status).toBe(429);
      const json: any = await res.json();
      expect(json.error.code).toBe("provider_error");
      expect(json.error.retryable).toBe(true);
    });

    it("returns provider error for network error", async () => {
      mockInvoke.mockRejectedValue(new Error("Network error ECONNREFUSED"));
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
      });
      expect(res.status).toBe(503);
      const json: any = await res.json();
      expect(json.error.code).toBe("provider_error");
      expect(json.error.retryable).toBe(true);
    });

    it("returns internal error for unknown errors", async () => {
      mockInvoke.mockRejectedValue(new Error("Unknown error"));
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
      });
      expect(res.status).toBe(500);
      const json: any = await res.json();
      expect(json.error.code).toBe("internal_error");
    });
  });
});