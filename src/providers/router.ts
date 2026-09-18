import type { ProviderId } from "./types.js";

export interface ModelRoute {
  logicalModel: string;
  provider: ProviderId;
  upstreamModel: string;
  aliases?: string[];
  priority?: number;
  enabled?: boolean;
}

export function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

export function resolveModelRoutes(logicalModel: string, routes: ModelRoute[]): ModelRoute[] {
  const target = normalizeModelName(logicalModel);
  return routes
    .filter((route) => {
      if (route.enabled === false) return false;
      const aliases = (route.aliases ?? []).map(normalizeModelName);
      return normalizeModelName(route.logicalModel) === target || aliases.includes(target);
    })
    .map((route) => ({ ...route, priority: route.priority ?? 0 }))
    .sort((left, right) => right.priority - left.priority);
}

export function resolveRoutesForState(models: string[], modelConfigs: ModelRoute[]): ModelRoute[] {
  const logicalModels = models.length
    ? models
    : [...new Set(modelConfigs.map((route) => route.logicalModel))];
  const routes = modelConfigs.length ? modelConfigs : defaultModelRoutes(logicalModels);
  return logicalModels.flatMap((model) => resolveModelRoutes(model, routes));
}

export function defaultModelRoutes(models: string[] = ["gpt-4o"]): ModelRoute[] {
  return models.map((model) => ({
    logicalModel: model,
    provider: "openai",
    upstreamModel: model,
    priority: 0,
    enabled: true,
  }));
}
