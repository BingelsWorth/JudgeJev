/**
 * Run / session persistence for Judge Jev.
 *
 * In-memory only: each Worker isolate holds its own runs, so a run created in
 * one isolate isn't guaranteed to be visible from a later request landing in
 * another. That's fine for the `/runs` debug/inspection API this backs - the
 * real product surface (`/v1/*`) is stateless and doesn't use this at all.
 */

import type { JevRunState } from "./graph/state.js";

export interface StoredRun {
  id: string;
  state: JevRunState;
  createdAt: number;
  updatedAt: number;
}

export interface RunRepository {
  create(state: JevRunState): Promise<StoredRun>;
  get(id: string): Promise<StoredRun | null>;
  update(id: string, state: JevRunState): Promise<StoredRun | null>;
  delete(id: string): Promise<boolean>;
  list(limit?: number): Promise<StoredRun[]>;
}

export class MemoryRunRepository implements RunRepository {
  private store = new Map<string, StoredRun>();

  async create(state: JevRunState): Promise<StoredRun> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const run: StoredRun = { id, state, createdAt: now, updatedAt: now };
    this.store.set(id, run);
    return run;
  }

  async get(id: string): Promise<StoredRun | null> {
    return this.store.get(id) ?? null;
  }

  async update(id: string, state: JevRunState): Promise<StoredRun | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: StoredRun = { ...existing, state, updatedAt: Date.now() };
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async list(limit = 50): Promise<StoredRun[]> {
    return [...this.store.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
}
