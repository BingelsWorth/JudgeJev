import { Annotation } from "@langchain/langgraph";
import type { ProviderId } from "../providers/types.js";
import type { WorkerCheckpoint } from "../providers/types.js";
import type { ModelRoute } from "../providers/router.js";

export interface WorkerAttempt {
  id: string;
  model: string;
  upstreamModel?: string;
  provider: ProviderId;
  status: "pending" | "running" | "succeeded" | "failed" | "killed";
  content: string;
  checkpoint?: WorkerCheckpoint;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface GenerationParams {
  temperature?: number;
  maxTokens?: number;
  /** Only meaningful in "completion" mode - raw completions have no chat template to stop generation for them. */
  stop?: string[];
}

export interface JevRunState {
  request: string;
  /** "chat" (default) wraps `request` as a single user message; "completion" sends it as a raw text-continuation prompt - see `/v1/completions`. */
  mode?: "chat" | "completion";
  genParams?: GenerationParams;
  models: string[];
  modelConfigs: ModelRoute[];
  workers: WorkerAttempt[];
  candidates: WorkerAttempt[];
  winner: WorkerAttempt | null;
  judgeNotes: string[];
  interventionCycles: number;
}

export const JevStateAnnotation = Annotation.Root({
  request: Annotation<string>(),
  mode: Annotation<"chat" | "completion" | undefined>(),
  genParams: Annotation<GenerationParams | undefined>(),
  models: Annotation<string[]>({
    reducer: (_left: string[], right: string[]) => right,
    default: () => [],
  }),
  modelConfigs: Annotation<ModelRoute[]>({
    reducer: (_left: ModelRoute[], right: ModelRoute[]) => right,
    default: () => [],
  }),
  workers: Annotation<WorkerAttempt[]>({
    reducer: (_left: WorkerAttempt[], right: WorkerAttempt[]) => right,
    default: () => [],
  }),
  candidates: Annotation<WorkerAttempt[]>({
    reducer: (_left: WorkerAttempt[], right: WorkerAttempt[]) => right,
    default: () => [],
  }),
  winner: Annotation<WorkerAttempt | null>(),
  judgeNotes: Annotation<string[]>({
    reducer: (_left: string[], right: string[]) => right,
    default: () => [],
  }),
  interventionCycles: Annotation<number>(),
});

export type JevState = typeof JevStateAnnotation.State;
export type JevStateUpdate = typeof JevStateAnnotation.Update;
