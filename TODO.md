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

## Parallel work plan

### Handoff rules for every chunk

- Treat this file as the source of truth between agent prompts. Record decisions, assumptions, file references, validation results, and follow-ups in the owning chunk.
- An agent owns only the files listed for its chunk. Do not modify another chunk's files without recording the boundary change here first.
- Each implementation chunk owns its focused tests and runs `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` before handoff.
- Do not implement deferred streaming, live intervention, durable graph state, or product-surface work in a v1 chunk.
- If a shared contract or file boundary must change, stop and record the proposed change here before editing it.

### Chunk 0 — Establish the v1 contracts (prerequisite)

- [x] **Owner:** Kilo
- [x] **Dependencies:** none
- [x] **Files:** `src/v1/contracts.ts` (new), `test/fixtures/v1-contracts.ts` (new), `test/v1-contracts.test.ts` (new)
- [x] Define the non-streaming downstream request, candidate, Jev judging request/response, winner, error, usage, and model metadata types.
- [x] Define the initial generic coding-quality rubric/questions and the rule that the selected candidate is returned unchanged in the original downstream response shape.
- [x] Define the supported endpoint matrix for `POST /v1/responses`, `POST /v1/chat/completions`, and `POST /v1/messages`.
- [x] Add fixtures or type-level examples that the later chunks can share without duplicating shapes.
- [x] **Exit criteria:** contracts compile, are unambiguous, and contain no streaming or intervention state.

**Chunk 0 decisions:** `V1ProviderId` reuses the existing provider identity type; request, attempt, Jev, and winner records share `requestId`; attempts preserve failed routes; winner records retain the original request and response with `policy: "passthrough"`; endpoint parsing is provided by `parseV1EndpointPath` and `getV1EndpointContract`.

### Wave 1 — Parallel implementation chunks

#### Chunk A — Proxy API contract and entrypoint

- [x] **Owner:** Kilo
- [x] **Dependencies:** Chunk 0
- [x] **Files:** `src/index.ts`, `src/api/v1.ts`, `test/api.test.ts`
- [x] Add or confirm the v1 proxy endpoints and map each downstream request into the shared v1 request type.
- [x] Add downstream authentication, body limits, validation, timeout, and client-facing error behavior.
- [x] Return the selected winner in the original downstream response shape.
- [x] Keep SSE, response retrieval, Files, Vector Store, and local response-history APIs out of v1.
- [x] Keep existing `/runs` endpoints compatible unless the Chunk 0 contract explicitly replaces them.
- [x] **Exit criteria:** API tests cover success, auth, validation, upstream errors, and the non-streaming response contract.

#### Chunk B — Provider completion and candidate normalization

- [x] **Owner:** Kilo
- [x] **Dependencies:** Chunk 0
- [x] **Files:** `src/providers/types.ts`, `src/providers/openai.ts`, `src/providers/anthropic.ts`, `src/providers/gemini.ts`, `src/providers/normalize.ts` (new), `test/providers.test.ts` (new)
- [x] Keep the v1 path non-streaming and normalize each provider's complete response into the shared candidate type.
- [x] Preserve text, usage, finish metadata, provider metadata, and structured fields required by the judging contract.
- [x] Convert provider failures into the shared error classification without exposing credentials or provider internals.
- [x] Do not change routing policy or implement streaming behavior in this chunk.
- [x] **Exit criteria:** provider tests cover OpenAI, Anthropic, Gemini, malformed responses, usage, and failure classification.

**Chunk B results:** Added `ProviderCompletion`, `ProviderCompletionError`, and `V1CompletionRequest` types to `types.ts`; added `completeV1` methods and exported parse functions (`parseOpenAIChatCompletion`, `parseOpenAIResponsesCompletion`, `parseAnthropicMessagesCompletion`, `parseGeminiGenerateContent`) to each provider; added `toResponsesRequestBody` and `completeResponsesV1` for the OpenAI Responses API protocol; added `convertGeminiToDownstream` for protocol conversion (OpenAI chat completions, Anthropic messages, OpenAI responses); added `toProviderCompletionError`/`classifyToAttemptErrorCode` to `errors.ts`; added `normalize.ts` with `normalizeProviderCompletion`, `normalizeProviderError`, `normalizeUsage`, and `normalizeFinishReason`. `npm test` = 84/84, `npm run typecheck`, `npm run build`, and `git diff --check` pass. No commit has been made.

#### Chunk C — Routing, retry, and fail-forward behavior

- [x] **Owner:** Kilo
- [x] **Dependencies:** Chunk 0
- [x] **Files:** `src/providers/router.ts`, `src/providers/errors.ts`, `src/providers/factory.ts`, `test/routing-errors.test.ts` (new)
- [x] Resolve logical-model routes using provider/upstream model mapping, aliases, priority, and enabled flags.
- [x] Retry transient network failures, timeouts, `408`, `429`, and `5xx` responses with `Retry-After`, exponential backoff, jitter, and a request-wide attempt budget.
- [x] Do not retry authentication, authorization, validation, unsupported-model, or other persistent failures on the same channel.
- [x] Fail forward to the next eligible route and return a sanitized error when no candidate succeeds.
- [x] Keep weighted routing, route health, circuit breakers, session affinity, and durable routing state for later.
- [x] **Exit criteria:** tests cover route resolution, retry classification, `Retry-After`, attempt budgets, fail-forward, and persistent errors.

**Chunk C results:** 18 new tests in `test/routing-errors.test.ts` cover `resolveModelRoutes` (alias/priority/enabled), `defaultModelRoutes`, `resolveRoutesForState`, `classifyRetryableFailure` (rate_limited/transient/persistent), `UpstreamError.retryable` + `retryAfterMs`, `retryWithBackoff` (transient retry, `Retry-After` precedence, no-retry on persistent, attempt budget), and `isRetryableError` (abort/persistent/transient). `npm test` = 31/31, `npm run typecheck` and `npm run build` pass.

### Wave 2 — Parallel integration chunks

#### Chunk D — Fan-out barrier and graph orchestration

- [ ] **Owner:** unassigned
- [ ] **Dependencies:** Chunks 0, B, and C
- [ ] **Files:** `src/graph/state.ts`, `src/graph/jev-graph.ts`, `src/graph/fanout.ts` (new, if useful), `test/judge.test.ts`
- [ ] Run every configured provider/model attempt concurrently and wait for all attempts to complete or fail before judging.
- [ ] Preserve per-attempt failures, normalize successful responses, and prune exact duplicates without emitting partial output.
- [ ] Remove or bypass live `inspect`/`intervene` behavior for v1; do not add checkpoints, restart, redirect, or branching.
- [ ] Call the shared judge port after the fan-out barrier and keep the graph compatible with the actual Jev client from Chunk E.
- [ ] **Exit criteria:** graph tests prove the all-attempts barrier, candidate pruning, failure handling, and absence of partial-output fallback.

#### Chunk E — Actual Jev judging endpoint

- [ ] **Owner:** unassigned
- [ ] **Dependencies:** Chunk 0 and the judge port defined by Chunk D
- [ ] **Files:** `src/judge/judge.ts`, `src/jev/client.ts` (new), `test/jev-client.test.ts` (new)
- [ ] Replace the current longest-content heuristic with a type-safe client for the configured actual Jev endpoint.
- [ ] Send the original request, candidates, and initial generic coding-quality rubric/questions after the fan-out barrier.
- [ ] Decode the selected candidate ID and metadata without exposing hidden chain-of-thought.
- [ ] Keep prefill-derived question/context selection and the final question matrix/rubric deferred until after v1.
- [ ] **Exit criteria:** fake-fetch tests cover the request payload, winner response, endpoint errors, and unchanged-winner mapping contract.

### Wave 3 — Parallel validation chunks

#### Chunk F — End-to-end v1 plumbing tests

- [ ] **Owner:** unassigned
- [ ] **Dependencies:** Chunks A through E
- [ ] **Files:** `test/v1-e2e.test.ts` (new), `test/fixtures/` (new, if needed)
- [ ] Run a generic coding-question request through the proxy, mocked providers, fan-out barrier, mocked Jev endpoint, and original caller response.
- [ ] Verify all attempts complete before judging, the winner is returned unchanged, failures are sanitized, and no streaming events are emitted.
- [ ] **Exit criteria:** one end-to-end test exercises the complete v1 path with no live credentials required.

#### Chunk G — Documentation, configuration, and local validation

- [ ] **Owner:** unassigned
- [ ] **Dependencies:** Chunks A through E
- [ ] **Files:** `README.md`, `env.template`, `wrangler.jsonc`, `Justfile` (only if a recipe is missing)
- [ ] Document the v1 endpoints, authentication, provider configuration, Jev endpoint configuration, and local development commands.
- [ ] Add only the environment variables and Wrangler bindings required by the completed v1 contract.
- [ ] Run local proxy smoke tests with mocked or configured providers and Jev.
- [ ] **Exit criteria:** documentation and configuration match the implemented contract; `just dev`, `just test`, `just typecheck`, and `just build` are usable.

### Parallelization map

| Wave | Chunks | Start condition |
| --- | --- | --- |
| 0 | Chunk 0 | Start first; all other chunks wait for its contracts |
| 1 | Chunks A, B, C | Run in parallel after Chunk 0 |
| 2 | Chunks D, E | Run in parallel after their listed dependencies |
| 3 | Chunks F, G | Run in parallel after Chunks A through E |

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

- `npm test`: 84/84 passing (71 provider tests, 8 v1 contract tests, 5 judge tests).
- `npm run typecheck`: passing on the last run.
- `npm run build`: passing on the last run.
- `git diff --check`: passing on the last run.
- No commit has been made.
