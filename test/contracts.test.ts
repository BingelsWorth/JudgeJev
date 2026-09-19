import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GENERIC_CODING_RUBRIC,
  V1_ENDPOINT_MATRIX,
  getV1EndpointContract,
  parseV1EndpointPath,
  type V1AttemptForEndpoint,
  type V1Candidate,
  type V1ChatCompletionsRequest,
  type V1ChatCompletionsResponse,
  type V1EndpointResponse,
  type V1FailedAttemptForEndpoint,
  type V1FinishReasonForProtocol,
  type V1JevFailure,
  type V1JevRequest,
  type V1JevResponse,
  type V1MessagesRequest,
  type V1MessagesResponse,
  type V1ResponsesInput,
  type V1ResponsesRequest,
  type V1ResponsesResponse,
  type V1Usage,
  type V1Winner,
} from "../src/contracts.js";
import {
  v1Candidate,
  v1ChatCandidate,
  v1ChatCompletionsRequest,
  v1ChatCompletionsResponse,
  v1ErrorResponse,
  v1FailedAttempt,
  v1JevFailure,
  v1JevRequest,
  v1JevResponse,
  v1MessagesCandidate,
  v1MessagesRequest,
  v1MessagesResponse,
  v1ResponsesRequest,
  v1ResponsesResponse,
  v1Winner,
} from "./fixtures/contracts.js";

describe("v1 endpoint contracts", () => {
  it("defines the supported non-streaming endpoint matrix", () => {
    expect(V1_ENDPOINT_MATRIX).toEqual({
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
    });
    expect(Object.values(V1_ENDPOINT_MATRIX).every((contract) => contract.streaming === false)).toBe(true);
    expect(parseV1EndpointPath("/v1/responses")).toBe("responses");
    expect(parseV1EndpointPath("/v1/chat/completions")).toBe("chat/completions");
    expect(parseV1EndpointPath("/v1/messages")).toBe("messages");
    expect(parseV1EndpointPath("/v1/unknown")).toBeNull();
    expect(getV1EndpointContract("/v1/messages")?.path).toBe("/v1/messages");
    expect(getV1EndpointContract("/v1/unknown")).toBeNull();
  });

  it("keeps each endpoint correlated with its request and response types", () => {
    expectTypeOf<V1ResponsesRequest>().toMatchTypeOf<{
      requestId: string;
      endpoint: "responses";
      protocol: "openai_responses";
      input: V1ResponsesInput;
    }>();
    expectTypeOf<V1ChatCompletionsRequest>().toMatchTypeOf<{
      requestId: string;
      endpoint: "chat/completions";
      protocol: "openai_chat_completions";
    }>();
    expectTypeOf<V1MessagesRequest>().toMatchTypeOf<{
      requestId: string;
      endpoint: "messages";
      protocol: "anthropic_messages";
    }>();
    expectTypeOf<V1Usage>().toMatchTypeOf<{
      inputTokens: number;
      outputTokens: number;
    }>();
    expectTypeOf<"stop">().toMatchTypeOf<V1FinishReasonForProtocol<"openai_chat_completions">>();
    expectTypeOf<"end_turn">().toMatchTypeOf<V1FinishReasonForProtocol<"anthropic_messages">>();
    expectTypeOf<V1AttemptForEndpoint<"responses">>().toMatchTypeOf<
      V1Candidate<"responses"> | V1FailedAttemptForEndpoint<"responses">
    >();
    expectTypeOf<V1EndpointResponse<"responses">>().toMatchTypeOf<V1ResponsesResponse>();
    expectTypeOf<V1EndpointResponse<"chat/completions">>().toMatchTypeOf<V1ChatCompletionsResponse>();
    expectTypeOf<V1EndpointResponse<"messages">>().toMatchTypeOf<V1MessagesResponse>();
  });

  it("rejects cross-protocol request and response combinations", () => {
    expectTypeOf<{
      endpoint: "responses";
      protocol: "openai_chat_completions";
      model: string;
      input: string;
    }>().not.toMatchTypeOf<V1ResponsesRequest>();
    expectTypeOf<{
      endpoint: "messages";
      protocol: "openai_responses";
      model: string;
      messages: unknown[];
    }>().not.toMatchTypeOf<V1MessagesRequest>();
    expectTypeOf<V1Candidate<"responses">>().not.toMatchTypeOf<{
      response: V1ChatCompletionsResponse;
    }>();
    expectTypeOf<V1Candidate<"messages">>().not.toMatchTypeOf<{
      response: V1ResponsesResponse;
    }>();
  });
});

describe("v1 judging contracts", () => {
  it("defines the generic coding rubric", () => {
    expect(GENERIC_CODING_RUBRIC).toEqual({
      id: "generic-coding-quality-v1",
      version: 1,
      instruction: "Compare the candidates and select the single best overall answer to the coding request.",
      questions: [
        {
          id: "correctness",
          prompt: "Does the response correctly solve the requested coding task?",
        },
        {
          id: "completeness",
          prompt: "Does the response address all stated requirements and relevant edge cases?",
        },
        {
          id: "clarity",
          prompt: "Is the response clear, actionable, and easy to understand?",
        },
        {
          id: "safety",
          prompt: "Does the response avoid unsafe, misleading, or harmful guidance?",
        },
        {
          id: "efficiency",
          prompt: "Is the proposed approach appropriately efficient and maintainable?",
        },
      ],
    });
  });

  it("keeps the original request, attempts, candidates, and winner response correlated", () => {
    expectTypeOf<V1JevRequest<"responses">>().toMatchTypeOf<{
      requestId: string;
      endpoint: "responses";
      request: V1ResponsesRequest;
      attempts: readonly V1AttemptForEndpoint<"responses">[];
      candidates: readonly V1Candidate<"responses">[];
    }>();
    expectTypeOf<V1JevResponse<"responses">>().toMatchTypeOf<{
      requestId: string;
      endpoint: "responses";
      winnerCandidateId: string;
    }>();
    expectTypeOf<V1JevFailure<"responses">>().toMatchTypeOf<{
      requestId: string;
      endpoint: "responses";
      error: { code: string; message: string; status: number };
    }>();
    expectTypeOf<V1Winner<"responses">>().toMatchTypeOf<{
      requestId: string;
      endpoint: "responses";
      request: V1ResponsesRequest;
      response: V1ResponsesResponse;
      policy: "passthrough";
    }>();
    expectTypeOf<V1Winner<"chat/completions">>().not.toMatchTypeOf<{
      response: V1MessagesResponse;
    }>();
  });

  it("returns the selected candidate response without conversion", () => {
    expect(v1Winner.response).toBe(v1Winner.candidate.response);
    expect(v1Winner.policy).toBe("passthrough");
    expect(v1JevResponse.winnerCandidateId).toBe(v1Candidate.id);
  });
});

describe("v1 fixtures", () => {
  it("provides complete request, response, candidate, judging, attempt, and error examples", () => {
    expect(v1ResponsesRequest.requestId).toBe("run-123");
    expect(v1ResponsesRequest.endpoint).toBe("responses");
    expect(v1ChatCompletionsRequest.endpoint).toBe("chat/completions");
    expect(v1MessagesRequest.endpoint).toBe("messages");
    expect(v1ResponsesResponse.status).toBe("completed");
    expect(v1ChatCompletionsResponse.choices[0].finish_reason).toBe("stop");
    expect(v1MessagesResponse.stop_reason).toBe("end_turn");
    expect(v1Candidate.response).toBe(v1ResponsesResponse);
    expect(v1ChatCandidate.response).toBe(v1ChatCompletionsResponse);
    expect(v1MessagesCandidate.response).toBe(v1MessagesResponse);
    expect(v1JevRequest.requestId).toBe(v1ResponsesRequest.requestId);
    expect(v1JevRequest.attempts).toEqual([v1Candidate, v1FailedAttempt]);
    expect(v1JevRequest.candidates).toEqual([v1Candidate]);
    expect(v1FailedAttempt.status).toBe("failed");
    expect(v1FailedAttempt.error.code).toBe("authentication_error");
    expect(v1JevResponse.requestId).toBe(v1ResponsesRequest.requestId);
    expect(v1Winner.request).toBe(v1ResponsesRequest);
    expect(v1Winner.response).toBe(v1ResponsesResponse);
    expect(v1JevFailure.requestId).toBe("run-failed");
    expect(v1JevFailure.endpoint).toBe("responses");
    expect(v1ErrorResponse.error.code).toBe("no_viable_candidates");
  });

  it("contains no streaming or intervention state", () => {
    expectTypeOf<V1ResponsesRequest>().not.toMatchTypeOf<{ stream: true }>();
    expectTypeOf<V1Candidate<"responses">>().not.toMatchTypeOf<{ checkpoint: unknown }>();
    expectTypeOf<V1JevRequest<"responses">>().not.toMatchTypeOf<{ interventionCycles: number }>();
  });
});
