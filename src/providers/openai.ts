/**
 * OpenAI provider — normalized to the JevModel interface.
 *
 * Borrowing the useful protocol logic from Monoize: streaming via SSE,
 * normalized content deltas, and retry/error/rate-limit handling.
 */

import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, JevModel, TokenUsage } from "./types.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";

export interface OpenAIModelOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createOpenAIModel(
  modelId: string,
  options: OpenAIModelOptions,
): JevModel {
  const { apiKey, baseUrl = OPENAI_API_BASE, fetch = globalThis.fetch } = options;

  return {
    provider: "openai",
    id: modelId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const response = await retryWithBackoff(() =>
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
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed: ${response.status} ${text}`);
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
          if (data === "[DONE]") {
            finishReason = "stop";
            continue;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (choice.delta?.content) {
            yield { contentDelta: choice.delta.content };
          }
          if (choice.finish_reason) {
            finishReason = mapFinishReason(choice.finish_reason);
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const response = await retryWithBackoff(() =>
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
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed: ${response.status} ${text}`);
      }

      const json: any = await response.json();
      const content = json.choices?.[0]?.message?.content ?? "";
      const usage: TokenUsage | undefined = json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined;

      return { content, usage };
    },
  };
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