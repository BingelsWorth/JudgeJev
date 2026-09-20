import type { ProviderId } from "./providers/types.js";

export type V1ProviderId = ProviderId;

export type V1Endpoint = "responses" | "chat/completions" | "messages" | "completions";

export type V1Protocol =
  | "openai_responses"
  | "openai_chat_completions"
  | "anthropic_messages"
  | "openai_completions";

export type V1EndpointPath =
  | "/v1/responses"
  | "/v1/chat/completions"
  | "/v1/messages"
  | "/v1/completions";

export type V1ProtocolForEndpoint<E extends V1Endpoint> = E extends "responses"
  ? "openai_responses"
  : E extends "chat/completions"
    ? "openai_chat_completions"
    : E extends "completions"
      ? "openai_completions"
      : "anthropic_messages";

export type V1EndpointPathFor<E extends V1Endpoint> = E extends "responses"
  ? "/v1/responses"
  : E extends "chat/completions"
    ? "/v1/chat/completions"
    : E extends "completions"
      ? "/v1/completions"
      : "/v1/messages";

export interface V1DownstreamRequestBase<
  E extends V1Endpoint,
  P extends V1ProtocolForEndpoint<E>,
> {
  requestId: string;
  endpoint: E;
  protocol: P;
  model: string;
  stream?: false;
  extensions?: Record<string, unknown>;
}

export interface V1TextContentPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface V1ImageContentPart {
  type: "image" | "image_url";
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  image_url?: string | {
    url: string;
    detail?: "low" | "high" | "auto";
  };
  [key: string]: unknown;
}

export interface V1ContentPartExtension {
  type: string;
  [key: string]: unknown;
}

export type V1ContentPart = V1TextContentPart | V1ImageContentPart | V1ContentPartExtension;

export type V1MessageContent = string | V1ContentPart[] | null;

export interface V1ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content: V1MessageContent;
  name?: string;
  tool_call_id?: string;
}

export type V1ChatContentPart = V1TextContentPart | V1ImageContentPart | V1ContentPartExtension;

export type V1ChatMessageContent = string | V1ChatContentPart[] | null;

export interface V1ChatCompletionsRequest
  extends V1DownstreamRequestBase<"chat/completions", "openai_chat_completions"> {
  endpoint: "chat/completions";
  protocol: "openai_chat_completions";
  messages: V1ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  metadata?: Record<string, unknown>;
}

export interface V1AnthropicTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface V1AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  [key: string]: unknown;
}

export type V1AnthropicContentBlock =
  | V1AnthropicTextBlock
  | V1AnthropicImageBlock
  | V1ContentPartExtension;

export type V1AnthropicMessageContent = string | V1AnthropicContentBlock[];

export interface V1AnthropicMessage {
  role: "user" | "assistant";
  content: V1AnthropicMessageContent;
}

export interface V1MessagesRequest
  extends V1DownstreamRequestBase<"messages", "anthropic_messages"> {
  endpoint: "messages";
  protocol: "anthropic_messages";
  messages: V1AnthropicMessage[];
  system?: string | V1AnthropicContentBlock[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface V1ResponsesTextContentPart {
  type: "input_text";
  text: string;
  [key: string]: unknown;
}

export type V1ResponsesContentPart = V1ResponsesTextContentPart | V1ContentPartExtension;

export type V1ResponsesContent = string | V1ResponsesContentPart[];

export interface V1ResponsesMessageInput {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: V1ResponsesContent;
}

export interface V1ResponsesInputExtension {
  type: string;
  [key: string]: unknown;
}

export type V1ResponsesInputItem = V1ResponsesMessageInput | V1ResponsesInputExtension;

export type V1ResponsesInput = string | V1ResponsesInputItem[];

export interface V1ResponsesRequest
  extends V1DownstreamRequestBase<"responses", "openai_responses"> {
  endpoint: "responses";
  protocol: "openai_responses";
  input: V1ResponsesInput;
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Raw text continuation - no messages, no chat template, no thinking. Exists
 * for benchmarks like HumanEval whose task design assumes the backend can
 * pre-fill generation (see `benchmarks/accuracy.md`'s "why raw completions"
 * note) - a plain chat-completions endpoint can't serve those correctly.
 */
export interface V1CompletionsRequest
  extends V1DownstreamRequestBase<"completions", "openai_completions"> {
  endpoint: "completions";
  protocol: "openai_completions";
  prompt: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  metadata?: Record<string, unknown>;
}

export type V1DownstreamRequest =
  | V1ResponsesRequest
  | V1ChatCompletionsRequest
  | V1MessagesRequest
  | V1CompletionsRequest;

export interface V1Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  inputTokensDetails?: Record<string, number>;
  outputTokensDetails?: Record<string, number>;
  [key: string]: unknown;
}

export type V1OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

export type V1AnthropicFinishReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn";

export type V1FinishReason = V1OpenAIFinishReason | V1AnthropicFinishReason;

export type V1FinishReasonForProtocol<P extends V1Protocol> = P extends "anthropic_messages"
  ? V1AnthropicFinishReason
  : V1OpenAIFinishReason;

export interface V1ResponsesOutputText {
  type: "output_text";
  text: string;
  annotations?: unknown[];
  [key: string]: unknown;
}

export interface V1ResponsesMessageOutput {
  type: "message";
  id: string;
  status: "completed";
  role: "assistant";
  content: V1ResponsesOutputText[];
  [key: string]: unknown;
}

export interface V1ResponsesOutputExtension {
  type: string;
  [key: string]: unknown;
}

export type V1ResponsesOutput = V1ResponsesMessageOutput | V1ResponsesOutputExtension;

export interface V1ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed";
  output: V1ResponsesOutput[];
  usage?: V1Usage;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface V1ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  refusal?: string | null;
  [key: string]: unknown;
}

export interface V1ChatCompletionChoice {
  index: number;
  message: V1ChatCompletionMessage;
  finish_reason: V1OpenAIFinishReason | null;
  [key: string]: unknown;
}

export interface V1ChatCompletionsResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: V1ChatCompletionChoice[];
  usage?: V1Usage;
  service_tier?: string;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface V1MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: V1AnthropicContentBlock[];
  model: string;
  stop_reason: V1AnthropicFinishReason | null;
  stop_sequence: string | null;
  usage?: V1Usage;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface V1CompletionChoice {
  text: string;
  index: number;
  finish_reason: V1OpenAIFinishReason | null;
  [key: string]: unknown;
}

export interface V1CompletionsResponse {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: V1CompletionChoice[];
  usage?: V1Usage;
  [key: string]: unknown;
}

export type V1DownstreamResponse =
  | V1ResponsesResponse
  | V1ChatCompletionsResponse
  | V1MessagesResponse
  | V1CompletionsResponse;

export type V1RequestForProtocol<P extends V1Protocol> = P extends "openai_responses"
  ? V1ResponsesRequest
  : P extends "openai_chat_completions"
    ? V1ChatCompletionsRequest
    : P extends "openai_completions"
      ? V1CompletionsRequest
      : V1MessagesRequest;

export type V1ResponseForProtocol<P extends V1Protocol> = P extends "openai_responses"
  ? V1ResponsesResponse
  : P extends "openai_chat_completions"
    ? V1ChatCompletionsResponse
    : P extends "openai_completions"
      ? V1CompletionsResponse
      : V1MessagesResponse;

export interface V1EndpointRequestMap {
  responses: V1ResponsesRequest;
  "chat/completions": V1ChatCompletionsRequest;
  messages: V1MessagesRequest;
  completions: V1CompletionsRequest;
}

export interface V1EndpointResponseMap {
  responses: V1ResponsesResponse;
  "chat/completions": V1ChatCompletionsResponse;
  messages: V1MessagesResponse;
  completions: V1CompletionsResponse;
}

export type V1EndpointRequest<E extends V1Endpoint> = V1EndpointRequestMap[E];

export type V1EndpointResponse<E extends V1Endpoint> = V1EndpointResponseMap[E];

export interface V1ModelMetadata {
  logicalModel: string;
  upstreamModel: string;
  provider: V1ProviderId;
  routeId?: string;
}

export interface V1AttemptBase<E extends V1Endpoint> {
  requestId: string;
  id: string;
  endpoint: E;
  protocol: V1ProtocolForEndpoint<E>;
  model: V1ModelMetadata;
  durationMs?: number;
}

export interface V1CandidateForEndpoint<E extends V1Endpoint> extends V1AttemptBase<E> {
  status: "succeeded";
  response: V1EndpointResponse<E>;
  content: string;
  usage?: V1Usage;
  finishReason?: V1FinishReasonForProtocol<V1ProtocolForEndpoint<E>>;
  metadata?: Record<string, unknown>;
}

export interface V1FailedAttemptForEndpoint<E extends V1Endpoint> extends V1AttemptBase<E> {
  status: "failed";
  error: V1AttemptError;
}

export type V1AttemptForEndpoint<E extends V1Endpoint> =
  | V1CandidateForEndpoint<E>
  | V1FailedAttemptForEndpoint<E>;

export type V1Candidate<E extends V1Endpoint = V1Endpoint> = V1CandidateForEndpoint<E>;

export interface V1JevQuestion {
  id: string;
  prompt: string;
}

/**
 * A judging rubric's wire shape. Not tied to any one domain (coding, writing,
 * etc.) - actual rubric instances live in `src/rubrics.ts`, a pluggable
 * registry meant to be iterated on and selected between per request, not a
 * fixed contract like the rest of this file.
 */
export interface V1Rubric {
  id: string;
  version: number;
  /** Short blurb of what this rubric is for - shown to Jev when picking which rubric fits a request. */
  description: string;
  instruction: string;
  questions: readonly V1JevQuestion[];
}

export interface V1JevRequestForEndpoint<E extends V1Endpoint> {
  requestId: string;
  endpoint: E;
  request: V1EndpointRequest<E>;
  attempts: readonly V1AttemptForEndpoint<E>[];
  candidates: readonly V1CandidateForEndpoint<E>[];
  rubric: V1Rubric;
}

export type V1JevRequest<E extends V1Endpoint = V1Endpoint> = V1JevRequestForEndpoint<E>;

export interface V1JevResponseForEndpoint<E extends V1Endpoint> {
  requestId: string;
  endpoint: E;
  winnerCandidateId: string;
  notes?: readonly string[];
  metadata?: Record<string, unknown>;
}

export type V1JevResponse<E extends V1Endpoint = V1Endpoint> = V1JevResponseForEndpoint<E>;

export interface V1JevFailure<E extends V1Endpoint = V1Endpoint> {
  requestId: string;
  endpoint: E;
  error: V1Error;
}

export type V1JevResult<E extends V1Endpoint = V1Endpoint> =
  | V1WinnerForEndpoint<E>
  | V1JevFailure<E>;

export interface V1WinnerForEndpoint<E extends V1Endpoint> {
  requestId: string;
  candidateId: string;
  candidate: V1CandidateForEndpoint<E>;
  endpoint: E;
  protocol: V1ProtocolForEndpoint<E>;
  request: V1EndpointRequest<E>;
  response: V1EndpointResponse<E>;
  policy: "passthrough";
}

export type V1Winner<E extends V1Endpoint = V1Endpoint> = V1WinnerForEndpoint<E>;

export type V1AttemptErrorCode =
  | "network_error"
  | "timeout"
  | "rate_limited"
  | "upstream_error"
  | "invalid_response"
  | "authentication_error"
  | "unsupported_model"
  | "configuration_error";

export interface V1AttemptError {
  attemptId?: string;
  code: V1AttemptErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  provider?: V1ProviderId;
  upstreamModel?: string;
  details?: Record<string, unknown>;
}

export type V1ErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "provider_error"
  | "judge_error"
  | "no_viable_candidates"
  | "internal_error";

export interface V1Error {
  code: V1ErrorCode;
  message: string;
  status: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface V1ErrorResponse {
  error: V1Error;
}

export type V1RequestTypeName<E extends V1Endpoint> = E extends "responses"
  ? "V1ResponsesRequest"
  : E extends "chat/completions"
    ? "V1ChatCompletionsRequest"
    : E extends "completions"
      ? "V1CompletionsRequest"
      : "V1MessagesRequest";

export type V1ResponseTypeName<E extends V1Endpoint> = E extends "responses"
  ? "V1ResponsesResponse"
  : E extends "chat/completions"
    ? "V1ChatCompletionsResponse"
    : E extends "completions"
      ? "V1CompletionsResponse"
      : "V1MessagesResponse";

export interface V1EndpointContract<E extends V1Endpoint> {
  endpoint: E;
  method: "POST";
  path: V1EndpointPathFor<E>;
  protocol: V1ProtocolForEndpoint<E>;
  requestType: V1RequestTypeName<E>;
  responseType: V1ResponseTypeName<E>;
  streaming: false;
}

export type V1EndpointContractMap = {
  [E in V1Endpoint]: V1EndpointContract<E>;
};

export const V1_ENDPOINT_MATRIX = {
  responses: {
    endpoint: "responses",
    method: "POST",
    path: "/v1/responses",
    protocol: "openai_responses",
    requestType: "V1ResponsesRequest",
    responseType: "V1ResponsesResponse",
    streaming: false,
  },
  "chat/completions": {
    endpoint: "chat/completions",
    method: "POST",
    path: "/v1/chat/completions",
    protocol: "openai_chat_completions",
    requestType: "V1ChatCompletionsRequest",
    responseType: "V1ChatCompletionsResponse",
    streaming: false,
  },
  messages: {
    endpoint: "messages",
    method: "POST",
    path: "/v1/messages",
    protocol: "anthropic_messages",
    requestType: "V1MessagesRequest",
    responseType: "V1MessagesResponse",
    streaming: false,
  },
  completions: {
    endpoint: "completions",
    method: "POST",
    path: "/v1/completions",
    protocol: "openai_completions",
    requestType: "V1CompletionsRequest",
    responseType: "V1CompletionsResponse",
    streaming: false,
  },
} as const satisfies V1EndpointContractMap;

export type V1EndpointMatrix = typeof V1_ENDPOINT_MATRIX;

export function parseV1EndpointPath(path: string): V1Endpoint | null {
  switch (path) {
    case "/v1/responses":
      return "responses";
    case "/v1/chat/completions":
      return "chat/completions";
    case "/v1/messages":
      return "messages";
    case "/v1/completions":
      return "completions";
    default:
      return null;
  }
}

export function getV1EndpointContract(path: string): V1EndpointContract<V1Endpoint> | null {
  const endpoint = parseV1EndpointPath(path);
  return endpoint ? V1_ENDPOINT_MATRIX[endpoint] : null;
}
