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
  return {
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GEMINI_API_KEY: "test-gemini-key",
    ...overrides,
  };
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
        JEV_API_ENDPOINT: "https://jev.internal/judge",
        ...overrides,
      });
    }

    function jevJsonResponse(body: unknown): Response {
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
        vi.fn(async () => jevJsonResponse({ winnerCandidateId: "worker-0" })),
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

    it("does not call Jev when JEV_API_ENDPOINT is not configured", async () => {
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
  });

  describe("Error handling", () => {
    it("returns authentication error for missing API key", async () => {
      mockInvoke.mockRejectedValue(new Error("No API key configured for provider: openai"));
      const app = createTestApp({ OPENAI_API_KEY: undefined });
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