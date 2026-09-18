/// <reference types="vitest/globals" />
/// <reference types="@cloudflare/workers-types" />

import { describe, it, expect } from "vitest";
import { buildJevGraph } from "../src/graph/jev-graph.js";
import { MemoryRunRepository } from "../src/runs/repository.js";
import { judgeCandidates } from "../src/judge/judge.js";
import type { WorkerAttempt } from "../src/graph/state.js";

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
    const run = await repo.create({ request: "x", models: [], workers: [], candidates: [], winner: null, judgeNotes: [], interventionCycles: 0 });
    const fetched = await repo.get(run.id);
    expect(fetched?.state.request).toBe("x");
  });
});

describe("buildJevGraph", () => {
  it("runs a graph to completion", async () => {
    const graph = buildJevGraph();
    const result = await graph.invoke({
      request: "what is 2+2?",
      models: ["gpt-4o"],
      workers: [],
      candidates: [],
      winner: null,
      judgeNotes: [],
      interventionCycles: 0,
    });
    expect(result.interventionCycles).toBe(1);
    expect(result.workers).toHaveLength(1);
    expect(result.winner).not.toBeNull();
  });
});