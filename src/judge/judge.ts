import type { WorkerAttempt } from "../graph/state.js";

export interface JudgeDecision {
  winner: WorkerAttempt | null;
  notes: string[];
}

export function judgeCandidates(candidates: WorkerAttempt[]): WorkerAttempt | null {
  const viable = candidates.filter(
    (candidate) => candidate.status === "succeeded" && candidate.content.trim().length > 0,
  );
  if (viable.length === 0) return null;

  return viable.reduce((best, current) =>
    current.content.trim().length > best.content.trim().length ? current : best,
  );
}

export function buildJudgeDecision(candidates: WorkerAttempt[]): JudgeDecision {
  const winner = judgeCandidates(candidates);
  const notes = [`judged ${candidates.length} candidate(s)`];
  if (winner) {
    notes.push(`winner=${winner.id} (${winner.model})`);
  } else {
    notes.push("winner=null: no viable candidates");
  }
  return { winner, notes };
}
