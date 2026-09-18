import type { ChatChunk, ChatRequest, ChatResponse, JevModel, TokenUsage } from "./types.js";
import { fetchOk, type RetryOptions } from "./errors.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";

export interface OpenAIModelOptions {
  apiKey: string;
  baseUrl?: string;
  logicalId?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export function createOpenAIModel(
  modelId: string,
  options: OpenAIModelOptions,
): JevModel {
  const { apiKey, baseUrl = OPENAI_API_BASE, logicalId, retry, fetch = globalThis.fetch } = options;

  return {
    provider: "openai",
    id: modelId,
    logicalId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: request.temperature,
              max_tokens: request.maxTokens,
              stream: true,
            }),
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
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") finishReason = "stop";
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;

          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
          if (!isRecord(choice)) continue;
          const delta = isRecord(choice.delta) ? choice.delta : undefined;
          if (typeof delta?.content === "string" && delta.content) {
            yield { contentDelta: delta.content };
          }
          if (typeof choice.finish_reason === "string") {
            finishReason = mapFinishReason(choice.finish_reason);
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: request.temperature,
              max_tokens: request.maxTokens,
              stream: false,
            }),
          }),
        retry,
      );

      const json: unknown = await response.json();
      if (!isRecord(json)) throw new Error("OpenAI returned an invalid response");
      const choices = Array.isArray(json.choices) ? json.choices : [];
      const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
      const message = isRecord(firstChoice?.message) ? firstChoice.message : undefined;
      const content = typeof message?.content === "string" ? message.content : "";
      const usage = parseTokenUsage(json.usage);

      return { content, usage };
    },
  };
}

function parseEventData(line: string): string | undefined {
  if (!line.toLowerCase().startsWith("data:")) return undefined;
  return line.slice(5).trim();
}

function mapFinishReason(reason: string): ChatChunk["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "error";
  }
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = Number(value.prompt_tokens);
  const outputTokens = Number(value.completion_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return { inputTokens, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
