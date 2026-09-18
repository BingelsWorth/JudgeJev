/**
 * Judge Jev — Hono API entry point.
 *
 * Endpoints:
 *   GET  /health            — liveness probe
 *   POST /runs              — create a new Jev run
 *   GET  /runs              — list recent runs
 *   GET  /runs/:id          — fetch a run's state
 *   DELETE /runs/:id        — delete a run
 *   POST /runs/:id/judge    — run the judge graph for a run
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildJevGraph } from "./graph/jev-graph.js";
import { D1RunRepository, MemoryRunRepository, type RunRepository } from "./runs/repository.js";
import type { JevRunState } from "./graph/state.js";

type Bindings = {
  JUDGE_JEV_RUNS?: D1Database;
  JEV_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

app.get("/", (c) =>
  c.json({
    service: "judge-jev",
    version: "0.1.0",
    endpoints: [
      "GET  /health",
      "POST /runs",
      "GET  /runs",
      "GET  /runs/:id",
      "DELETE /runs/:id",
      "POST /runs/:id/judge",
    ],
  }),
);

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "judge-jev", version: "0.1.0" });
});

function getRepo(c: { env: Bindings }): RunRepository {
  return c.env.JUDGE_JEV_RUNS ? new D1RunRepository(c.env.JUDGE_JEV_RUNS) : new MemoryRunRepository();
}

app.post("/runs", async (c) => {
  const body = await c.req.json<{ request?: string; models?: string[] }>();
  if (!body?.request) {
    return c.json({ error: "request is required" }, 400);
  }

  const repo = getRepo(c);
  const initialState: JevRunState = {
    request: body.request,
    models: body.models ?? ["gpt-4o"],
    workers: [],
    candidates: [],
    winner: null,
    judgeNotes: [],
    interventionCycles: 0,
  };

  const run = await repo.create(initialState);
  return c.json({ id: run.id, state: run.state }, 201);
});

app.get("/runs", async (c) => {
  const repo = getRepo(c);
  const limit = Number(c.req.query("limit") ?? "50");
  const runs = await repo.list(Number.isNaN(limit) ? 50 : limit);
  return c.json({ runs: runs.map((r) => ({ id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt })) });
});

app.get("/runs/:id", async (c) => {
  const repo = getRepo(c);
  const run = await repo.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json({ id: run.id, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt });
});

app.delete("/runs/:id", async (c) => {
  const repo = getRepo(c);
  const deleted = await repo.delete(c.req.param("id"));
  return c.json({ deleted });
});

app.post("/runs/:id/judge", async (c) => {
  const repo = getRepo(c);
  const run = await repo.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const graph = buildJevGraph();
  const result = await graph.invoke(run.state, { configurable: { thread_id: run.id } });

  await repo.update(run.id, result as JevRunState);
  return c.json({ id: run.id, state: result });
});

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, _env: Bindings, _ctx: EventContext<Bindings, "", unknown>) => {
    // placeholder for scheduled maintenance
  },
};

export type App = typeof app;