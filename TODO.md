# JudgeJev TODO

## Working file

Use this file as the persistent working record for the project. Add implementation notes, decisions, file references, validation results, and next steps here as work progresses so future agent prompts can continue without relying on session history.

## Direction

Monoize (`Ikaleio/monoize`) is the reference implementation for the useful gateway behavior. JudgeJev v1 is deliberately an API-only, non-streaming LLM proxy and judging pipeline. Do not build streaming, live intervention, a dashboard, billing, or other product surfaces into v1.

### V1 flow

1. The client sends one normal LLM API request to JudgeJev.
2. JudgeJev fans the same request out concurrently to the configured provider/model routes.
3. JudgeJev waits until every attempted call has completed or failed, then normalizes each complete response into a typed candidate.
4. JudgeJev calls the actual Jev judging endpoint with a type-safe payload containing the original request, candidate responses, and the rubric/questions.
5. Jev selects the best overall candidate. V1 returns that winner unchanged in the original downstream response shape.
6. V1 emits no streaming events, performs no partial-output provider fallback, and does not run a live checkpoint/intervention loop.

Monoize remains the reference for the non-streaming pieces: protocol conversion, provider adapters, retries, errors, routing, and fail-forward behavior.

### In scope for v1, in priority order

1. Define the API-only, non-streaming proxy contract.
2. Fan out concurrently and wait for all LLM calls to complete.
3. Define the type-safe Jev judging request/response contract and an initial generic coding rubric.
4. Call the actual Jev endpoint after the fan-out barrier and return its selected winner unchanged.
5. Port the Monoize-derived non-streaming routing, retry, failover, and error behavior needed by that flow.
6. Add focused plumbing tests and local validation.

### Deferred until after v1

- Streaming, SSE, and pre-output provider fallback.
- Live checkpoints, intervention, restart, redirect, and branching.
- Prefill-derived question/context selection and the final question matrix/rubric.
- Durable configuration, checkpoint, and long-running graph persistence.
- Monoize dashboard, billing, CAPTCHA, image APIs, deployment, replica, and metering features.
- Porting Monoize's Rust, Axum, or SeaORM stack instead of adapting its behavior to TypeScript/Cloudflare.

## Completed

- [x] Locate and audit the relevant Monoize source, specifications, and JudgeJev architecture.
- [x] Establish the TypeScript/Cloudflare adaptation boundary; Monoize is a reference, not a wholesale dependency.
- [x] Add shared upstream error classification, `Retry-After` handling, exponential backoff, jitter, and upstream error parsing.
- [x] Add logical-model routing with provider/upstream model mapping, aliases, priority, and enabled flags.
- [x] Update OpenAI, Anthropic, and Gemini adapters to use the shared retry/error path.
- [x] Make provider-backed non-streaming fan-out concurrent.
- [x] Add basic duplicate pruning and viable-candidate judging.
- [x] Accept per-run model configurations and provider environment credentials.
- [x] Verify the current test suite and TypeScript typecheck.

The current implementation already has concurrent non-streaming fan-out, basic duplicate pruning, and shared retry/error handling. The remaining v1 work is limited to the proxy contract, complete candidate normalization, the actual Jev judging call, and focused plumbing validation.

## Remaining Work

### 1. Define the v1 proxy contract

- [ ] Confirm the supported downstream endpoints: `POST /v1/responses`, `POST /v1/chat/completions`, and `POST /v1/messages`.
- [ ] Define typed request, response, error, usage, and model metadata boundaries for each supported protocol.
- [ ] Define authentication, body limits, validation failures, timeouts, and client-facing error envelopes.
- [ ] Keep response retrieval, Files, Vector Store, and local response-history APIs out of v1.
- [ ] Document the proxy contract and provide minimal curl examples.

### 2. Normalize and fan out provider calls

- [ ] Define a canonical typed candidate shape that carries the text, tools, reasoning, refusals, usage, finish metadata, and provider metadata needed by Jev.
- [ ] Run all configured provider/model attempts concurrently.
- [ ] Wait for every attempt to complete or fail before judging; preserve per-attempt errors without emitting partial output.
- [ ] Normalize complete responses and prune exact duplicates.
- [ ] Ensure v1 emits no streaming events and never switches providers after output begins.

### 3. Integrate the actual Jev judging endpoint

- [ ] Define a type-safe Jev request containing the original request, candidate responses, and an initial generic coding-quality rubric/questions.
- [ ] Define a type-safe Jev response containing the selected candidate ID and any metadata needed to reconstruct the downstream response.
- [ ] Call the configured actual Jev endpoint only after the fan-out barrier.
- [ ] Return the selected candidate unchanged in the original downstream response shape.
- [ ] Validate winner selection with a generic coding question before introducing the final question matrix.
- [ ] Keep prefill-derived question/context selection and the final rubric deferred until after v1.

### 4. Port the required non-streaming gateway behavior

- [ ] Use logical-model routing with provider/upstream model mapping, aliases, priority, and enabled flags.
- [ ] Retry transient network failures, timeouts, `408`, `429`, and `5xx` responses with `Retry-After`, exponential backoff, jitter, and a request-wide attempt budget.
- [ ] Do not retry authentication, authorization, validation, unsupported-model, or other persistent failures on the same channel.
- [ ] Fail forward to the next eligible route and return a sanitized error when no candidate succeeds.
- [ ] Keep weighted routing, route health, circuit breakers, session affinity, and durable routing state for later unless required by the initial flow.

### 5. Add focused v1 tests

- [ ] Test concurrent fan-out and the all-attempts completion barrier.
- [ ] Test candidate normalization, duplicate pruning, and per-attempt failure reporting.
- [ ] Test transient retry classification, `Retry-After`, fail-forward, and persistent-error handling.
- [ ] Test the type-safe Jev request payload, winner response, and downstream response mapping.
- [ ] Test proxy authentication, validation, errors, and the absence of streaming behavior.
- [ ] Run a generic coding-question end-to-end test through fan-out, Jev selection, and the original caller response.

### 6. Final validation

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run the configured build command.
- [ ] Run local proxy smoke tests with mocked or configured providers and Jev.
- [ ] Run `git diff --check` and review the final diff.
- [ ] Update `README.md`, `env.template`, and Wrangler configuration for the completed v1 contract.

## Future work after v1

- Streaming, SSE, and pre-output provider fallback.
- Live checkpoints, intervention, restart, redirect, and branching.
- Prefill-derived question/context selection and the final question matrix/rubric.
- Durable configuration, checkpoint, and long-running graph persistence.
- Weighted routing, route health, circuit breakers, session affinity, and durable routing state.
- Monoize dashboard, billing, CAPTCHA, image APIs, deployment, replica, and metering features.
- Full URP v2 adapter coverage and Monoize's Rust, Axum, or SeaORM stack.

## Monoize reference map

Use these upstream areas as the reference for v1's non-streaming pieces. Streaming-specific portions are future reference only:

- `spec/urp-v2-flat-structure.spec.md` — canonical request, response, and node model.
- `spec/urp-transform-system.spec.md` — decode, encode, transform, and cross-family rules.
- `spec/unified_responses_proxy.spec.md` — non-streaming proxy pipeline, auth, validation, and terminal behavior.
- `spec/monoize-upstream-routing.spec.md` — ordered routing, retries, and fail-forward behavior.
- `spec/upstream-error-sanitization.spec.md` — client-safe errors and internal diagnostic boundaries.
- `src/urp/` — non-streaming URP types, decoding, and encoding helpers.
- `src/handlers/nonstream.rs` — forwarding and retry/fallback execution.
- `src/handlers/routing.rs` and `src/monoize_routing.rs` — attempt construction and routing behavior.
- `src/upstream.rs` — upstream error classification and sanitization inputs.

## Current validation

- `npm test`: 5/5 passing on the last run.
- `npm run typecheck`: passing on the last run.
- No commit has been made.
