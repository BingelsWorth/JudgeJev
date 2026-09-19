/**
 * Judge Jev LangGraph orchestration.
 *
 * The graph models one user request flowing through:
 *   fanOut -> inspect -> intervene -> judge -> winner
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { JevStateAnnotation, type JevState, type WorkerAttempt } from "./state.js";
import { buildJudgeDecision, judgeCandidates } from "../judge/judge.js";
import { resolveRoutesForState, routeLogicalModel, routeUpstreamModel, type ModelRoute } from "../providers/router.js";
import type { JevModel } from "../providers/types.js";

export interface JevGraphOptions {
  modelFactory: (route: ModelRoute) => Promise<JevModel>;
}

async function fanOut(state: JevState, options: JevGraphOptions): Promise<Partial<JevState>> {
  const routes = routesForState(state);
  const workers = await Promise.all(
    routes.map((route, index) => runWorker(state, route, index, options)),
  );

  return { workers, candidates: [], winner: null, judgeNotes: [] };
}

async function runWorker(
  state: JevState,
  route: ModelRoute,
  index: number,
  options: JevGraphOptions,
): Promise<WorkerAttempt> {
  const worker: WorkerAttempt = {
    id: `worker-${index}`,
    model: routeLogicalModel(route) || route.name || "",
    upstreamModel: routeUpstreamModel(route) || undefined,
    provider: route.provider,
    status: "running",
    content: "",
  };

  try {
    const model = await options.modelFactory(route);
    const response = await model.complete({
      model: routeUpstreamModel(route),
      logicalModel: routeLogicalModel(route) || undefined,
      messages: [{ role: "user", content: state.request }],
    });

    return {
      ...worker,
      status: "succeeded",
      content: response.content,
      usage: response.usage,
    };
  } catch (error) {
    return {
      ...worker,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspect(state: JevState): Promise<Partial<JevState>> {
  const notes = state.workers.map((worker) => {
    const detail = worker.error ? ` error=${worker.error}` : "";
    return `inspected ${worker.id} (${worker.model}/${worker.upstreamModel ?? worker.model}): status=${worker.status}${detail}`;
  });
  return { judgeNotes: notes };
}

async function intervene(state: JevState): Promise<Partial<JevState>> {
  const viable = state.workers.filter(
    (worker) => worker.status === "succeeded" && worker.content.trim().length > 0,
  );
  const seen = new Set<string>();
  const candidates: WorkerAttempt[] = [];
  const duplicateIds = new Set<string>();

  for (const worker of viable) {
    const fingerprint = worker.content.trim().toLowerCase();
    if (seen.has(fingerprint)) {
      duplicateIds.add(worker.id);
      continue;
    }
    seen.add(fingerprint);
    candidates.push(worker);
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const workers = state.workers.map((worker) =>
    candidateIds.has(worker.id) ? worker : { ...worker, status: "killed" as const },
  );
  const notes = [
    `kept ${candidates.length} candidate(s)`,
    `killed ${workers.filter((worker) => worker.status === "killed").length} worker(s)`,
    `pruned ${duplicateIds.size} duplicate candidate(s)`,
  ];

  return { workers, candidates, judgeNotes: notes, interventionCycles: (state.interventionCycles ?? 0) + 1 };
}

async function judge(state: JevState): Promise<Partial<JevState>> {
  const pool = state.candidates.length ? state.candidates : state.workers.filter(
    (worker) => worker.status === "succeeded" && worker.content.trim().length > 0,
  );
  const decision = buildJudgeDecision(pool);
  return { winner: decision.winner, judgeNotes: [...state.judgeNotes, ...decision.notes] };
}

function routesForState(state: JevState): ModelRoute[] {
  return resolveRoutesForState(state.models, state.modelConfigs);
}

export function buildJevGraph(options: JevGraphOptions) {
  const builder = new StateGraph(JevStateAnnotation)
    .addNode("fanOut", (state) => fanOut(state, options))
    .addNode("inspect", inspect)
    .addNode("intervene", intervene)
    .addNode("judge", judge);

  return builder
    .addEdge(START, "fanOut")
    .addEdge("fanOut", "inspect")
    .addEdge("inspect", "intervene")
    .addEdge("intervene", "judge")
    .addEdge("judge", END)
    .compile();
}

export type JevGraph = ReturnType<typeof buildJevGraph>;
