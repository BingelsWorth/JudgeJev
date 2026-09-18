import type { ChatChunk, ChatRequest, ChatResponse, JevModel, TokenUsage, V1CompletionRequest, ProviderCompletion } from "./types.js";
import { fetchOk, type RetryOptions } from "./errors.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModelOptions {
  apiKey: string;
  baseUrl?: string;
  logicalId?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export function createGeminiModel(
  modelId: string,
  options: GeminiModelOptions,
): JevModel {
  const { apiKey, baseUrl = GEMINI_API_BASE, logicalId, retry, fetch = globalThis.fetch } = options;

  return {
    provider: "gemini",
    id: modelId,
    logicalId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const body = toGeminiRequest(request);
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`, {
            method: "POST",
            signal: request.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        retry,
      );

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: ChatChunk["finishReason"];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          const data = parseEventData(line);
          if (!data) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;

          const candidate = Array.isArray(parsed.candidates) ? parsed.candidates[0] : undefined;
          if (!isRecord(candidate)) continue;
          const content = isRecord(candidate.content) ? candidate.content : undefined;
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (const part of parts) {
            if (isRecord(part) && typeof part.text === "string" && part.text) {
              yield { contentDelta: part.text };
            }
          }
          if (typeof candidate.finishReason === "string") {
            finishReason = mapFinishReason(candidate.finishReason);
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const body = toGeminiRequest(request);
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`, {
            method: "POST",
            signal: request.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        retry,
      );

      const json: unknown = await response.json();
      const parsed = parseGeminiGenerateContent(json, request, modelId);
      return { content: parsed.content, usage: parsed.usage };
    },

    async completeV1(request: V1CompletionRequest): Promise<ProviderCompletion> {
      const body = toGeminiRequest(request);
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`, {
            method: "POST",
            signal: request.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        retry,
      );

      const json: unknown = await response.json();
      return parseGeminiGenerateContent(json, request, modelId);
    },
  };
}

export function parseGeminiGenerateContent(
  json: unknown,
  request: V1CompletionRequest,
  modelId: string,
): ProviderCompletion {
  if (!isRecord(json)) throw new Error("Gemini returned an invalid response");
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const firstCandidate = isRecord(candidates[0]) ? candidates[0] : undefined;
  const content = isRecord(firstCandidate?.content) ? firstCandidate.content : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
  const finishReason = typeof firstCandidate?.finishReason === "string" ? firstCandidate.finishReason : undefined;
  const usage = parseTokenUsage(json.usageMetadata);

  const raw = request.protocol
    ? convertGeminiToDownstream(json, text, finishReason, usage, request.protocol, request.model)
    : json;

  return {
    id: typeof json.responseId === "string" ? json.responseId : undefined,
    content: text,
    usage,
    finishReason,
    provider: "gemini",
    upstreamModel: modelId,
    logicalModel: request.logicalModel,
    raw,
  };
}

export type GeminiDownstreamProtocol = "openai_responses" | "openai_chat_completions" | "anthropic_messages";

export function convertGeminiToDownstream(
  json: Record<string, unknown>,
  content: string,
  finishReason: string | undefined,
  usage: TokenUsage | undefined,
  protocol: GeminiDownstreamProtocol,
  model: string,
): Record<string, unknown> {
  const id = typeof json.responseId === "string" ? json.responseId : `gemini-${randomId()}`;
  const modelVersion = typeof json.modelVersion === "string" ? json.modelVersion : model;
  const createdAt = typeof json.createdAt === "number" ? json.createdAt : Math.floor(Date.now() / 1000);
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  const totalTokens = Number.isFinite(promptTokens + completionTokens)
    ? promptTokens + completionTokens
    : undefined;

  switch (protocol) {
    case "openai_responses":
      return {
        id,
        object: "response",
        created_at: createdAt,
        model: modelVersion,
        status: "completed",
        output: [
          {
            type: "message",
            id,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: content }],
          },
        ],
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
    case "openai_chat_completions":
      return {
        id,
        object: "chat.completion",
        created: createdAt,
        model: modelVersion,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: mapGeminiToOpenAIFinishReason(finishReason),
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
    case "anthropic_messages":
      return {
        id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: content }],
        model: modelVersion,
        stop_reason: mapGeminiToAnthropicFinishReason(finishReason),
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens,
        },
      };
  }
}

function mapGeminiToOpenAIFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
    case "FINISHED":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}

function mapGeminiToAnthropicFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
    case "FINISHED":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseEventData(line: string): string | undefined {
  if (line.toLowerCase().startsWith("data:")) return line.slice(5).trim();
  return line || undefined;
}

function toGeminiRequest(request: ChatRequest): Record<string, unknown> {
  const systemInstruction = request.messages.find((m) => m.role === "system")?.content;
  const contents = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  return {
    contents,
    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
    },
  };
}

function mapFinishReason(reason: string): ChatChunk["finishReason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "error";
  }
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = Number(value.promptTokenCount ?? 0);
  const outputTokens = Number(value.candidatesTokenCount ?? 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return { inputTokens, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
