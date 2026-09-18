/**
 * Normalized provider types for Judge Jev.
 *
 * All model providers (OpenAI, Anthropic, Gemini) are normalized into a
 * single `JevModel` interface so the rest of the service can talk to models
 * without caring about provider-specific protocol quirks.
 */

export type ProviderId = "openai" | "anthropic" | "gemini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatChunk {
  contentDelta: string;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "error";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  content: string;
  usage?: TokenUsage;
}

export interface WorkerCheckpoint {
  /** What the model thinks the task is. */
  taskInterpretation?: string;
  /** Approach the model is taking. */
  approach?: string;
  /** Assumptions the model is making. */
  assumptions?: string[];
  /** Progress made so far. */
  progress?: string;
}

export interface JevModel {
  provider: ProviderId;
  id: string;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
  complete(request: ChatRequest): Promise<ChatResponse>;
}