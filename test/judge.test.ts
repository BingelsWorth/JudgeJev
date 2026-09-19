/// <reference types="vitest/globals" />
/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from "vitest";
import { buildJevGraph } from "../src/graph/jev-graph.js";
import app from "../src/index.js";
import { MemoryRunRepository } from "../src/runs/repository.js";
import { judgeCandidates } from "../src/judge/judge.js";
import type { WorkerAttempt } from "../src/graph/state.js";
import { resolveRoutesForState, routeLogicalModel, routeUpstreamModel, type ModelRoute } from "../src/providers/router.js";
import type { JevModel } from "../src/providers/types.js";

describe("judgeCandidates", () => {
  it("picks the only candidate", () => {
    const a: WorkerAttempt = { id: "a", model: "m", provider: "openai", status: "succeeded", content: "hello" };
    expect(judgeCandidates([a])).toBe(a);
  });

  it("prefers the longest content", () => {
    const a: WorkerAttempt = { id: "a", model: "m", provider: "openai", status: "succeeded", content: "hi" };
    const b: WorkerAttempt = { id: "b", model: "m", provider: "openai", status: "succeeded", content: "hello world" };
    expect(judgeCandidates([a, b])).toBe(b);
  });

  it("returns null for empty input", () => {
    expect(judgeCandidates([])).toBeNull();
  });
});

describe("MemoryRunRepository", () => {
  it("creates and retrieves a run", async () => {
    const repo = new MemoryRunRepository();
    const run = await repo.create({ request: "x", models: [], modelConfigs: [], workers: [], candidates: [], winner: null, judgeNotes: [], interventionCycles: 0 });
    const fetched = await repo.get(run.id);
    expect(fetched?.state.request).toBe("x");
  });
});

describe("POST /runs model configurations", () => {
  const server = app as unknown as {
    fetch: (request: Request, env: Record<string, string | undefined>) => Promise<Response>;
  };

  async function createRun(body: unknown, env: Record<string, string | undefined> = {}) {
    return server.fetch(new Request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env);
  }

  it("normalizes name-only fan-out configuration and derives public models", async () => {
    const res = await createRun({
      request: "test",
      modelConfigs: [{
        name: "local-qwen",
        provider: "openai",
        model: "qwen3.5-9b",
        endpoint: "http://localhost:8000/v1",
        apiKey: "local-key",
        fanout: { fast: 2, coding: 1 },
      }],
    });

    expect(res.status).toBe(201);
    const json: any = await res.json();
    expect(json.state.models).toEqual(["fast", "coding"]);
    expect(json.state.modelConfigs).toEqual([{
      name: "local-qwen",
      logicalModel: "local-qwen",
      provider: "openai",
      upstreamModel: "qwen3.5-9b",
      model: "qwen3.5-9b",
      endpoint: "http://localhost:8000/v1",
      apiKey: "local-key",
      priority: 0,
      enabled: true,
      fanout: { fast: 2, coding: 1 },
    }]);
  });

  it("uses the default route when modelConfigs is explicitly empty", async () => {
    const res = await createRun({ request: "test", modelConfigs: [] });

    expect(res.status).toBe(201);
    const json: any = await res.json();
    expect(json.state.models).toEqual(["gpt-4o"]);
    expect(json.state.modelConfigs).toEqual([{
      logicalModel: "gpt-4o",
      provider: "openai",
      upstreamModel: "gpt-4o",
      priority: 0,
      enabled: true,
    }]);
  });
});

describe("buildJevGraph", () => {
  it("runs a graph to completion", async () => {
    const routes: ModelRoute[] = [
      { logicalModel: "gpt-4o", provider: "openai", upstreamModel: "gpt-4o" },
      { logicalModel: "claude", provider: "anthropic", upstreamModel: "claude-3-5-sonnet-latest" },
    ];
    const graph = buildJevGraph({
      modelFactory: async (route) => ({
        provider: route.provider,
        id: routeUpstreamModel(route),
        logicalId: routeLogicalModel(route),
        complete: async () => ({ content: route.provider === "openai" ? "short" : "a longer answer" }),
        async *stream() {},
      }) satisfies JevModel,
    });
    const result = await graph.invoke({
      request: "what is 2+2?",
      models: ["gpt-4o", "claude"],
      modelConfigs: routes,
      workers: [],
      candidates: [],
      winner: null,
      judgeNotes: [],
      interventionCycles: 0,
    });
    expect(result.interventionCycles).toBe(1);
    expect(result.workers).toHaveLength(2);
    expect(result.workers.map((worker) => worker.status)).toEqual(["succeeded", "succeeded"]);
    expect(result.winner?.model).toBe("claude");
  });

  it("expands fan-out registrations and preserves route metadata", async () => {
    const routes: ModelRoute[] = [
      {
        name: "local-qwen",
        provider: "openai",
        model: "qwen3.5-9b",
        endpoint: "http://localhost:8000/v1",
        apiKey: "local-key",
        fanout: { fast: 2 },
      },
      {
        name: "openai-mini",
        provider: "anthropic",
        model: "some-model",
        endpoint: "https://api.openai.com/v1",
        apiKey: "openai-key",
        fanout: { fast: 1 },
      },
    ];
    const seen: ModelRoute[] = [];
    const graph = buildJevGraph({
      modelFactory: async (route) => {
        seen.push(route);
        return {
          provider: route.provider,
          id: routeUpstreamModel(route),
          logicalId: routeLogicalModel(route),
          complete: async () => ({ content: route.name ?? "unknown" }),
          async *stream() {},
        } satisfies JevModel;
      },
    });
    const result = await graph.invoke({
      request: "what is 2+2?",
      models: ["FAST"],
      modelConfigs: routes,
      workers: [],
      candidates: [],
      winner: null,
      judgeNotes: [],
      interventionCycles: 0,
    });

    expect(seen).toHaveLength(3);
    expect(seen.map((route) => route.name)).toEqual(["local-qwen", "local-qwen", "openai-mini"]);
    expect(result.workers.map((worker) => worker.model)).toEqual(["fast", "fast", "fast"]);
    expect(result.workers.map((worker) => worker.upstreamModel)).toEqual(["qwen3.5-9b", "qwen3.5-9b", "some-model"]);
    expect(seen[0].endpoint).toBe("http://localhost:8000/v1");
    expect(seen[0].apiKey).toBe("local-key");
  });
});