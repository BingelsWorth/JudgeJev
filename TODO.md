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

**Chunk A results:** Implemented `createV1Router()` in `src/api/v1.ts` with three endpoints (`/v1/responses`, `/v1/chat/completions`, `/v1/messages`), request validation via Zod schemas, provider API key resolution, model config normalization, graph invocation with `buildJevGraph`, winner response building per protocol, and error mapping to typed `V1Error` responses. Mounted in `src/index.ts:52`. 16 tests in `test/api.test.ts` cover all endpoints, validation (400), auth (401), rate limit (429), network (503), internal (500), and no-candidates (502). `npm test` = 118/118, `npm run typecheck`, `npm run build`, and `git diff --check` pass. No commit has been made.

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

- [x] **Owner:** Claude (2026-09-19)
- [x] **Dependencies:** Chunks 0, B, and C
- [x] **Files:** `src/graph/state.ts`, `src/graph/jev-graph.ts`, `src/graph/fanout.ts` (new, if useful), `test/judge.test.ts`, `src/providers/router.ts` (fan-out registration/dictionary support added here instead of a separate file)
- [x] Run every configured provider/model attempt concurrently and wait for all attempts to complete or fail before judging.
- [x] Preserve per-attempt failures, normalize successful responses, and prune exact duplicates without emitting partial output.
- [x] Remove or bypass live `inspect`/`intervene` behavior for v1; do not add checkpoints, restart, redirect, or branching.
- [x] Call the shared judge port after the fan-out barrier and keep the graph compatible with the actual Jev client from Chunk E.
- [x] **Exit criteria:** graph tests prove the all-attempts barrier, candidate pruning, failure handling, and absence of partial-output fallback.

**Chunk D results:** `ModelRoute` gained `endpoint`/`apiKey` (per-registration config block) and `fanout: Record<logicalModel, count>` (the model-name -> attempt-count dictionary). `resolveModelRoutes`/`resolveRoutesForState` in `src/providers/router.ts` enumerate every registered route and expand each one by its fan-out count for the requested model. `jev-graph.ts`'s `fanOut` runs every expanded route concurrently via `Promise.all` (the all-attempts barrier), `inspect`/`intervene` remain only as synchronous post-barrier duplicate-pruning steps (no live checkpoints/restart/redirect/branching - that scope was never added), and `judge()` is the swappable port: it runs a local longest-content heuristic by default, which `src/api/v1.ts` overrides with the real Jev call from Chunk E when `JEV_API_ENDPOINT` is configured. Tests: `test/routing-errors.test.ts`, `test/judge.test.ts`, `test/v1-e2e.test.ts`.

#### Chunk E — Actual Jev judging endpoint

- [x] **Owner:** Claude (2026-09-19)
- [x] **Dependencies:** Chunk 0 and the judge port defined by Chunk D
- [x] **Files:** `src/api/v1.ts`, `src/jev/client.ts` (new), `test/jev-client.test.ts` (new); `src/judge/judge.ts` unchanged (kept as the default/bypass judge port)
- [x] Replace the current longest-content heuristic with a type-safe client for the configured actual Jev endpoint.
- [x] Send the original request, candidates, and initial generic coding-quality rubric/questions after the fan-out barrier.
- [x] Decode the selected candidate ID and metadata without exposing hidden chain-of-thought.
- [x] Keep prefill-derived question/context selection and the final question matrix/rubric deferred until after v1.
- [x] **Exit criteria:** fake-fetch tests cover the request payload, winner response, endpoint errors, and unchanged-winner mapping contract.

**Chunk E decision:** JudgeJev is an LLM fan-out proxy; Jev is a separate typesafe judging service, not an LLM JudgeJev prompts itself and not one of the models in JudgeJev's own fan-out/model list (an earlier draft of this client mistakenly treated Jev as "an LLM to prompt with the rubric," including a whole prompt-building/streaming/reasoning-parsing layer - that was a real misunderstanding of the architecture and has been removed). `callJevJudge` in `src/jev/client.ts` is a plain typesafe HTTP client: it POSTs the `V1JevRequest` (original request, every candidate, the generic coding-quality rubric) as JSON to `JEV_API_ENDPOINT`, and expects a JSON `V1JevResponse` (`{ winnerCandidateId, notes? }`) back - reusing `fetchOk`/`retryWithBackoff` from `src/providers/errors.ts` with a short retry budget (`maxAttempts: 2`, capped backoff) to stay inside a Worker's request budget. `judge_error` failures always report status 502 regardless of the upstream status, since JudgeJev is the gateway. `src/api/v1.ts` wires this in via `runJevJudge`: unset `JEV_API_ENDPOINT` keeps the exact prior bypass behavior (dev default, unchanged); when set, it builds full protocol-shaped `V1AttemptForEndpoint`/`V1CandidateForEndpoint` records from the graph's `WorkerAttempt[]`, calls Jev, and on failure either falls back to the local heuristic (`JEV_ON_FAILURE=fallback`, default) or surfaces a `judge_error` (`JEV_ON_FAILURE=error`) per user decision. There is no real Jev deployment to point `JEV_API_ENDPOINT` at yet, so local dev leaves it unset (bypass heuristic active) - see `.env`/`env.template`. `npm test` = 148/148, `npm run typecheck` passing.

### Wave 3 — Parallel validation chunks

#### Chunk F — End-to-end v1 plumbing tests

- [x] **Owner:** Claude (2026-09-19)
- [x] **Dependencies:** Chunks A through E
- [x] **Files:** `test/v1-e2e.test.ts` (new)
- [x] Run a generic coding-question request through the proxy, mocked providers, fan-out barrier, mocked Jev endpoint, and original caller response.
- [x] Verify all attempts complete before judging, the winner is returned unchanged, failures are sanitized, and no streaming events are emitted.
- [x] **Exit criteria:** one end-to-end test exercises the complete v1 path with no live credentials required.

**Chunk F results:** `test/v1-e2e.test.ts` runs real requests through `createV1Router()` with the real graph and provider/Jev clients (no mocked graph, unlike `test/api.test.ts`), against a single stubbed `global.fetch` that dispatches by URL to a fake provider box vs. a fake Jev box. Covers: two fan-out routes both called and completed before the Jev call fires (asserted via call order), Jev's own winner choice being what's returned (not the local heuristic's pick), one failed + one succeeded attempt still reaching Jev with just the survivor, and an all-failed pool short-circuiting to `no_viable_candidates` without ever calling Jev.

#### Chunk G — Documentation, configuration, and local validation

- [x] **Owner:** Claude (2026-09-19)
- [x] **Dependencies:** Chunks A through E
- [x] **Files:** `README.md`, `env.template`, `test-integration.mjs`; `wrangler.jsonc`/`Justfile` needed no changes (no vars declared there for any provider key today, and all required recipes already existed)
- [x] Document the v1 endpoints, authentication, provider configuration, Jev endpoint configuration, and local development commands.
- [x] Add only the environment variables and Wrangler bindings required by the completed v1 contract.
- [x] Run local proxy smoke tests with mocked or configured providers and Jev.
- [x] **Exit criteria:** documentation and configuration match the implemented contract; `just dev`, `just test`, `just typecheck`, and `just build` are usable.

**Chunk G results:** README now documents the `/v1/*` and `/runs` endpoints, the `modelConfigs`/`fanout` registration format, and the Jev bypass/fallback/strict behavior. `env.template` documents `JEV_API_ENDPOINT`/`JEV_API_KEY`/`JEV_ON_FAILURE`. `test-integration.mjs` gained a `testJevJudging()` step exercising `callJevJudge` - it skips itself with a clear message when `JEV_API_ENDPOINT` is unset, since there is no real Jev deployment (and the local vLLM box is not a stand-in for one) to test against yet; run it manually with a real Jev endpoint configured to confirm live connectivity.

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

- `npm test`: 168/168 passing across `test/contracts.test.ts`, `test/jev-client.test.ts`, `test/rubrics.test.ts`, `test/routing-errors.test.ts`, `test/providers.test.ts`, `test/e2e.test.ts`, `test/judge.test.ts`, `test/proxy.test.ts`.
- `npm run typecheck`: passing on the last run (2026-09-19).
- All of Wave 0 through Wave 3 (Chunks 0, A-G) are now checked off; v1 as scoped in this file is implemented.
- Architecture correction (2026-09-19): an earlier pass on Chunk E misread "the actual Jev endpoint" as an LLM to prompt directly, and built a whole prompt/streaming/`<think>`-parsing layer around that. That was wrong - JudgeJev is a fan-out proxy, and Jev is its own separate typesafe judging service, never one of the models JudgeJev fans requests out to or lists as available. `src/jev-client.ts` is now a plain typesafe HTTP client (POST `V1JevRequest`, decode `V1JevResponse`), with no prompt-building, streaming, or reasoning-model handling in it at all - none of that belongs at this layer.
- `npx tsx test-integration.mjs` run against the real local vLLM box (2026-09-19), pre-correction: single request and 5x fan-out both pass live. This surfaced and fixed a real pre-existing bug in the script itself, unrelated to Jev: the fan-out test's routes never matched `state.models` (silently resolved to 0 workers every run) and the single-request test never sent a `model` field at all (silently omitted by `JSON.stringify`, only "working" because the box falls back to its one loaded model) - both fixed to use the real served model name (`Qwen/Qwen3-1.7B`, override via `VLLM_MODEL`). The script's `testJevJudging()` step now skips itself (no real Jev deployment exists to test against) rather than pointing at that same vLLM box, which was never a valid stand-in for the actual typesafe Jev service.
- File/folder reorganization (2026-09-19): the project had accumulated several folders holding exactly one file (`auth/`, `jev/`, `judge/`, `runs/`, `v1/`), plus a genuinely confusing collision between the `src/v1/` folder (contracts) and the `src/api/v1.ts` file (the proxy router) - both named "v1" for unrelated things. Flattened the one-file folders into `src/*.ts` (`credentials.ts`, `judge.ts`, `jev-client.ts`, `run-repository.ts`), renamed `src/v1/contracts.ts` -> `src/contracts.ts` and `src/api/v1.ts` -> `src/api/proxy.ts` (dropping "v1" as an internal module identity - it's not our own versioning, it just mirrors the upstream `/v1/...` HTTP paths, which is where that concept actually belongs), and mirrored the renames in `test/` (`contracts.test.ts`, `e2e.test.ts`, `proxy.test.ts`, `fixtures/contracts.ts`). Earlier entries in this file below still reference the old paths (`src/v1/contracts.ts`, `src/api/v1.ts`, `test/api.test.ts`, etc.) as a historical record of when that work happened - they are not current paths.
- Removed the legacy per-provider `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/`GEMINI_BASE_URL` env vars entirely (2026-09-19) in favor of the `MODEL_CONFIGS` array (JSON, same shape as the request body's `modelConfigs`) as the only way to register a default route, each with its own `endpoint`/`apiKey`/`fanout`. `.env`/`env.template` use the real local vLLM box as the example. `getProviderConfig` in `index.ts`/`proxy.ts` is now apiKey-only (`getProviderApiKey`).
- **Jev is TypeSafe.ai, a real fixed public API - not a "bring your own endpoint" service** (2026-09-19, per https://docs.typesafe.ai): `JEV_API_ENDPOINT` was never something a deployment needed to configure, and the whole earlier "typesafe HTTP client, POST V1JevRequest, decode V1JevResponse" design was still wrong - it invented its own wire contract instead of speaking TypeSafe's actual API (`POST https://api.typesafe.ai/v1/systemone`, Bearer auth, a `{state, model, questions}` body where a `choice` question's `criteria` names the options). `src/jev-client.ts` now adapts our internal `V1JevRequest` into a single TypeSafe `choice` question (candidate ids as options, their content in `state`, the rubric as instructions) and decodes `answers.winner.choice` back into `V1JevResponse`. The endpoint defaults to the real TypeSafe URL (override only exists for tests/mocks); activation is gated on `JEV_API_KEY` being set, not on an endpoint. `JEV_MODEL` selects the Jev version (`jev-latest` default). Verified live against the real API with the key already in `.env`: single judge call and the full `/v1/chat/completions` path both return real TypeSafe verdicts.
- Removed D1 entirely (2026-09-19): it only ever backed the `/runs` debug/inspection API (the real product surface, `/v1/*`, is stateless and never touched it), and didn't actually provide what it looked like it provided - `POST /runs/:id/judge` runs the whole fan-out+judge pipeline synchronously in one request, so there was never a "resume a long-running job after the Worker relocated" scenario to guard against. Its only real value was letting the separate `create` and `judge` calls see the same state across different Worker isolates, which wasn't judged worth the complexity. `D1RunRepository`, `JEV_RUNS_SCHEMA`, and the `d1_databases` bindings in `wrangler.jsonc` are gone; `/runs` now always uses a single module-level `MemoryRunRepository` (shared for the isolate's lifetime, not across isolates or restarts). `Justfile`'s `db-create`/`db-execute`/`db-execute-file` recipes removed.
- Pluggable rubrics + Jev-picks-the-rubric (2026-09-19): the rubric was hardcoded (`GENERIC_CODING_RUBRIC` in `contracts.ts`) and coding-specific, but JudgeJev judges any kind of response, not just code, and the rubric needs to be iterated on without touching wire contracts. `contracts.ts` now only defines the rubric's *shape* (`V1Rubric`: id/version/description/instruction/questions); actual rubric content moved to a new pluggable registry, `src/rubrics.ts` (`RUBRICS`, `getRubric`, `listRubrics`) - currently `general-v1` (default) and `coding-v1`, add more there as needed. Two Jev calls now happen per `/v1/*` request instead of one: `selectRubric()` (new, in `jev-client.ts`) is fired alongside the fan-out - not after it - asking Jev to pick the best-fit rubric (by `description`) for the original request from `listRubrics()`, so it's normally already resolved by the time candidates are ready to judge (see `selectRubricForRequest` in `proxy.ts`, called before `graph.invoke` and awaited after). The selected rubric's questions then become the judging call's instructions. Rubric-selection failure (or `JEV_API_KEY` unset) falls back to `general-v1` silently - it never surfaces as a `judge_error` and is independent of `JEV_ON_FAILURE`, which only governs the judging call. Verified live against the real TypeSafe API: a coding request correctly picked `coding-v1`, a non-coding request picked `general-v1`, and the full concurrent fan-out+rubric-selection+judging path returns a real result end to end.
- No commit has been made.
