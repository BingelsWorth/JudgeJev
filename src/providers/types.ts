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

export interface JevModel {
  provider: ProviderId;
  id: string;
  logicalId?: string;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
  complete(request: ChatRequest): Promise<ChatResponse>;
}
