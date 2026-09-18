/**
 * Judge Jev LangGraph orchestration.
 *
 * The graph models one user request flowing through:
 *   fanOut -> inspect -> intervene -> judge -> winner
 *
 * This is the initial scaffolding. The full intervention/restart/branch/prune
 * logic will be filled in as the Jev system matures.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { JevStateAnnotation, type JevState, type WorkerAttempt } from "./state.js";
import { judgeCandidates } from "../judge/judge.js";

/**
 * Spawn one worker per configured model. Each worker is a placeholder that
 * will eventually call the provider layer, stream, and emit checkpoints.
 */
async function fanOut(state: JevState): Promise<Partial<JevState>> {
  const workers: WorkerAttempt[] = (state.models ?? []).map((model, index) => ({
    id: `worker-${index}`,
    model,
    provider: "openai",
    status: "pending",
    content: "",
  }));

  return { workers };
}

/**
 * Inspect worker checkpoints and record observations in `judgeNotes`.
 */
async function inspect(state: JevState): Promise<Partial<JevState>> {
  const notes: string[] = [];
  for (const w of state.workers) {
    notes.push(`inspected ${w.id} (${w.model}): status=${w.status}`);
  }
  return { judgeNotes: notes };
}

/**
 * Jev intervention: kill bad workers, restart misunderstood tasks, branch
 * promising approaches, prune duplicates. Currently a passthrough.
 */
async function intervene(state: JevState): Promise<Partial<JevState>> {
  return { interventionCycles: (state.interventionCycles ?? 0) + 1 };
}

/**
 * Judge the surviving candidates and pick a winner.
 */
async function judge(state: JevState): Promise<Partial<JevState>> {
  const winner = judgeCandidates(state.candidates.length ? state.candidates : state.workers);
  return { winner };
}

export function buildJevGraph() {
  const builder = new StateGraph(JevStateAnnotation)
    .addNode("fanOut", fanOut)
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