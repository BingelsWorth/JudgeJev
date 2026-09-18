import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, JevModel, TokenUsage } from "./types.js";
import { fetchOk, type RetryOptions } from "./errors.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicModelOptions {
  apiKey: string;
  baseUrl?: string;
  logicalId?: string;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export function createAnthropicModel(
  modelId: string,
  options: AnthropicModelOptions,
): JevModel {
  const { apiKey, baseUrl = ANTHROPIC_API_BASE, logicalId, retry, fetch = globalThis.fetch } = options;

  return {
    provider: "anthropic",
    id: modelId,
    logicalId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const { system, messages } = splitSystem(request.messages);
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model: request.model,
              messages,
              system,
              max_tokens: request.maxTokens ?? 1024,
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
          if (!data) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;

          if (parsed.type === "content_block_delta") {
            const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
            if (typeof delta?.text === "string" && delta.text) {
              yield { contentDelta: delta.text };
            }
          }
          if (parsed.type === "message_delta") {
            const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
            if (typeof delta?.stop_reason === "string") {
              finishReason = mapFinishReason(delta.stop_reason);
            }
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const { system, messages } = splitSystem(request.messages);
      const response = await fetchOk(
        () =>
          fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model: request.model,
              messages,
              system,
              max_tokens: request.maxTokens ?? 1024,
              stream: false,
            }),
          }),
        retry,
      );

      const json: unknown = await response.json();
      if (!isRecord(json)) throw new Error("Anthropic returned an invalid response");
      const contentBlocks = Array.isArray(json.content) ? json.content : [];
      const content = contentBlocks
        .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
        .join("");
      const usage = parseTokenUsage(json.usage);

      return { content, usage };
    },
  };
}

function splitSystem(messages: ChatMessage[]): { system?: string; messages: ChatMessage[] } {
  const systems: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(message.content);
    } else {
      rest.push(message);
    }
  }
  return { system: systems.join("\n\n") || undefined, messages: rest };
}

function parseEventData(line: string): string | undefined {
  if (!line.toLowerCase().startsWith("data:")) return undefined;
  return line.slice(5).trim();
}

function mapFinishReason(reason: string): ChatChunk["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    default:
      return "error";
  }
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = Number(value.input_tokens);
  const outputTokens = Number(value.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return { inputTokens, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
