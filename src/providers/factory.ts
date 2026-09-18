import type { JevModel, ProviderId } from "./types.js";
import type { ModelRoute } from "./router.js";
import { createOpenAIModel, type OpenAIModelOptions } from "./openai.js";
import { createAnthropicModel, type AnthropicModelOptions } from "./anthropic.js";
import { createGeminiModel, type GeminiModelOptions } from "./gemini.js";
import type { CredentialStore } from "../auth/credentials.js";

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  logicalModel?: string;
  apiKey?: string;
  baseUrl?: string;
}

export function configFromRoute(route: ModelRoute, apiKey?: string): ProviderConfig {
  return {
    provider: route.provider,
    model: route.upstreamModel,
    logicalModel: route.logicalModel,
    apiKey,
  };
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
      return createOpenAIModel(config.model, {
        apiKey,
        baseUrl: config.baseUrl,
        logicalId: config.logicalModel,
      });
    case "anthropic":
      return createAnthropicModel(config.model, {
        apiKey,
        baseUrl: config.baseUrl,
        logicalId: config.logicalModel,
      });
    case "gemini":
      return createGeminiModel(config.model, {
        apiKey,
        baseUrl: config.baseUrl,
        logicalId: config.logicalModel,
      });
  }
}
