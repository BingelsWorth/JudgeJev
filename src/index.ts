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
import { buildModel, configFromRoute } from "./providers/factory.js";
import { MemoryCredentialStore } from "./auth/credentials.js";
import { defaultModelRoutes, modelNamesForRoutes, normalizeModelRoute, type ModelRoute, type ModelRouteInput } from "./providers/router.js";
import type { JevRunState } from "./graph/state.js";
import type { ProviderId } from "./providers/types.js";
import { createV1Router } from "./api/v1.js";

type Bindings = {
  JUDGE_JEV_RUNS?: D1Database;
  JEV_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  GEMINI_BASE_URL?: string;
};

interface RunBody {
  request?: string;
  models?: string[];
  modelConfigs?: ModelRouteInput[];
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

app.route("/", createV1Router());

app.get("/", (c) =>
  c.json({
    service: "judge-jev",
    version: "0.2.0",
    endpoints: [
      "GET  /health",
      "POST /v1/responses",
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /runs",
      "GET  /runs",
      "GET  /runs/:id",
      "DELETE /runs/:id",
      "POST /runs/:id/judge",
    ],
  }),
);

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "judge-jev", version: "0.2.0" });
});

function getRepo(c: { env: Bindings }): RunRepository {
  return c.env.JUDGE_JEV_RUNS ? new D1RunRepository(c.env.JUDGE_JEV_RUNS) : new MemoryRunRepository();
}

function getProviderConfig(env: Bindings, provider: ProviderId): { apiKey: string | undefined; baseUrl: string | undefined } {
  switch (provider) {
    case "openai":
      return { apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL };
    case "anthropic":
      return { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL };
    case "gemini":
      return { apiKey: env.GEMINI_API_KEY, baseUrl: env.GEMINI_BASE_URL };
  }
}

function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

function normalizeModelConfigs(configs: ModelRouteInput[] | undefined): ModelRoute[] {
  return (configs ?? []).map(normalizeModelRoute);
}

function normalizeRunBody(body: RunBody): { models: string[]; modelConfigs: ModelRoute[] } {
  const modelConfigs = normalizeModelConfigs(body.modelConfigs);
  const models = (body.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean);

  if (modelConfigs.length > 0) {
    return { models: models.length ? models : modelNamesForRoutes(modelConfigs), modelConfigs };
  }

  return { models: models.length ? models : ["gpt-4o"], modelConfigs: defaultModelRoutes(models.length ? models : ["gpt-4o"]) };
}

function buildGraph(c: { env: Bindings }) {
  const credentials = new MemoryCredentialStore();
  return buildJevGraph({
    modelFactory: async (route) => {
      const { apiKey, baseUrl } = getProviderConfig(c.env, route.provider);
      return buildModel(configFromRoute(route, apiKey, baseUrl), credentials);
    },
  });
}

app.post("/runs", async (c) => {
  const body = await c.req.json<RunBody>();
  if (!body?.request?.trim()) {
    return c.json({ error: "request is required" }, 400);
  }
  if (body.modelConfigs !== undefined && (!Array.isArray(body.modelConfigs) || body.modelConfigs.some((config) =>
    !(config.logicalModel?.trim() || config.name?.trim()) || !isProviderId(config.provider)))) {
    return c.json({ error: "modelConfigs require logicalModel or name and a supported provider" }, 400);
  }

  const { models, modelConfigs } = normalizeRunBody(body);
  const repo = getRepo(c);
  const initialState: JevRunState = {
    request: body.request,
    models,
    modelConfigs,
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
  if (!run) return c.json({ error: "run not found" }, 400);
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

  const graph = buildGraph(c);
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
