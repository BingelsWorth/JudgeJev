/**
 * Run / session persistence for Judge Jev.
 *
 * Backed by Cloudflare D1 (`JUDGE_JEV_RUNS` binding). Each run stores its
 * state, models, workers, and checkpoints so runs can be resumed or inspected
 * later.
 */

import type { JevRunState } from "../graph/state.js";

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

/**
 * D1-backed repository. Pass the `JUDGE_JEV_RUNS` D1 binding.
 */
export class D1RunRepository implements RunRepository {
  private initialized = false;

  constructor(private db: D1Database) {}

  private async ensureSchema() {
    if (this.initialized) return;
    this.initialized = true;
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS jev_runs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
         CREATE INDEX IF NOT EXISTS idx_jev_runs_updated_at ON jev_runs (updated_at DESC);`,
      )
      .all();
  }

  async create(state: JevRunState): Promise<StoredRun> {
    await this.ensureSchema();
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO jev_runs (id, state, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(id, JSON.stringify(state), now, now)
      .run();
    return { id, state, createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<StoredRun | null> {
    await this.ensureSchema();
    const row = await this.db
      .prepare(`SELECT id, state, created_at, updated_at FROM jev_runs WHERE id = ?`)
      .bind(id)
      .first<{ id: string; state: string; created_at: number; updated_at: number }>();
    if (!row) return null;
    return {
      id: row.id,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async update(id: string, state: JevRunState): Promise<StoredRun | null> {
    await this.ensureSchema();
    const existing = await this.get(id);
    if (!existing) return null;
    const now = Date.now();
    await this.db
      .prepare(`UPDATE jev_runs SET state = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(state), now, id)
      .run();
    return { id, state, createdAt: existing.createdAt, updatedAt: now };
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.db
      .prepare(`DELETE FROM jev_runs WHERE id = ?`)
      .bind(id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async list(limit = 50): Promise<StoredRun[]> {
    await this.ensureSchema();
    const { results } = await this.db
      .prepare(`SELECT id, state, created_at, updated_at FROM jev_runs ORDER BY updated_at DESC LIMIT ?`)
      .bind(limit)
      .all<{ id: string; state: string; created_at: number; updated_at: number }>();
    return (results ?? []).map((row) => ({
      id: row.id,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}

/**
 * In-memory repository used during development and tests.
 */
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

export const JEV_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS jev_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jev_runs_updated_at ON jev_runs (updated_at DESC);
`;