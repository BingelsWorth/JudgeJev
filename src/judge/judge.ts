/**
 * Judge Jev logic — inspect workers, kill bad ones early, restart
 * misunderstood tasks, branch promising approaches, prune duplicates,
 * then compare surviving candidates and pick one.
 */

import type { WorkerAttempt } from "../graph/state.js";

export interface JudgeDecision {
  winner: WorkerAttempt | null;
  notes: string[];
}

/**
 * Compare surviving candidates and pick a winner.
 *
 * The initial implementation is intentionally simple: it prefers the
 * candidate with the most content, breaking ties by the first surviving
 * candidate. The real judging policy (semantic comparison, preference for
 * certain models, etc.) will be layered on top.
 */
export function judgeCandidates(candidates: WorkerAttempt[]): WorkerAttempt | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const viable = candidates.filter((c) => c.status === "succeeded" && c.content.trim().length > 0);
  if (viable.length === 0) return candidates[0];
  if (viable.length === 1) return viable[0];

  // Prefer the candidate with the most content; ties broken by order.
  return viable.reduce((best, current) =>
    current.content.length > best.content.length ? current : best,
  );
}

export function buildJudgeDecision(candidates: WorkerAttempt[]): JudgeDecision {
  const winner = judgeCandidates(candidates);
  const notes: string[] = [];
  notes.push(`judged ${candidates.length} candidate(s)`);
  if (winner) {
    notes.push(`winner=${winner.id} (${winner.model})`);
  }
  return { winner, notes };
}