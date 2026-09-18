/// <reference types="vitest/globals" />
/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from "vitest";
import { buildJevGraph } from "../src/graph/jev-graph.js";
import { MemoryRunRepository } from "../src/runs/repository.js";
import { judgeCandidates } from "../src/judge/judge.js";
import type { WorkerAttempt } from "../src/graph/state.js";
import type { ModelRoute } from "../src/providers/router.js";
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

describe("buildJevGraph", () => {
  it("runs a graph to completion", async () => {
    const routes: ModelRoute[] = [
      { logicalModel: "gpt-4o", provider: "openai", upstreamModel: "gpt-4o" },
      { logicalModel: "claude", provider: "anthropic", upstreamModel: "claude-3-5-sonnet-latest" },
    ];
    const graph = buildJevGraph({
      modelFactory: async (route) => ({
        provider: route.provider,
        id: route.upstreamModel,
        logicalId: route.logicalModel,
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
});