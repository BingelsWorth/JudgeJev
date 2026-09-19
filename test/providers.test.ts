import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIModel,
  parseOpenAIChatCompletion,
  parseOpenAIResponsesCompletion,
  toResponsesRequestBody,
  type OpenAIModelOptions,
} from "../src/providers/openai.js";
import {
  createAnthropicModel,
  parseAnthropicMessagesCompletion,
  type AnthropicModelOptions,
} from "../src/providers/anthropic.js";
import {
  createGeminiModel,
  parseGeminiGenerateContent,
  convertGeminiToDownstream,
  type GeminiDownstreamProtocol,
  type GeminiModelOptions,
} from "../src/providers/gemini.js";
import {
  classifyRetryableFailure,
  isRetryableError,
  toProviderCompletionError,
  UpstreamError,
  type RetryOptions,
} from "../src/providers/errors.js";
import {
  normalizeProviderCompletion,
  normalizeProviderError,
  normalizeFinishReason,
  normalizeUsage,
} from "../src/providers/normalize.js";
import type {
  ProviderCompletion,
  ProviderCompletionError,
  V1CompletionRequest,
} from "../src/providers/types.js";
import type { V1Endpoint, V1ModelMetadata } from "../src/contracts.js";

function mockFetch(responseJson: unknown, status = 200): typeof fetch {
  return vi.fn(async (_input: RequestInfo, _init?: RequestInit) =>
    new Response(JSON.stringify(responseJson), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const noRetry: RetryOptions = { maxAttempts: 1, sleep: async () => {} };

function makeCompletionRequest(
  overrides: Partial<V1CompletionRequest> = {},
): V1CompletionRequest {
  return {
    model: "gpt-4o",
    logicalModel: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

const modelMeta: V1ModelMetadata = {
  logicalModel: "gpt-4o",
  upstreamModel: "gpt-4o",
  provider: "openai",
  routeId: "openai-default",
};

const openAIChatCompletion = {
  id: "chatcmpl-123",
  object: "chat.completion",
  created: 1720000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello! How can I help?" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
};

const openAIResponses = {
  id: "resp-123",
  object: "response",
  created_at: 1720000000,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg-123",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello! How can I help?" }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
};

const openAIResponsesIncomplete = {
  id: "resp-456",
  object: "response",
  created_at: 1720000000,
  model: "gpt-4o",
  status: "incomplete",
  output: [
    {
      type: "message",
      id: "msg-456",
      status: "incomplete",
      role: "assistant",
      content: [{ type: "output_text", text: "partial" }],
    },
  ],
};

const anthropicMessage = {
  id: "msg-123",
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "Hello! " },
    { type: "text", text: "How can I help?" },
  ],
  model: "claude-3-5-sonnet-latest",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 8 },
};

const anthropicMessageNoUsage = {
  id: "msg-456",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "No usage here" }],
  model: "claude-3-5-sonnet-latest",
  stop_reason: "max_tokens",
  stop_sequence: null,
};

const geminiResponse = {
  responseId: "gemini-123",
  modelVersion: "gemini-1.5-flash",
  createdAt: 1720000000,
  candidates: [
    {
      content: {
        parts: [{ text: "Hello! How can I help?" }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 8,
    totalTokenCount: 18,
  },
};

const geminiResponseNoUsage = {
  candidates: [
    {
      content: { parts: [{ text: "No usage" }] },
      finishReason: "MAX_TOKENS",
    },
  ],
};

describe("OpenAI provider", () => {
  describe("parseOpenAIChatCompletion", () => {
    it("extracts content, usage, and finishReason from a chat completion response", () => {
      const result = parseOpenAIChatCompletion(openAIChatCompletion, makeCompletionRequest(), "gpt-4o");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.id).toBe("chatcmpl-123");
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
      expect(result.provider).toBe("openai");
      expect(result.upstreamModel).toBe("gpt-4o");
      expect(result.raw).toBe(openAIChatCompletion);
    });

    it("returns undefined usage when usage is missing", () => {
      const noUsage = { ...openAIChatCompletion, usage: undefined };
      const result = parseOpenAIChatCompletion(noUsage, makeCompletionRequest(), "gpt-4o");
      expect(result.usage).toBeUndefined();
    });

    it("returns undefined finishReason when finish_reason is null", () => {
      const nullReason = {
        ...openAIChatCompletion,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: null }],
      };
      const result = parseOpenAIChatCompletion(nullReason, makeCompletionRequest(), "gpt-4o");
      expect(result.finishReason).toBeUndefined();
    });

    it("returns empty content when message.content is missing", () => {
      const emptyContent = {
        ...openAIChatCompletion,
        choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
      };
      const result = parseOpenAIChatCompletion(emptyContent, makeCompletionRequest(), "gpt-4o");
      expect(result.content).toBe("");
    });

    it("throws on a non-object response", () => {
      expect(() => parseOpenAIChatCompletion("not an object", makeCompletionRequest(), "gpt-4o")).toThrow(
        "invalid response",
      );
    });

    it("handles missing choices array gracefully", () => {
      const result = parseOpenAIChatCompletion(
        { id: "c1", object: "chat.completion", created: 0, model: "gpt-4o" },
        makeCompletionRequest(),
        "gpt-4o",
      );
      expect(result.content).toBe("");
      expect(result.finishReason).toBeUndefined();
    });
  });

  describe("parseOpenAIResponsesCompletion", () => {
    it("extracts content from the responses output array", () => {
      const result = parseOpenAIResponsesCompletion(openAIResponses, makeCompletionRequest(), "gpt-4o");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.id).toBe("resp-123");
      expect(result.provider).toBe("openai");
      expect(result.upstreamModel).toBe("gpt-4o");
      expect(result.raw).toBe(openAIResponses);
    });

    it("sets finishReason to length when status is incomplete", () => {
      const result = parseOpenAIResponsesCompletion(
        openAIResponsesIncomplete,
        makeCompletionRequest(),
        "gpt-4o",
      );
      expect(result.finishReason).toBe("length");
    });

    it("leaves finishReason undefined when status is completed", () => {
      const result = parseOpenAIResponsesCompletion(openAIResponses, makeCompletionRequest(), "gpt-4o");
      expect(result.finishReason).toBeUndefined();
    });

    it("parses usage from the responses format", () => {
      const result = parseOpenAIResponsesCompletion(openAIResponses, makeCompletionRequest(), "gpt-4o");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
    });

    it("throws on a non-object response", () => {
      expect(() =>
        parseOpenAIResponsesCompletion(42, makeCompletionRequest(), "gpt-4o"),
      ).toThrow("invalid response");
    });
  });

  describe("toResponsesRequestBody", () => {
    it("converts messages into the responses input format", () => {
      const request = makeCompletionRequest({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
        protocol: "openai_responses",
      });
      const body = toResponsesRequestBody(request);
      expect(body.input).toEqual([
        { type: "message", role: "developer", content: "You are helpful" },
        { type: "message", role: "user", content: "Hi" },
        { type: "message", role: "assistant", content: "Hello" },
      ]);
      expect(body.instructions).toBe("You are helpful");
    });
  });

  describe("completeV1", () => {
    it("calls /chat/completions for the chat completions protocol", async () => {
      const fetchMock = mockFetch(openAIChatCompletion);
      const model = createOpenAIModel("gpt-4o", {
        apiKey: "key",
        baseUrl: "https://api.openai.com/v1",
        fetch: fetchMock,
        retry: noRetry,
      });
      const result = await model.completeV1!(
        makeCompletionRequest({ protocol: "openai_chat_completions", endpoint: "chat/completions" }),
      );
      const calledUrl = vi.mocked(fetchMock).mock.calls[0][0];
      expect(calledUrl).toContain("/chat/completions");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.finishReason).toBe("stop");
    });

    it("calls /v1/responses for the responses protocol", async () => {
      const fetchMock = mockFetch(openAIResponses);
      const model = createOpenAIModel("gpt-4o", {
        apiKey: "key",
        fetch: fetchMock,
        retry: noRetry,
      });
      const result = await model.completeV1!(
        makeCompletionRequest({ protocol: "openai_responses", endpoint: "responses" }),
      );
      const calledUrl = vi.mocked(fetchMock).mock.calls[0][0];
      expect(calledUrl).toContain("/v1/responses");
      expect(result.content).toBe("Hello! How can I help?");
    });
  });
});

describe("Anthropic provider", () => {
  describe("parseAnthropicMessagesCompletion", () => {
    it("extracts and concatenates text from content blocks", () => {
      const result = parseAnthropicMessagesCompletion(
        anthropicMessage,
        makeCompletionRequest({ protocol: "anthropic_messages" }),
        "claude-3-5-sonnet-latest",
      );
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.id).toBe("msg-123");
      expect(result.finishReason).toBe("end_turn");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
      expect(result.provider).toBe("anthropic");
      expect(result.upstreamModel).toBe("claude-3-5-sonnet-latest");
      expect(result.raw).toBe(anthropicMessage);
    });

    it("maps max_tokens stop_reason as finishReason", () => {
      const result = parseAnthropicMessagesCompletion(
        anthropicMessageNoUsage,
        makeCompletionRequest({ protocol: "anthropic_messages" }),
        "claude-3-5-sonnet",
      );
      expect(result.finishReason).toBe("max_tokens");
      expect(result.usage).toBeUndefined();
    });

    it("ignores non-text content blocks", () => {
      const mixed = {
        ...anthropicMessage,
        content: [
          { type: "text", text: "text only" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      };
      const result = parseAnthropicMessagesCompletion(
        mixed,
        makeCompletionRequest({ protocol: "anthropic_messages" }),
        "claude",
      );
      expect(result.content).toBe("text only");
    });

    it("throws on a non-object response", () => {
      expect(() =>
        parseAnthropicMessagesCompletion(null, makeCompletionRequest(), "claude"),
      ).toThrow("invalid response");
    });

    it("handles missing content array", () => {
      const result = parseAnthropicMessagesCompletion(
        { id: "m1", type: "message", role: "assistant", model: "claude" },
        makeCompletionRequest(),
        "claude",
      );
      expect(result.content).toBe("");
      expect(result.finishReason).toBeUndefined();
    });
  });

  describe("completeV1", () => {
    it("calls /v1/messages and returns parsed completion", async () => {
      const fetchMock = mockFetch(anthropicMessage);
      const model = createAnthropicModel("claude-3-5-sonnet-latest", {
        apiKey: "key",
        fetch: fetchMock,
        retry: noRetry,
      });
      const result = await model.completeV1!(
        makeCompletionRequest({ protocol: "anthropic_messages", endpoint: "messages" }),
      );
      const calledUrl = vi.mocked(fetchMock).mock.calls[0][0];
      expect(calledUrl).toContain("/v1/messages");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.finishReason).toBe("end_turn");
    });
  });
});

describe("Gemini provider", () => {
  describe("parseGeminiGenerateContent", () => {
    it("extracts text, usage, and finishReason from Gemini native format", () => {
      const result = parseGeminiGenerateContent(
        geminiResponse,
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
        "gemini-1.5-flash",
      );
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.id).toBe("gemini-123");
      expect(result.finishReason).toBe("STOP");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 8 });
      expect(result.provider).toBe("gemini");
      expect(result.upstreamModel).toBe("gemini-1.5-flash");
    });

    it("returns native Gemini raw when no protocol is set", () => {
      const result = parseGeminiGenerateContent(
        geminiResponse,
        makeCompletionRequest({ protocol: undefined }),
        "gemini-1.5-flash",
      );
      expect(result.raw).toBe(geminiResponse);
    });

    it("returns native Gemini raw when protocol is undefined", () => {
      const chatRequest = {
        model: "gemini-1.5-flash",
        messages: [{ role: "user", content: "Hi" }],
      };
      const result = parseGeminiGenerateContent(geminiResponse, chatRequest as V1CompletionRequest, "gemini-1.5-flash");
      expect(result.raw).toBe(geminiResponse);
    });

    it("parses usage from usageMetadata with defaults", () => {
      const result = parseGeminiGenerateContent(
        geminiResponseNoUsage,
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
        "gemini-1.5-flash",
      );
      expect(result.usage).toBeUndefined();
    });

    it("throws on a non-object response", () => {
      expect(() =>
        parseGeminiGenerateContent("string", makeCompletionRequest(), "gemini-1.5-flash"),
      ).toThrow("invalid response");
    });

    it("handles missing candidates array", () => {
      const result = parseGeminiGenerateContent(
        { responseId: "r1" },
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
        "gemini-1.5-flash",
      );
      expect(result.content).toBe("");
      expect(result.finishReason).toBeUndefined();
    });
  });

  describe("convertGeminiToDownstream", () => {
    it("converts to openai_chat_completions format", () => {
      const completion = parseGeminiGenerateContent(
        geminiResponse,
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
        "gemini-1.5-flash",
      );
      const raw = completion.raw as Record<string, any>;
      expect(raw.object).toBe("chat.completion");
      expect(raw.choices[0].message.content).toBe("Hello! How can I help?");
      expect(raw.choices[0].finish_reason).toBe("stop");
      expect(raw.usage.prompt_tokens).toBe(10);
      expect(raw.usage.completion_tokens).toBe(8);
    });

    it("converts to anthropic_messages format", () => {
      const completion = parseGeminiGenerateContent(
        geminiResponse,
        makeCompletionRequest({ protocol: "anthropic_messages" }),
        "gemini-1.5-flash",
      );
      const raw = completion.raw as Record<string, any>;
      expect(raw.type).toBe("message");
      expect(raw.role).toBe("assistant");
      expect(raw.content[0].text).toBe("Hello! How can I help?");
      expect(raw.stop_reason).toBe("end_turn");
      expect(raw.usage.input_tokens).toBe(10);
      expect(raw.usage.output_tokens).toBe(8);
    });

    it("converts to openai_responses format", () => {
      const completion = parseGeminiGenerateContent(
        geminiResponse,
        makeCompletionRequest({ protocol: "openai_responses" }),
        "gemini-1.5-flash",
      );
      const raw = completion.raw as Record<string, any>;
      expect(raw.object).toBe("response");
      expect(raw.status).toBe("completed");
      expect(raw.output[0].content[0].text).toBe("Hello! How can I help?");
      expect(raw.usage.input_tokens).toBe(10);
      expect(raw.usage.output_tokens).toBe(8);
    });

    it("maps MAX_TOKENS finish reason to length for chat completions", () => {
      const response = {
        ...geminiResponse,
        candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
      };
      const completion = parseGeminiGenerateContent(
        response,
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
        "gemini-1.5-flash",
      );
      const raw = completion.raw as Record<string, any>;
      expect(raw.choices[0].finish_reason).toBe("length");
    });
  });

  describe("completeV1", () => {
    it("calls generateContent and converts to downstream format", async () => {
      const fetchMock = mockFetch(geminiResponse);
      const model = createGeminiModel("gemini-1.5-flash", {
        apiKey: "key",
        fetch: fetchMock,
        retry: noRetry,
      });
      const result = await model.completeV1!(
        makeCompletionRequest({ protocol: "openai_chat_completions" }),
      );
      const calledUrl = vi.mocked(fetchMock).mock.calls[0][0];
      expect(String(calledUrl)).toContain(":generateContent");
      expect(result.content).toBe("Hello! How can I help?");
      const raw = result.raw as Record<string, any>;
      expect(raw.object).toBe("chat.completion");
    });
  });
});

describe("Malformed responses", () => {
  it("OpenAI parser throws on null", () => {
    expect(() => parseOpenAIChatCompletion(null, makeCompletionRequest(), "gpt-4o")).toThrow("invalid response");
  });

  it("Anthropic parser throws on array", () => {
    expect(() => parseAnthropicMessagesCompletion([], makeCompletionRequest(), "claude")).toThrow("invalid response");
  });

  it("Gemini parser throws on number", () => {
    expect(() => parseGeminiGenerateContent(42, makeCompletionRequest(), "gemini")).toThrow("invalid response");
  });

  it("OpenAI responses parser throws on undefined", () => {
    expect(() => parseOpenAIResponsesCompletion(undefined, makeCompletionRequest(), "gpt-4o")).toThrow("invalid response");
  });
});

describe("Usage parsing", () => {
  it("parses valid OpenAI usage", () => {
    const result = parseOpenAIChatCompletion(
      { id: "c", object: "chat.completion", created: 0, model: "gpt-4o", usage: { prompt_tokens: 5, completion_tokens: 3 } },
      makeCompletionRequest(),
      "gpt-4o",
    );
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("returns undefined for non-numeric OpenAI usage", () => {
    const result = parseOpenAIChatCompletion(
      { id: "c", object: "chat.completion", created: 0, model: "gpt-4o", usage: { prompt_tokens: "bad" } },
      makeCompletionRequest(),
      "gpt-4o",
    );
    expect(result.usage).toBeUndefined();
  });

  it("returns undefined for non-object usage in Anthropic", () => {
    const result = parseAnthropicMessagesCompletion(
      { id: "m", type: "message", role: "assistant", content: [], model: "claude", usage: "bad" },
      makeCompletionRequest(),
      "claude",
    );
    expect(result.usage).toBeUndefined();
  });

  it("parses valid Gemini usageMetadata", () => {
    const result = parseGeminiGenerateContent(
      { responseId: "r", candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } },
      makeCompletionRequest({ protocol: undefined }),
      "gemini",
    );
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

describe("Failure classification", () => {
  describe("classifyRetryableFailure", () => {
    it("classifies 429 as rate_limited", () => {
      expect(classifyRetryableFailure(429)).toBe("rate_limited");
    });

    it("classifies 500 as transient", () => {
      expect(classifyRetryableFailure(500)).toBe("transient");
    });

    it("classifies 401 as persistent", () => {
      expect(classifyRetryableFailure(401)).toBe("persistent");
    });

    it("classifies 404 as persistent", () => {
      expect(classifyRetryableFailure(404)).toBe("persistent");
    });

    it("classifies 408 as transient", () => {
      expect(classifyRetryableFailure(408)).toBe("transient");
    });

    it("classifies rate_limit error type as rate_limited", () => {
      expect(classifyRetryableFailure(undefined, undefined, "rate_limit")).toBe("rate_limited");
    });
  });

  describe("isRetryableError", () => {
    it("returns false for AbortError", () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      expect(isRetryableError(abort)).toBe(false);
    });

    it("returns true for a generic Error (persistent but still retried in some paths)", () => {
      expect(isRetryableError(new Error("boom"))).toBe(true);
    });

    it("returns the retryable flag for UpstreamError", () => {
      expect(isRetryableError(new UpstreamError("too many", { status: 429 }))).toBe(true);
      expect(isRetryableError(new UpstreamError("unauthorized", { status: 401 }))).toBe(false);
    });
  });

  describe("toProviderCompletionError", () => {
    it("maps 429 as rate_limited", () => {
      const err = new UpstreamError("Too many requests", { status: 429, code: "rate_limited" });
      const result = toProviderCompletionError(err, "openai", "gpt-4o");
      expect(result.code).toBe("rate_limited");
      expect(result.retryable).toBe(true);
      expect(result.status).toBe(429);
      expect(result.provider).toBe("openai");
      expect(result.upstreamModel).toBe("gpt-4o");
    });

    it("maps 401 as authentication_error", () => {
      const err = new UpstreamError("Unauthorized", { status: 401, code: "authentication_error" });
      const result = toProviderCompletionError(err, "anthropic", "claude");
      expect(result.code).toBe("authentication_error");
      expect(result.retryable).toBe(false);
    });

    it("maps 404 as unsupported_model", () => {
      const err = new UpstreamError("Not found", { status: 404, code: "model_not_found" });
      const result = toProviderCompletionError(err, "openai", "gpt-4o");
      expect(result.code).toBe("unsupported_model");
      expect(result.retryable).toBe(false);
    });

    it("maps 500 as upstream_error (retryable)", () => {
      const err = new UpstreamError("Server error", { status: 503, code: "server_error" });
      const result = toProviderCompletionError(err, "gemini", "gemini-pro");
      expect(result.code).toBe("upstream_error");
      expect(result.retryable).toBe(true);
      expect(result.status).toBe(503);
    });

    it("maps generic Error as network_error", () => {
      const result = toProviderCompletionError(new Error("connection refused"), "openai", "gpt-4o");
      expect(result.code).toBe("network_error");
      expect(result.retryable).toBe(true);
      expect(result.message).toBe("connection refused");
    });

    it("maps AbortError as timeout (non-retryable)", () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      const result = toProviderCompletionError(abort, "anthropic", "claude");
      expect(result.code).toBe("timeout");
      expect(result.retryable).toBe(false);
    });

    it("maps unknown string errors as network_error", () => {
      const result = toProviderCompletionError("something went wrong", "gemini", "gemini-pro");
      expect(result.code).toBe("network_error");
      expect(result.retryable).toBe(true);
      expect(result.message).toBe("something went wrong");
    });

    it("maps 422 as upstream_error", () => {
      const err = new UpstreamError("Unprocessable", { status: 422 });
      const result = toProviderCompletionError(err, "openai", "gpt-4o");
      expect(result.code).toBe("upstream_error");
    });
  });
});

describe("Normalize functions", () => {
  describe("normalizeUsage", () => {
    it("converts TokenUsage to V1Usage with totalTokens", () => {
      const result = normalizeUsage({ inputTokens: 10, outputTokens: 8 });
      expect(result).toEqual({ inputTokens: 10, outputTokens: 8, totalTokens: 18 });
    });

    it("returns undefined when usage is missing", () => {
      expect(normalizeUsage(undefined)).toBeUndefined();
    });

    it("returns undefined for non-finite token values", () => {
      expect(normalizeUsage({ inputTokens: NaN, outputTokens: 8 })).toBeUndefined();
    });
  });

  describe("normalizeFinishReason", () => {
    it("passes through OpenAI finish reasons for chat/completions", () => {
      expect(normalizeFinishReason("stop", "chat/completions")).toBe("stop");
      expect(normalizeFinishReason("length", "chat/completions")).toBe("length");
      expect(normalizeFinishReason("tool_calls", "chat/completions")).toBe("tool_calls");
      expect(normalizeFinishReason("content_filter", "chat/completions")).toBe("content_filter");
    });

    it("normalizes Gemini STOP to stop for chat/completions", () => {
      expect(normalizeFinishReason("STOP", "chat/completions")).toBe("stop");
    });

    it("normalizes Gemini MAX_TOKENS to length for chat/completions", () => {
      expect(normalizeFinishReason("MAX_TOKENS", "chat/completions")).toBe("length");
    });

    it("passes through Anthropic finish reasons for messages", () => {
      expect(normalizeFinishReason("end_turn", "messages")).toBe("end_turn");
      expect(normalizeFinishReason("max_tokens", "messages")).toBe("max_tokens");
      expect(normalizeFinishReason("stop_sequence", "messages")).toBe("stop_sequence");
    });

    it("normalizes Gemini STOP to end_turn for messages", () => {
      expect(normalizeFinishReason("STOP", "messages")).toBe("end_turn");
    });

    it("returns undefined when finishReason is missing", () => {
      expect(normalizeFinishReason(undefined, "chat/completions")).toBeUndefined();
    });
  });

  describe("normalizeProviderCompletion", () => {
    it("builds a V1Candidate for the responses endpoint", () => {
      const completion: ProviderCompletion = {
        id: "resp-1",
        content: "const add = (a, b) => a + b;",
        usage: { inputTokens: 12, outputTokens: 9 },
        finishReason: "stop",
        provider: "openai",
        upstreamModel: "gpt-4o",
        logicalModel: "gpt-4o",
        raw: openAIResponses,
      };
      const candidate = normalizeProviderCompletion(completion, {
        requestId: "run-123",
        endpoint: "responses",
        id: "candidate-1",
        model: modelMeta,
      });
      expect(candidate.status).toBe("succeeded");
      expect(candidate.requestId).toBe("run-123");
      expect(candidate.endpoint).toBe("responses");
      expect(candidate.protocol).toBe("openai_responses");
      expect(candidate.content).toBe("const add = (a, b) => a + b;");
      expect(candidate.usage).toEqual({ inputTokens: 12, outputTokens: 9, totalTokens: 21 });
      expect(candidate.finishReason).toBe("stop");
      expect(candidate.response).toBe(openAIResponses);
    });

    it("builds a V1Candidate for the chat/completions endpoint", () => {
      const completion: ProviderCompletion = {
        id: "chat-1",
        content: "hello",
        usage: { inputTokens: 5, outputTokens: 3 },
        finishReason: "stop",
        provider: "openai",
        upstreamModel: "gpt-4o",
        raw: openAIChatCompletion,
      };
      const candidate = normalizeProviderCompletion(completion, {
        requestId: "run-123",
        endpoint: "chat/completions",
        id: "candidate-chat",
        model: modelMeta,
        durationMs: 150,
        metadata: { latency: "fast" },
      });
      expect(candidate.protocol).toBe("openai_chat_completions");
      expect(candidate.durationMs).toBe(150);
      expect(candidate.metadata).toEqual({ latency: "fast" });
      expect(candidate.model).toEqual(modelMeta);
    });

    it("builds a V1Candidate for the messages endpoint", () => {
      const completion: ProviderCompletion = {
        id: "msg-1",
        content: "hello",
        finishReason: "end_turn",
        provider: "anthropic",
        upstreamModel: "claude-3-5",
        raw: anthropicMessage,
      };
      const candidate = normalizeProviderCompletion(completion, {
        requestId: "run-123",
        endpoint: "messages",
        id: "candidate-msg",
        model: { ...modelMeta, provider: "anthropic", upstreamModel: "claude-3-5" },
      });
      expect(candidate.protocol).toBe("anthropic_messages");
      expect(candidate.finishReason).toBe("end_turn");
      expect(candidate.usage).toBeUndefined();
    });
  });

  describe("normalizeProviderError", () => {
    it("builds a V1FailedAttempt with the normalized error", () => {
      const err = new UpstreamError("Unauthorized", { status: 401, code: "authentication_error" });
      const attempt = normalizeProviderError(err, "openai" as never, "gpt-4o", {
        requestId: "run-123",
        endpoint: "chat/completions",
        id: "attempt-failed",
        model: modelMeta,
      });
      expect(attempt.status).toBe("failed");
      expect(attempt.requestId).toBe("run-123");
      expect(attempt.endpoint).toBe("chat/completions");
      expect(attempt.protocol).toBe("openai_chat_completions");
      expect(attempt.error.code).toBe("authentication_error");
      expect(attempt.error.retryable).toBe(false);
      expect(attempt.error.status).toBe(401);
      expect(attempt.error.provider).toBe("openai");
      expect(attempt.error.upstreamModel).toBe("gpt-4o");
      expect(attempt.error.attemptId).toBe("attempt-failed");
    });

    it("handles generic errors as network_error", () => {
      const attempt = normalizeProviderError(new Error("boom"), "anthropic" as never, "claude", {
        requestId: "run-123",
        endpoint: "messages",
        id: "attempt-err",
        model: { ...modelMeta, provider: "anthropic", upstreamModel: "claude" },
      });
      expect(attempt.error.code).toBe("network_error");
      expect(attempt.error.message).toBe("boom");
      expect(attempt.protocol).toBe("anthropic_messages");
    });
  });

});
