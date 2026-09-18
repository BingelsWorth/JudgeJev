/**
 * Gemini provider — normalized to the JevModel interface.
 */

import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, JevModel, TokenUsage } from "./types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModelOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createGeminiModel(
  modelId: string,
  options: GeminiModelOptions,
): JevModel {
  const { apiKey, baseUrl = GEMINI_API_BASE, fetch = globalThis.fetch } = options;

  return {
    provider: "gemini",
    id: modelId,

    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const body = toGeminiRequest(request);

      const response = await retryWithBackoff(() =>
        fetch(`${baseUrl}/models/${request.model}:streamGenerateContent?key=${apiKey}`, {
          method: "POST",
          signal: request.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini request failed: ${response.status} ${text}`);
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

          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield { contentDelta: text };
          }
          if (parsed.candidates?.[0]?.finishReason) {
            finishReason = mapFinishReason(parsed.candidates[0].finishReason);
          }
        }
      }

      yield { contentDelta: "", finishReason: finishReason ?? "stop" };
    },

    async complete(request: ChatRequest): Promise<ChatResponse> {
      const body = toGeminiRequest(request);

      const response = await retryWithBackoff(() =>
        fetch(`${baseUrl}/models/${request.model}:generateContent?key=${apiKey}`, {
          method: "POST",
          signal: request.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini request failed: ${response.status} ${text}`);
      }

      const json: any = await response.json();
      const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const usage: TokenUsage | undefined = json.usageMetadata
        ? {
            inputTokens: json.usageMetadata.promptTokenCount ?? 0,
            outputTokens: json.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined;

      return { content, usage };
    },
  };
}

function toGeminiRequest(request: ChatRequest): any {
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