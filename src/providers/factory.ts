/**
 * Provider factory — build a normalized JevModel from BYOT credentials.
 */

import type { JevModel } from "./types.js";
import { createOpenAIModel, type OpenAIModelOptions } from "./openai.js";
import { createAnthropicModel, type AnthropicModelOptions } from "./anthropic.js";
import { createGeminiModel, type GeminiModelOptions } from "./gemini.js";
import type { CredentialStore } from "../auth/credentials.js";

export interface ProviderConfig {
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  apiKey?: string;
}

export async function buildModel(
  config: ProviderConfig,
  credentials: CredentialStore,
): Promise<JevModel> {
  const apiKey = config.apiKey ?? (await credentials.get(config.provider));
  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${config.provider}`);
  }

  switch (config.provider) {
    case "openai":
      return createOpenAIModel(config.model, { apiKey } as OpenAIModelOptions);
    case "anthropic":
      return createAnthropicModel(config.model, { apiKey } as AnthropicModelOptions);
    case "gemini":
      return createGeminiModel(config.model, { apiKey } as GeminiModelOptions);
    default:
      throw new Error(`Unsupported provider: ${(config as any).provider}`);
  }
}