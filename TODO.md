# JudgeJev TODO

Working file: persistent record of decisions and follow-ups, kept lean so future work can pick up without session history. Completed-work history has been trimmed - see git log for the detailed record.

## Status

The original v1 goal is done and live-verified: an LLM fan-out proxy (`/v1/responses`, `/v1/chat/completions`, `/v1/messages`) that fans a request out concurrently to configured provider/model routes, waits for every attempt, prunes duplicates, and has Jev ([TypeSafe.ai](https://docs.typesafe.ai)) pick the winner against a rubric it also selects per request. `npm test` passing, typecheck clean.

## Future work

- Streaming, SSE, and pre-output provider fallback.
- Live checkpoints, intervention, restart, redirect, and branching.
- Durable state (checkpoints, long-running graph persistence) if ever needed - D1 was deliberately removed (see below), so this means re-adding a repository backend, not restoring one.
- Additional rubrics as new failure modes show up (e.g. summarization, multi-step agentic tasks); tune existing rubric wording as real judging data comes in.
- Weighted routing, route health, circuit breakers, session affinity, durable routing state.
- Dashboard, billing, CAPTCHA, image APIs, deployment/replica, metering.
- Monoize (`Ikaleio/monoize`) remains the reference for non-streaming routing/retry/protocol-conversion behavior if any of the above is picked up.
- **Concurrency benchmark tooling**: wire up `vllm bench serve` (vLLM's own load-testing tool, targets any OpenAI-compatible endpoint) to measure end-to-end request time through the real JudgeJev proxy (fan-out + rubric selection + judging) vs. the raw inference server directly - separates "how fast is the model" from "how much overhead does JudgeJev add." See [`benchmarks/README.md`](benchmarks/README.md) ("Planned"). Not started - accuracy benchmarking (`benchmarks/lm-eval-harness/`) came first.

## Decisions worth knowing before touching related code

- **D1 is gone.** `/runs` (debug/inspection only - the real `/v1/*` path is stateless and never used it) now runs on an in-memory repository, scoped to a single Worker isolate's lifetime. Deliberate simplification: `POST /runs/:id/judge` always ran the whole fan-out+judge pipeline synchronously in one request, so D1 was never protecting an in-progress job - its only value was letting `create` and `judge` (separate calls) see the same state across isolates, which wasn't worth the complexity.
- **Jev is TypeSafe.ai, a fixed public API - never a per-deployment endpoint.** `JEV_API_ENDPOINT` exists only as a test/mock override. Whether Jev actually judges is gated on `JEV_API_KEY` being set; unset falls back to a local longest-candidate heuristic.
- **Rubrics are pluggable and Jev picks one per request.** `src/rubrics.ts` holds the registry (`general`, `coding`, `math`, `tool-call`, `translation`); `contracts.ts` only defines the rubric's shape. `selectRubric()` runs concurrently with the fan-out (not after it), so it's normally already resolved by the time there are candidates to judge. Add new rubrics in `rubrics.ts`.
- **No per-provider base-URL or API-key env fallback.** Every route (`modelConfigs` in a request, or `MODEL_CONFIGS` env) must carry its own `endpoint` and `apiKey`.
