/**
 * BYOT (Bring Your Own Token) credential handling.
 *
 * `MemoryCredentialStore` is the only implementation: in-memory, per-isolate,
 * not persisted. Routes normally carry their own `apiKey` (see
 * `providers/router.ts`'s `ModelRoute`); this only matters as the fallback
 * `buildModel()` checks when a route doesn't set one.
 */

export interface Credentials {
  openai?: string;
  anthropic?: string;
  gemini?: string;
}

export interface StoredCredential {
  id: string;
  provider: "openai" | "anthropic" | "gemini";
  label: string;
  encrypted: string;
  createdAt: number;
}

export interface CredentialStore {
  get(provider: string): Promise<string | undefined>;
  set(provider: string, token: string, label?: string): Promise<void>;
  list(): Promise<Omit<StoredCredential, "encrypted">[]>;
  delete(provider: string): Promise<void>;
}

/**
 * In-memory credential store used during development and tests.
 */
export class MemoryCredentialStore implements CredentialStore {
  private store = new Map<string, string>();

  async get(provider: string): Promise<string | undefined> {
    return this.store.get(provider);
  }

  async set(provider: string, token: string): Promise<void> {
    this.store.set(provider, token);
  }

  async list(): Promise<Omit<StoredCredential, "encrypted">[]> {
    return [...this.store.entries()].map(([provider]) => ({
      id: provider,
      provider: provider as "openai" | "anthropic" | "gemini",
      label: provider,
      createdAt: 0,
    }));
  }

  async delete(provider: string): Promise<void> {
    this.store.delete(provider);
  }
}