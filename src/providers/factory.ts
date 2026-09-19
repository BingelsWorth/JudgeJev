import type { JevModel, ProviderId } from "./types.js";
import { routeLogicalModel, routeUpstreamModel, type ModelRoute } from "./router.js";
import { createOpenAIModel, type OpenAIModelOptions } from "./openai.js";
import { createAnthropicModel, type AnthropicModelOptions } from "./anthropic.js";
import { createGeminiModel, type GeminiModelOptions } from "./gemini.js";
import type { CredentialStore } from "../credentials.js";

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  logicalModel?: string;
  apiKey?: string;
  baseUrl?: string;
}

export function configFromRoute(route: ModelRoute, apiKey?: string, baseUrl?: string): ProviderConfig {
  return {
    provider: route.provider,
    model: routeUpstreamModel(route),
    logicalModel: routeLogicalModel(route) || undefined,
    apiKey: route.apiKey ?? apiKey,
    baseUrl: route.endpoint?.trim() || baseUrl,
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
