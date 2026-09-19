import type { ProviderId } from "./types.js";

export interface ModelRoute {
  name?: string;
  logicalModel?: string;
  provider: ProviderId;
  upstreamModel?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  aliases?: string[];
  priority?: number;
  enabled?: boolean;
  fanout?: Record<string, number>;
}

export interface ModelRouteInput {
  name?: string;
  logicalModel?: string;
  provider: ProviderId;
  upstreamModel?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  aliases?: string[];
  priority?: number;
  enabled?: boolean;
  fanout?: Record<string, unknown>;
}

export function normalizeModelRoute(config: ModelRouteInput): ModelRoute {
  return {
    name: config.name?.trim(),
    logicalModel: config.logicalModel?.trim() || config.name?.trim(),
    provider: config.provider,
    upstreamModel: config.upstreamModel?.trim()
      || config.model?.trim()
      || config.logicalModel?.trim()
      || config.name?.trim(),
    model: config.model?.trim(),
    endpoint: config.endpoint?.trim(),
    apiKey: config.apiKey,
    aliases: config.aliases?.map((alias) => alias.trim()).filter(Boolean),
    priority: config.priority ?? 0,
    enabled: config.enabled ?? true,
    fanout: normalizeFanout(config.fanout),
  };
}

export function normalizeModelConfigs(configs: ModelRouteInput[] | undefined): ModelRoute[] {
  return (configs ?? []).map(normalizeModelRoute);
}

/**
 * Parses the MODEL_CONFIGS env var: the same JSON array shape as the request
 * body's `modelConfigs` field ([{name, provider, model, endpoint, apiKey,
 * fanout}, ...]), used as the default route set when a request doesn't supply
 * its own. Invalid or absent input yields an empty array rather than
 * throwing, so a malformed env var degrades to the hardcoded default route
 * instead of failing every request.
 */
export function parseModelConfigsEnv(raw: string | undefined): ModelRoute[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeModelConfigs(parsed as ModelRouteInput[]);
  } catch {
    return [];
  }
}

export function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function isValidFanoutMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidFanoutCount(count: unknown): count is number {
  return typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count > 0;
}

function firstNonEmptyModelName(...models: Array<string | undefined>): string {
  return models.find((model) => model?.trim())?.trim() ?? "";
}

function nonEmptyModelName(model: string | undefined): string | undefined {
  const normalized = model ? normalizeModelName(model) : "";
  return normalized || undefined;
}

export function registrationName(route: ModelRoute): string {
  return route.name ?? route.logicalModel ?? route.upstreamModel ?? route.model ?? "";
}

export function upstreamModelName(route: ModelRoute): string {
  return route.upstreamModel ?? route.model ?? route.logicalModel ?? route.name ?? "";
}

function legacyModelNames(route: ModelRoute): string[] {
  const logicalModel = nonEmptyModelName(route.logicalModel);
  const name = logicalModel ? undefined : nonEmptyModelName(route.name);
  return [...new Set([logicalModel, name].filter((model): model is string => Boolean(model)))];
}

function matchesLegacyRoute(route: ModelRoute, target: string): boolean {
  const aliases = (route.aliases ?? []).map(normalizeModelName);
  return legacyModelNames(route).includes(target) || aliases.includes(target);
}

function findFanoutEntry(route: ModelRoute, requestedModel: string): [string, number] | undefined {
  if (!isValidFanoutMap(route.fanout)) return undefined;

  const target = normalizeModelName(requestedModel);
  let best: [string, number] | undefined;
  for (const [model, count] of Object.entries(route.fanout)) {
    if (normalizeModelName(model) !== target || !isValidFanoutCount(count)) continue;
    if (!best || count > best[1]) best = [model, count];
  }
  return best;
}

function fanoutCount(route: ModelRoute, requestedModel: string): number {
  return findFanoutEntry(route, requestedModel)?.[1] ?? 0;
}

export function normalizeFanout(fanout: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (fanout === undefined) return undefined;
  if (!isValidFanoutMap(fanout)) return undefined;

  const normalized: Record<string, number> = {};
  for (const [model, count] of Object.entries(fanout)) {
    if (isValidFanoutCount(count)) normalized[model] = count;
  }
  return normalized;
}

export function routeLogicalModel(route: ModelRoute): string {
  return firstNonEmptyModelName(route.logicalModel, route.name, route.upstreamModel, route.model);
}

export function routeUpstreamModel(route: ModelRoute): string {
  return firstNonEmptyModelName(route.upstreamModel, route.model, route.logicalModel, route.name);
}

function hasFanout(route: ModelRoute): route is ModelRoute & { fanout: Record<string, number> } {
  return route.fanout !== undefined && isValidFanoutMap(route.fanout);
}

function fanoutModelNames(route: ModelRoute): string[] {
  return Object.entries(route.fanout ?? {})
    .filter(([, count]) => isValidFanoutCount(count))
    .map(([model]) => model);
}

function modelNamesForRoute(route: ModelRoute): string[] {
  if (!hasFanout(route)) return legacyModelNames(route);
  return fanoutModelNames(route);
}

export function resolveModelRoutes(requestedModel: string, routes: ModelRoute[]): ModelRoute[] {
  const target = normalizeModelName(requestedModel);
  const resolved: ModelRoute[] = [];

  for (const route of routes) {
    if (route.enabled === false) continue;

    const count = hasFanout(route) ? fanoutCount(route, target) : matchesLegacyRoute(route, target) ? 1 : 0;
    for (let index = 0; index < count; index++) {
      resolved.push({
        ...route,
        logicalModel: hasFanout(route) ? target : routeLogicalModel(route),
        upstreamModel: routeUpstreamModel(route),
        priority: route.priority ?? 0,
      });
    }
  }

  return resolved.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

export function modelNamesForRoutes(routes: ModelRoute[]): string[] {
  return [...new Set(routes.flatMap((route) => {
    if (route.enabled === false) return [];
    return modelNamesForRoute(route);
  }).map(normalizeModelName).filter(Boolean))];
}

export function resolveRoutesForState(models: string[], modelConfigs: ModelRoute[]): ModelRoute[] {
  const hasConfigs = modelConfigs.length > 0;
  const logicalModels = models.length
    ? models
    : hasConfigs
      ? modelNamesForRoutes(modelConfigs)
      : ["gpt-4o"];
  const routes = hasConfigs ? modelConfigs : defaultModelRoutes(logicalModels);
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
