import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { V1Error } from "../src/v1/contracts.js";

const mockInvoke = vi.fn();
const mockBuildJevGraph = vi.fn(() => ({ invoke: mockInvoke }));

vi.mock("../src/graph/jev-graph.js", () => ({
  buildJevGraph: mockBuildJevGraph,
}));

vi.mock("../src/providers/factory.js", () => ({
  buildModel: vi.fn(),
  configFromRoute: vi.fn(),
}));

const { createV1Router } = await import("../src/api/v1.js");

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

    it("returns 502 when no viable candidates", async () => {
      mockInvoke.mockResolvedValue({ winner: null });
      const app = createTestApp(createMockEnv());
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", input: "test" }),
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