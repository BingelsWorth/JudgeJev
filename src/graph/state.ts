/**
 * LangGraph state schema for Judge Jev.
 *
 * A `JevRun` represents one user request being evaluated across multiple
 * model workers. The graph fans out to workers, inspects their checkpoints,
 * and prunes/restarts/branches as needed.
 */

import { Annotation } from "@langchain/langgraph";

export interface WorkerCheckpoint {
  /** What the model thinks the task is. */
  taskInterpretation?: string;
  /** Approach the model is taking. */
  approach?: string;
  /** Assumptions the model is making. */
  assumptions?: string[];
  /** Progress made so far. */
  progress?: string;
}

export interface WorkerAttempt {
  id: string;
  model: string;
  provider: "openai" | "anthropic" | "gemini";
  status: "pending" | "running" | "succeeded" | "failed" | "killed";
  content: string;
  checkpoint?: WorkerCheckpoint;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface JevRunState {
  /** The original user request. */
  request: string;
  /** BYOT / model config used for this run. */
  models: string[];
  /** Active workers competing to answer the request. */
  workers: WorkerAttempt[];
  /** Surviving candidates after pruning. */
  candidates: WorkerAttempt[];
  /** Final judged winner, if any. */
  winner: WorkerAttempt | null;
  /** Free-form notes from the judge. */
  judgeNotes: string[];
  /** Number of intervention cycles applied. */
  interventionCycles: number;
}

export const JevStateAnnotation = Annotation.Root({
  request: Annotation<string>(),
  models: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => [...left, ...right],
    default: () => [],
  }),
  workers: Annotation<WorkerAttempt[]>({
    reducer: (left: WorkerAttempt[], right: WorkerAttempt[]) => [...left, ...right],
    default: () => [],
  }),
  candidates: Annotation<WorkerAttempt[]>({
    reducer: (left: WorkerAttempt[], right: WorkerAttempt[]) => [...left, ...right],
    default: () => [],
  }),
  winner: Annotation<WorkerAttempt | null>(),
  judgeNotes: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => [...left, ...right],
    default: () => [],
  }),
  interventionCycles: Annotation<number>(),
});

export type JevState = typeof JevStateAnnotation.State;
export type JevStateUpdate = typeof JevStateAnnotation.Update;