import { Hono } from "hono";
import { z } from "zod";
import { buildJevGraph } from "../graph/jev-graph.js";
import type { WorkerAttempt } from "../graph/state.js";
import { defaultModelRoutes, normalizeModelConfigs, parseModelConfigsEnv, type ModelRoute, type ModelRouteInput } from "../providers/router.js";
import { callJevJudge } from "../jev-client.js";
import {
  V1_ENDPOINT_MATRIX,
  GENERIC_CODING_RUBRIC,
  parseV1EndpointPath,
  type V1Endpoint,
  type V1DownstreamRequest,
  type V1DownstreamResponse,
  type V1Candidate,
  type V1Winner,
  type V1JevRequest,
  type V1JevResponse,
  type V1Error,
  type V1ErrorResponse,
  type V1ResponsesInput,
  type V1ChatMessage,
  type V1AnthropicMessage,
  type V1ResponsesRequest,
  type V1ChatCompletionsRequest,
  type V1MessagesRequest,
  type V1ProtocolForEndpoint,
  type V1ResponsesResponse,
  type V1ChatCompletionsResponse,
  type V1MessagesResponse,
  type V1Usage,
  type V1FinishReasonForProtocol,
  type V1AttemptForEndpoint,
  type V1ModelMetadata,
} from "../contracts.js";

interface V1ApiBindings {
  /** Default route registrations (endpoint + token + fan-out dict per entry), same JSON array shape as the request body's `modelConfigs`. Used when a request doesn't supply its own. */
  MODEL_CONFIGS?: string;
  /** API key for Jev (https://docs.typesafe.ai), a fixed public API at a well-known address - not one of our own model routes. Unset = keep using the local bypass heuristic; set = Jev actually judges. */
  JEV_API_KEY?: string;
  /** Overrides Jev's fixed API endpoint. Only for tests/mocks - there is nothing to configure here for real use. */
  JEV_API_ENDPOINT?: string;
  /** Jev model version. Defaults to "jev-latest" (TypeSafe's recommended default) when unset. */
  JEV_MODEL?: string;
  /** "fallback" (default) silently falls back to the local heuristic if the Jev call fails; "error" surfaces a judge_error instead, useful while testing that Jev is actually being exercised. */
  JEV_ON_FAILURE?: string;
}

type V1RouteConfig = ModelRouteInput;

const providerSchema = z.enum(["openai", "anthropic", "gemini"]);

const modelConfigSchema = z.object({
  name: z.string().optional(),
  logicalModel: z.string().optional(),
  provider: providerSchema,
  upstreamModel: z.string().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  fanout: z.record(z.unknown()).optional(),
}).refine(
  (config) => Boolean(config.logicalModel?.trim() || config.name?.trim()),
  { message: "modelConfigs require logicalModel or name" },
);

interface V1RequestBody {
  model?: string;
  models?: string[];
  modelConfigs?: V1RouteConfig[];
}

function buildV1Graph(env: V1ApiBindings) {
  return buildJevGraph({
    modelFactory: async (route: ModelRoute) => {
      const { buildModel, configFromRoute } = await import("../providers/factory.js");
      return buildModel(configFromRoute(route), {
        get: async () => "",
      } as any);
    },
  });
}

function validateRequestBody(body: unknown, endpoint: V1Endpoint): V1DownstreamRequest {
  const requestId = crypto.randomUUID();

  let validated: V1DownstreamRequest;

  switch (endpoint) {
    case "responses": {
      const schema = z.object({
        model: z.string(),
        input: z.union([z.string(), z.array(z.unknown())]),
        instructions: z.string().optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_output_tokens: z.number().optional(),
        tools: z.array(z.unknown()).optional(),
        tool_choice: z.unknown().optional(),
        metadata: z.record(z.unknown()).optional(),
        stream: z.literal(false).optional(),
        extensions: z.record(z.unknown()).optional(),
      });
      const parsed = schema.parse(body);
      const input: V1ResponsesInput = typeof parsed.input === "string" 
        ? parsed.input 
        : parsed.input as V1ResponsesInput;
      validated = {
        requestId,
        endpoint: "responses",
        protocol: "openai_responses",
        model: parsed.model,
        stream: false,
        input,
        instructions: parsed.instructions,
        temperature: parsed.temperature,
        top_p: parsed.top_p,
        max_output_tokens: parsed.max_output_tokens,
        tools: parsed.tools,
        tool_choice: parsed.tool_choice,
        metadata: parsed.metadata,
        extensions: parsed.extensions,
      } as V1ResponsesRequest;
      break;
    }
    case "chat/completions": {
      const schema = z.object({
        model: z.string(),
        messages: z.array(z.object({
          role: z.enum(["system", "user", "assistant", "tool", "function"]),
          content: z.union([z.string(), z.array(z.unknown()), z.null()]),
          name: z.string().optional(),
          tool_call_id: z.string().optional(),
        })),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().optional(),
        tools: z.array(z.unknown()).optional(),
        tool_choice: z.unknown().optional(),
        response_format: z.unknown().optional(),
        metadata: z.record(z.unknown()).optional(),
        stream: z.literal(false).optional(),
        extensions: z.record(z.unknown()).optional(),
      });
      const parsed = schema.parse(body);
      const messages: V1ChatMessage[] = parsed.messages.map((m) => ({
        role: m.role,
        content: m.content as string | V1ChatMessage["content"],
        name: m.name,
        tool_call_id: m.tool_call_id,
      }));
      validated = {
        requestId,
        endpoint: "chat/completions",
        protocol: "openai_chat_completions",
        model: parsed.model,
        stream: false,
        messages,
        temperature: parsed.temperature,
        top_p: parsed.top_p,
        max_tokens: parsed.max_tokens,
        tools: parsed.tools,
        tool_choice: parsed.tool_choice,
        response_format: parsed.response_format,
        metadata: parsed.metadata,
        extensions: parsed.extensions,
      } as V1ChatCompletionsRequest;
      break;
    }
    case "messages": {
      const schema = z.object({
        model: z.string(),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.union([z.string(), z.array(z.unknown())]),
        })),
        system: z.union([z.string(), z.array(z.unknown())]).optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().optional(),
        tools: z.array(z.unknown()).optional(),
        tool_choice: z.unknown().optional(),
        metadata: z.record(z.unknown()).optional(),
        stream: z.literal(false).optional(),
        extensions: z.record(z.unknown()).optional(),
      });
      const parsed = schema.parse(body);
      const messages: V1AnthropicMessage[] = parsed.messages.map((m) => ({
        role: m.role,
        content: m.content as string | V1AnthropicMessage["content"],
      }));
      validated = {
        requestId,
        endpoint: "messages",
        protocol: "anthropic_messages",
        model: parsed.model,
        stream: false,
        messages,
        system: parsed.system as string | V1AnthropicMessage["content"] | undefined,
        temperature: parsed.temperature,
        top_p: parsed.top_p,
        max_tokens: parsed.max_tokens,
        tools: parsed.tools,
        tool_choice: parsed.tool_choice,
        metadata: parsed.metadata,
        extensions: parsed.extensions,
      } as V1MessagesRequest;
      break;
    }
    default:
      throw new Error(`Unknown endpoint: ${endpoint}`);
  }

  return validated;
}
function buildWinnerResponse<E extends V1Endpoint>(
  winner: any,
  endpoint: E,
  request: V1DownstreamRequest
): V1DownstreamResponse {
  const now = Math.floor(Date.now() / 1000);
  const usage: V1Usage | undefined = winner.usage
    ? {
        inputTokens: winner.usage.inputTokens,
        outputTokens: winner.usage.outputTokens,
        totalTokens: winner.usage.inputTokens + winner.usage.outputTokens,
      }
    : undefined;

  switch (endpoint) {
    case "responses": {
      const response: V1ResponsesResponse = {
        id: `resp_${crypto.randomUUID().slice(0, 24)}`,
        object: "response",
        created_at: now,
        model: winner.upstreamModel ?? winner.model,
        status: "completed",
        output: [
          {
            type: "message",
            id: `msg_${crypto.randomUUID().slice(0, 24)}`,
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: winner.content,
              },
            ],
          },
        ],
        usage,
      };
      return response;
    }
    case "chat/completions": {
      const response: V1ChatCompletionsResponse = {
        id: `chatcmpl_${crypto.randomUUID().slice(0, 24)}`,
        object: "chat.completion",
        created: now,
        model: winner.upstreamModel ?? winner.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: winner.content,
              refusal: null,
            },
            finish_reason: "stop",
          },
        ],
        usage,
      };
      return response;
    }
    case "messages": {
      const response: V1MessagesResponse = {
        id: `msg_${crypto.randomUUID().slice(0, 24)}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: winner.content,
          },
        ],
        model: winner.upstreamModel ?? winner.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      };
      return response;
    }
  }
}

function buildJevAttempts<E extends V1Endpoint>(
  workers: WorkerAttempt[],
  endpoint: E,
  protocol: V1ProtocolForEndpoint<E>,
  request: V1DownstreamRequest,
): V1AttemptForEndpoint<E>[] {
  return workers
    .filter((worker) => worker.status === "succeeded" || worker.status === "failed")
    .map((worker): V1AttemptForEndpoint<E> => {
      const model: V1ModelMetadata = {
        logicalModel: worker.model,
        upstreamModel: worker.upstreamModel ?? worker.model,
        provider: worker.provider,
        routeId: worker.id,
      };

      if (worker.status === "succeeded" && worker.content.trim().length > 0) {
        return {
          requestId: request.requestId,
          id: worker.id,
          endpoint,
          protocol,
          status: "succeeded",
          model,
          response: buildWinnerResponse(worker, endpoint, request),
          content: worker.content,
          usage: worker.usage
            ? {
                inputTokens: worker.usage.inputTokens,
                outputTokens: worker.usage.outputTokens,
                totalTokens: worker.usage.inputTokens + worker.usage.outputTokens,
              }
            : undefined,
          finishReason: protocol === "anthropic_messages" ? "end_turn" : "stop",
        } as V1AttemptForEndpoint<E>;
      }

      return {
        requestId: request.requestId,
        id: worker.id,
        endpoint,
        protocol,
        status: "failed",
        model,
        error: {
          attemptId: worker.id,
          code: "upstream_error",
          message: worker.error ?? "worker produced no usable content",
          retryable: false,
          provider: worker.provider,
          upstreamModel: worker.upstreamModel ?? worker.model,
        },
      } as V1AttemptForEndpoint<E>;
    });
}

type JevJudgeOutcome =
  | { called: false }
  | { called: true; ok: true; response: V1DownstreamResponse }
  | { called: true; ok: false; error: V1Error };

async function runJevJudge<E extends V1Endpoint>(
  env: V1ApiBindings,
  workers: WorkerAttempt[],
  endpoint: E,
  request: V1DownstreamRequest,
): Promise<JevJudgeOutcome> {
  // Jev's endpoint is fixed and public (https://docs.typesafe.ai) - there's nothing to
  // point it at. Whether Jev actually judges is gated on having an API key, not an endpoint.
  if (!env.JEV_API_KEY) return { called: false };

  const protocol = V1_ENDPOINT_MATRIX[endpoint].protocol as V1ProtocolForEndpoint<E>;
  const attempts = buildJevAttempts(workers, endpoint, protocol, request);
  const candidates = attempts.filter(
    (attempt): attempt is Extract<V1AttemptForEndpoint<E>, { status: "succeeded" }> => attempt.status === "succeeded",
  );

  if (candidates.length === 0) return { called: false };

  const jevRequest: V1JevRequest<E> = {
    requestId: request.requestId,
    endpoint,
    request: request as V1JevRequest<E>["request"],
    attempts,
    candidates,
    rubric: GENERIC_CODING_RUBRIC,
  };

  const outcome = await callJevJudge(jevRequest, {
    endpoint: env.JEV_API_ENDPOINT,
    apiKey: env.JEV_API_KEY,
    model: env.JEV_MODEL,
    // Keep this well inside a Worker's request budget: one retry, short backoff.
    retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 1000 },
  });

  if (!outcome.ok) return { called: true, ok: false, error: outcome.error };

  const winningCandidate = candidates.find((candidate) => candidate.id === outcome.response.winnerCandidateId);
  if (!winningCandidate) {
    return {
      called: true,
      ok: false,
      error: {
        code: "judge_error",
        message: "Jev selected a candidate id that could not be matched back to a response",
        status: 502,
      },
    };
  }

  return { called: true, ok: true, response: winningCandidate.response };
}

function createErrorResponse(error: V1Error): V1ErrorResponse {
  return { error };
}

function mapErrorToV1(error: unknown): V1Error {
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("API key") || message.includes("authentication") || message.includes("unauthorized")) {
      return {
        code: "authentication_failed",
        message: "Authentication failed",
        status: 401,
      };
    }
    if (message.includes("rate limit") || message.includes("429")) {
      return {
        code: "provider_error",
        message: "Rate limited by upstream provider",
        status: 429,
        retryable: true,
      };
    }
    if (message.includes("network") || message.includes("timeout") || message.includes("ECONNREFUSED")) {
      return {
        code: "provider_error",
        message: "Upstream provider unavailable",
        status: 503,
        retryable: true,
      };
    }
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Internal server error",
    status: 500,
  };
}

async function handleV1Request(
  c: any,
  endpoint: V1Endpoint,
  body: V1RequestBody
): Promise<Response> {
  try {
    const env: V1ApiBindings = c.env ?? {};
    const rawBody = await c.req.json();
    const validatedRequest = validateRequestBody(rawBody, endpoint);
    const parsedConfigs = modelConfigSchema.array().optional().parse(rawBody.modelConfigs);
    const bodyModelConfigs = normalizeModelConfigs(parsedConfigs);
    const modelConfigs = bodyModelConfigs.length ? bodyModelConfigs : parseModelConfigsEnv(env.MODEL_CONFIGS);

    const graph = buildV1Graph(env);
    const routes = modelConfigs.length
      ? modelConfigs
      : defaultModelRoutes([validatedRequest.model]);

    const result = await graph.invoke({
      request: JSON.stringify(validatedRequest),
      models: [validatedRequest.model],
      modelConfigs: routes,
      workers: [],
      candidates: [],
      winner: null,
      judgeNotes: [],
      interventionCycles: 0,
    }, { configurable: { thread_id: validatedRequest.requestId } });

    const winner = result.winner;

    const jevOutcome = await runJevJudge(env, result.workers ?? [], endpoint, validatedRequest);
    if (jevOutcome.called) {
      if (jevOutcome.ok) {
        return c.json(jevOutcome.response);
      }

      const onFailure = env.JEV_ON_FAILURE === "error" ? "error" : "fallback";
      if (onFailure === "error") {
        return c.json(createErrorResponse(jevOutcome.error), jevOutcome.error.status);
      }
      // fallback mode: fall through and serve the local-heuristic winner below.
    }

    if (!winner) {
      const v1Error: V1Error = {
        code: "no_viable_candidates",
        message: "No viable candidates from any provider",
        status: 502,
      };
      return c.json(createErrorResponse(v1Error), 502);
    }

    const response = buildWinnerResponse(winner, endpoint, validatedRequest);
    return c.json(response);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const v1Error: V1Error = {
        code: "invalid_request",
        message: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
        status: 400,
      };
      return c.json(createErrorResponse(v1Error), 400);
    }

    const v1Error = mapErrorToV1(err);
    return c.json(createErrorResponse(v1Error), v1Error.status);
  }
}

export function createV1Router() {
  const router = new Hono<{ Bindings: V1ApiBindings }>();

  router.post("/v1/responses", async (c) => {
    return handleV1Request(c, "responses", await c.req.json());
  });

  router.post("/v1/chat/completions", async (c) => {
    return handleV1Request(c, "chat/completions", await c.req.json());
  });

  router.post("/v1/messages", async (c) => {
    return handleV1Request(c, "messages", await c.req.json());
  });

  return router;
}

export type V1Router = ReturnType<typeof createV1Router>;