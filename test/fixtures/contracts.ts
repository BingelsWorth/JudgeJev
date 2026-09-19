import type {
  V1Candidate,
  V1ChatCompletionsRequest,
  V1ChatCompletionsResponse,
  V1ErrorResponse,
  V1FailedAttemptForEndpoint,
  V1JevFailure,
  V1JevRequest,
  V1JevResponse,
  V1MessagesRequest,
  V1MessagesResponse,
  V1ResponsesRequest,
  V1ResponsesResponse,
  V1Winner,
} from "../../src/contracts.js";

export const v1ResponsesRequest = {
  requestId: "run-123",
  endpoint: "responses",
  protocol: "openai_responses",
  model: "gpt-4o",
  input: "Write a TypeScript function that adds two numbers.",
  stream: false,
} satisfies V1ResponsesRequest;

export const v1ChatCompletionsRequest = {
  requestId: "run-123",
  endpoint: "chat/completions",
  protocol: "openai_chat_completions",
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You are a concise coding assistant." },
    { role: "user", content: "Write a TypeScript function that adds two numbers." },
  ],
  stream: false,
} satisfies V1ChatCompletionsRequest;

export const v1MessagesRequest = {
  requestId: "run-123",
  endpoint: "messages",
  protocol: "anthropic_messages",
  model: "claude-3-5-sonnet-latest",
  system: "You are a concise coding assistant.",
  messages: [{ role: "user", content: "Write a TypeScript function that adds two numbers." }],
  stream: false,
} satisfies V1MessagesRequest;

export const v1ResponsesResponse = {
  id: "resp_winner",
  object: "response",
  created_at: 1720000000,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "resp-output",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "const add = (a: number, b: number) => a + b;" }],
    },
  ],
  usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 },
} satisfies V1ResponsesResponse;

export const v1ChatCompletionsResponse = {
  id: "chat_winner",
  object: "chat.completion",
  created: 1720000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "const add = (a: number, b: number) => a + b;",
      },
      finish_reason: "stop",
    },
  ],
  usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 },
} satisfies V1ChatCompletionsResponse;

export const v1MessagesResponse = {
  id: "msg_winner",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "text",
      text: "const add = (a: number, b: number) => a + b;",
    },
  ],
  model: "claude-3-5-sonnet-latest",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 },
} satisfies V1MessagesResponse;

export const v1Candidate: V1Candidate<"responses"> = {
  requestId: "run-123",
  id: "candidate-gpt-4o",
  endpoint: "responses",
  protocol: "openai_responses",
  status: "succeeded",
  model: {
    logicalModel: "coder",
    upstreamModel: "gpt-4o",
    provider: "openai",
    routeId: "openai-default",
  },
  response: v1ResponsesResponse,
  content: "const add = (a: number, b: number) => a + b;",
  usage: v1ResponsesResponse.usage,
  finishReason: "stop",
};

export const v1ChatCandidate: V1Candidate<"chat/completions"> = {
  requestId: "run-123",
  id: "candidate-chat-gpt-4o",
  endpoint: "chat/completions",
  protocol: "openai_chat_completions",
  status: "succeeded",
  model: {
    logicalModel: "coder",
    upstreamModel: "gpt-4o",
    provider: "openai",
    routeId: "openai-default",
  },
  response: v1ChatCompletionsResponse,
  content: "const add = (a: number, b: number) => a + b;",
  usage: v1ChatCompletionsResponse.usage,
  finishReason: "stop",
};

export const v1MessagesCandidate: V1Candidate<"messages"> = {
  requestId: "run-123",
  id: "candidate-claude",
  endpoint: "messages",
  protocol: "anthropic_messages",
  status: "succeeded",
  model: {
    logicalModel: "coder",
    upstreamModel: "claude-3-5-sonnet-latest",
    provider: "anthropic",
    routeId: "anthropic-default",
  },
  response: v1MessagesResponse,
  content: "const add = (a: number, b: number) => a + b;",
  usage: v1MessagesResponse.usage,
  finishReason: "end_turn",
};

export const v1FailedAttempt: V1FailedAttemptForEndpoint<"responses"> = {
  requestId: "run-123",
  id: "attempt-anthropic-failed",
  endpoint: "responses",
  protocol: "openai_responses",
  status: "failed",
  model: {
    logicalModel: "coder",
    upstreamModel: "claude-3-5-sonnet-latest",
    provider: "anthropic",
    routeId: "anthropic-default",
  },
  error: {
    attemptId: "attempt-anthropic-failed",
    code: "authentication_error",
    message: "Upstream authentication failed.",
    retryable: false,
    status: 401,
    provider: "anthropic",
    upstreamModel: "claude-3-5-sonnet-latest",
  },
};

export const v1JevRequest: V1JevRequest<"responses"> = {
  requestId: "run-123",
  endpoint: "responses",
  request: v1ResponsesRequest,
  attempts: [v1Candidate, v1FailedAttempt],
  candidates: [v1Candidate],
  rubric: {
    id: "coding-v1",
    version: 1,
    description: "For requests to write, fix, explain, or review code.",
    instruction: "Compare the candidates and select the single best overall answer to the coding request.",
    questions: [
      {
        id: "correctness",
        prompt: "Does the response correctly solve the requested coding task?",
      },
    ],
  },
};

export const v1JevResponse: V1JevResponse<"responses"> = {
  requestId: "run-123",
  endpoint: "responses",
  winnerCandidateId: v1Candidate.id,
  notes: ["candidate-gpt-4o best matched the coding rubric"],
};

export const v1Winner: V1Winner<"responses"> = {
  requestId: "run-123",
  candidateId: v1Candidate.id,
  candidate: v1Candidate,
  request: v1ResponsesRequest,
  endpoint: "responses",
  protocol: "openai_responses",
  response: v1ResponsesResponse,
  policy: "passthrough",
};

export const v1ErrorResponse: V1ErrorResponse = {
  error: {
    code: "no_viable_candidates",
    message: "No provider returned a viable candidate.",
    status: 502,
  },
};

export const v1JevFailure: V1JevFailure<"responses"> = {
  requestId: "run-failed",
  endpoint: "responses",
  error: v1ErrorResponse.error,
};
