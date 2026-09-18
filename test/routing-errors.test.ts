import { describe, expect, it, vi } from "vitest";
import { UpstreamError, classifyRetryableFailure, isRetryableError, retryWithBackoff } from "../src/providers/errors.js";
import { defaultModelRoutes, normalizeModelName, resolveModelRoutes, resolveRoutesForState } from "../src/providers/router.js";
import type { ModelRoute } from "../src/providers/router.js";

describe("route resolution", () => {
  it("normalizes model names case-insensitively", () => {
    expect(normalizeModelName("  GPT-4o ")).toBe("gpt-4o");
  });

  it("matches logical model and aliases", () => {
    const routes: ModelRoute[] = [
      { logicalModel: "coder", provider: "openai", upstreamModel: "gpt-4o", aliases: ["gpt4o"] },
      { logicalModel: "writer", provider: "anthropic", upstreamModel: "claude-3-5-sonnet-latest" },
    ];
    expect(resolveModelRoutes("coder", routes)).toHaveLength(1);
    expect(resolveModelRoutes("gpt4o", routes)[0].upstreamModel).toBe("gpt-4o");
    expect(resolveModelRoutes("writer", routes)).toHaveLength(1);
  });

  it("sorts by priority descending", () => {
    const routes: ModelRoute[] = [
      { logicalModel: "coder", provider: "openai", upstreamModel: "gpt-4o", priority: 1 },
      { logicalModel: "coder", provider: "anthropic", upstreamModel: "claude-3-5-sonnet-latest", priority: 5 },
    ];
    const resolved = resolveModelRoutes("coder", routes);
    expect(resolved[0].provider).toBe("anthropic");
    expect(resolved[1].provider).toBe("openai");
  });

  it("skips disabled routes", () => {
    const routes: ModelRoute[] = [
      { logicalModel: "coder", provider: "openai", upstreamModel: "gpt-4o", enabled: false },
      { logicalModel: "coder", provider: "anthropic", upstreamModel: "claude-3-5-sonnet-latest" },
    ];
    expect(resolveModelRoutes("coder", routes)).toHaveLength(1);
  });

  it("returns an empty array when nothing matches", () => {
    expect(
      resolveModelRoutes("missing", [{ logicalModel: "coder", provider: "openai", upstreamModel: "gpt-4o" }]),
    ).toHaveLength(0);
  });

  it("defaults to openai routes for a logical model", () => {
    const routes = defaultModelRoutes(["gpt-4o"]);
    expect(routes[0]).toEqual({
      logicalModel: "gpt-4o",
      provider: "openai",
      upstreamModel: "gpt-4o",
      priority: 0,
      enabled: true,
    });
  });

  it("resolves multiple logical models from state", () => {
    const routes = resolveRoutesForState(["gpt-4o", "claude"], []);
    expect(routes.map((r) => r.logicalModel)).toEqual(["gpt-4o", "claude"]);
  });
});

describe("retry classification", () => {
  it("classifies rate limiting", () => {
    expect(classifyRetryableFailure(429)).toBe("rate_limited");
    expect(classifyRetryableFailure(undefined, "rate_limit_error")).toBe("rate_limited");
    expect(classifyRetryableFailure(undefined, undefined, "too_many_requests")).toBe("rate_limited");
  });

  it("classifies transient server errors", () => {
    expect(classifyRetryableFailure(408)).toBe("transient");
    expect(classifyRetryableFailure(500)).toBe("transient");
    expect(classifyRetryableFailure(503)).toBe("transient");
    expect(classifyRetryableFailure(undefined, "server_error")).toBe("transient");
    expect(classifyRetryableFailure(undefined, "service_unavailable")).toBe("transient");
  });

  it("classifies persistent failures as non-retryable", () => {
    expect(classifyRetryableFailure(401)).toBe("persistent");
    expect(classifyRetryableFailure(403)).toBe("persistent");
    expect(classifyRetryableFailure(404)).toBe("persistent");
    expect(classifyRetryableFailure(415)).toBe("persistent");
    expect(classifyRetryableFailure(undefined, "unsupported_model")).toBe("persistent");
    expect(classifyRetryableFailure(undefined, "authentication_error")).toBe("persistent");
  });

  it("marks UpstreamError retryable only for transient failures", () => {
    const rateLimited = new UpstreamError("slow down", { status: 429 });
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryAfterMs).toBeUndefined();

    const auth = new UpstreamError("bad key", { status: 401 });
    expect(auth.retryable).toBe(false);

    const withRetryAfter = new UpstreamError("throttled", { status: 429, retryAfterMs: 5000 });
    expect(withRetryAfter.retryable).toBe(true);
    expect(withRetryAfter.retryAfterMs).toBe(5000);
  });
});

describe("retryWithBackoff", () => {
  it("retries transient errors and succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new UpstreamError("transient", { status: 503 });
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 10, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After instead of exponential backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new UpstreamError("throttled", { status: 429, retryAfterMs: 1000 });
        },
        { maxAttempts: 3, baseDelayMs: 10, sleep },
      ),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("does not retry persistent failures", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new UpstreamError("bad key", { status: 401 });
        },
        { maxAttempts: 5, baseDelayMs: 10, sleep },
      ),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("respects the attempt budget", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("boom");
        },
        { maxAttempts: 2, baseDelayMs: 10, sleep },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});

describe("isRetryableError", () => {
  it("returns false for abort errors", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableError(abort)).toBe(false);
  });

  it("returns false for persistent UpstreamError", () => {
    expect(isRetryableError(new UpstreamError("no", { status: 401 }))).toBe(false);
  });

  it("returns true for transient UpstreamError", () => {
    expect(isRetryableError(new UpstreamError("retry", { status: 503 }))).toBe(true);
  });
});