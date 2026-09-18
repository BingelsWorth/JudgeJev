# JudgeJev TODO

## Scope

Port the useful Monoize concepts into the existing TypeScript, Hono, Cloudflare Workers, and LangGraph architecture:

- Universal request/response normalization
- Model routing and provider fan-out
- Retries, failover, and stream handling
- Jev inspection, intervention, and final selection
- Proxy-compatible API behavior
- Durable run/configuration state
- Focused automated tests

Dashboard, billing, CAPTCHA, image generation, and other unrelated Monoize product features are out of scope.

## Completed

- [x] Audit the current JudgeJev architecture and the relevant Monoize source/specifications.
- [x] Add shared upstream error classification, `Retry-After` handling, exponential backoff, jitter, and sanitized upstream errors.
- [x] Add logical-model routing with provider/upstream model mapping, aliases, priority, and enabled flags.
- [x] Update OpenAI, Anthropic, and Gemini adapters to use the shared retry/error path.
- [x] Make provider-backed non-streaming fan-out concurrent.
- [x] Add basic duplicate pruning and viable-candidate judging.
- [x] Accept per-run model configurations and provider environment credentials.
- [x] Verify the current test suite and TypeScript typecheck.

## Remaining Work

### 1. Define the Universal Protocol

- [ ] Define the canonical request and response model: URP v2 or a deliberately smaller JudgeJev-compatible subset.
- [ ] Represent text, media, tools, reasoning, refusals, structured output, usage, finish reasons, and unknown-field passthrough as needed.
- [ ] Define canonical non-streaming and streaming event types.
- [ ] Define provider capability metadata and model registry records.

### 2. Implement Protocol Adapters

- [ ] Decode OpenAI Responses, Chat Completions, Anthropic Messages, and Gemini requests into the canonical model.
- [ ] Encode the canonical model into each selected provider's native request format.
- [ ] Decode provider responses back into the canonical model.
- [ ] Implement provider-specific streaming parsers and terminal-event validation.
- [ ] Preserve provider metadata without leaking provider-specific request shapes into Jev state.

### 3. Add the Proxy Contract

- [ ] Add `POST /v1/responses`, `POST /v1/chat/completions`, and `POST /v1/messages` proxy endpoints.
- [ ] Add model discovery at `GET /v1/models` if model routing is registry-backed.
- [ ] Support downstream `Authorization: Bearer` and `x-api-key` authentication.
- [ ] Define request body limits, validation errors, timeout behavior, and client-facing error envelopes.
- [ ] Implement SSE response framing and protocol-specific terminal error frames.
- [ ] Document the proxy request/response contract and example curl commands.

### 4. Build Routing and Failover

- [ ] Replace the simple route list with an ordered, weighted routing policy.
- [ ] Implement same-route retries and cross-provider fail-forward behavior.
- [ ] Track attempt budgets, route health, passive failure windows, and circuit breakers.
- [ ] Handle `Retry-After`, shared-origin failures, and provider-specific persistent errors.
- [ ] Add optional session affinity when it is useful for prompt-cache locality.
- [ ] Keep routing decisions and attempted routes visible in run state.

### 5. Complete Streaming Behavior

- [ ] Fan out streaming attempts without buffering an entire response.
- [ ] Allow provider fallback only before the first downstream application event.
- [ ] Buffer only the pre-output window required for safe failover.
- [ ] Prevent fallback after a client-visible stream event has been emitted.
- [ ] Detect idle streams, malformed protocol events, missing terminals, and mid-stream failures.
- [ ] Emit a canonical event stream that can be rendered by each downstream protocol.

### 6. Integrate Jev Orchestration

- [ ] Feed canonical candidate responses and checkpoints into the LangGraph state.
- [ ] Implement meaningful `continue`, `kill`, `restart`, `redirect`, and `branch` decisions.
- [ ] Make intervention loops resumable and bounded.
- [ ] Preserve intermediate observations without exposing hidden chain-of-thought.
- [ ] Replace the longest-content heuristic with an explicit judging policy or judge model.
- [ ] Define the final-output policy: unchanged winner, synthesized answer, or another deterministic format.

### 7. Harden Persistence and Credentials

- [ ] Add versioned D1 migrations instead of runtime-only schema creation.
- [ ] Persist run state, model configurations, attempts, checkpoints, usage, and routing decisions.
- [ ] Implement durable resume/interrupt behavior for long-running graphs.
- [ ] Replace the in-memory credential store with encrypted D1 or another durable store.
- [ ] Define credential selection for BYOT, per-route, and default provider credentials.
- [ ] Ensure secrets are never stored in logs, run state, or client responses.

### 8. Add Focused Tests

- [ ] Test canonical request/response conversion for every supported provider.
- [ ] Test non-streaming and streaming parsers, including malformed and incomplete streams.
- [ ] Test retry classification, backoff, `Retry-After`, attempt budgets, and failover.
- [ ] Test route resolution, aliases, weights, disabled routes, and capability filtering.
- [ ] Test proxy validation, authentication, SSE framing, and error responses.
- [ ] Test fan-out concurrency, pruning, intervention, restart, branching, and judging.
- [ ] Test D1 migrations, persistence, resume, and credential handling.
- [ ] Add fixture-based protocol round-trip tests.

### 9. Final Validation

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run the configured build command.
- [ ] Run local proxy smoke tests with mocked or configured providers.
- [ ] Run `git diff --check` and review the final diff.
- [ ] Update `README.md`, `env.template`, and Wrangler configuration for the completed contract.

## Current Validation

- `npm test`: 5/5 passing.
- `npm run typecheck`: passing.
- The current working tree contains uncommitted implementation changes; no commit has been made.
