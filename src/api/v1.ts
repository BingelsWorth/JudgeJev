import { Hono } from "hono";
import { z } from "zod";
import { buildJevGraph } from "../graph/jev-graph.js";
import type { ModelRoute } from "../providers/router.js";
import type { JevModel } from "../providers/types.js";
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
} from "../v1/contracts.js";

interface V1ApiBindings {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  JEV_API_ENDPOINT?: string;
  JEV_API_KEY?: string;
}

interface V1RouteConfig {
  logicalModel: string;
  provider: string;
  upstreamModel?: string;
  priority?: number;
  enabled?: boolean;
}

interface V1RequestBody {
  model?: string;
  models?: string[];
  modelConfigs?: V1RouteConfig[];
}

function getProviderApiKey(env: V1ApiBindings, provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY;
    default:
      return undefined;
  }
}

function buildV1Graph(env: V1ApiBindings) {
  return buildJevGraph({
    modelFactory: async (route: ModelRoute) => {
      const apiKey = getProviderApiKey(env, route.provider);
      if (!apiKey) {
        throw new Error(`No API key configured for provider: ${route.provider}`);
      }

      const { buildModel, configFromRoute } = await import("../providers/factory.js");
      return buildModel(configFromRoute(route, apiKey), {
        get: async (provider: string) => getProviderApiKey(env, provider) ?? "",
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

function normalizeModelConfigs(configs: V1RouteConfig[] | undefined): ModelRoute[] {
  return (configs ?? []).map((config) => ({
    logicalModel: config.logicalModel.trim(),
    provider: config.provider as "openai" | "anthropic" | "gemini",
    upstreamModel: (config.upstreamModel ?? config.logicalModel).trim(),
    priority: config.priority ?? 0,
    enabled: config.enabled ?? true,
  }));
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
    const validatedRequest = validateRequestBody(await c.req.json(), endpoint);
    const modelConfigs = normalizeModelConfigs(body.modelConfigs);

    const graph = buildV1Graph(c.env);
    const routes = modelConfigs.length
      ? modelConfigs
      : (await import("../providers/router.js")).defaultModelRoutes([validatedRequest.model]);

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