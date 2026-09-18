import type { V1AttemptErrorCode } from "../v1/contracts.js";

export type ProviderId = "openai" | "anthropic" | "gemini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  logicalModel?: string;
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
  taskInterpretation?: string;
  approach?: string;
  assumptions?: string[];
  progress?: string;
}

export interface V1CompletionRequest extends ChatRequest {
  protocol?: "openai_responses" | "openai_chat_completions" | "anthropic_messages";
  endpoint?: string;
}

export interface ProviderCompletion {
  id?: string;
  content: string;
  usage?: TokenUsage;
  finishReason?: string;
  provider: ProviderId;
  upstreamModel: string;
  logicalModel?: string;
  raw: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ProviderCompletionError {
  code: V1AttemptErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  provider: ProviderId;
  upstreamModel: string;
  details?: Record<string, unknown>;
}

export interface JevModel {
  provider: ProviderId;
  id: string;
  logicalId?: string;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
  complete(request: ChatRequest): Promise<ChatResponse>;
  completeV1?(request: V1CompletionRequest): Promise<ProviderCompletion>;
}