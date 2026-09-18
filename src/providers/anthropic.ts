/**
 * Anthropic provider — normalized to the JevModel interface.
 */

import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, JevModel, TokenUsage } from "./types.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicModelOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createAnthropicModel(
  modelId: string,
  options: AnthropicModelOptions,
): JevModel {
  const { apiKey, baseUrl = ANTHROPIC_API_BASE, fetch = globalThis.fetch } = options;

  return {
    provider: "anthropic",
    id: modelId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const { system, messages } = splitSystem(request.messages);

      const response = await retryWithBackoff(() =>
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
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic request failed: ${response.status} ${text}`);
      }

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

          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield { contentDelta: parsed.delta.text };
          }
          if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
            finishReason = mapFinishReason(parsed.delta.stop_reason);
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const { system, messages } = splitSystem(request.messages);

      const response = await retryWithBackoff(() =>
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
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic request failed: ${response.status} ${text}`);
      }

      const json: any = await response.json();
      const content = json.content?.[0]?.text ?? "";
      const usage: TokenUsage | undefined = json.usage
        ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
        : undefined;

      return { content, usage };
    },
  };
}

function splitSystem(messages: ChatMessage[]): { system?: string; messages: ChatMessage[] } {
  let system: string | undefined;
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = m.content;
    } else {
      rest.push(m);
    }
  }
  return { system, messages: rest };
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

async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}