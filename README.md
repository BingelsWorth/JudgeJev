# JudgeJev

An LLM fan-out proxy: send one request, JudgeJev fires it at multiple (often small, cheap, occasionally-wrong) models concurrently, and [Jev](https://docs.typesafe.ai) judges the candidates and returns the best one - in the shape of a normal single-model response.

A client sends a normal OpenAI/Anthropic-shaped request. JudgeJev waits for every fanned-out attempt to finish or fail, has Jev pick the winner, and returns it in the original request's response shape - the caller can't tell it wasn't a single upstream call. Other than streaming responses and thinking being removed.

## Endpoints

| Method | Path | Downstream shape |
| --- | --- | --- |
| POST | `/v1/responses` | OpenAI Responses API |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API |
| POST | `/v1/messages` | Anthropic Messages API |
| POST | `/runs`, GET `/runs`, GET/DELETE `/runs/:id`, POST `/runs/:id/judge` | Internal run-state API (not protocol-shaped; mainly for debugging/inspection). In-memory only - doesn't survive a restart or a request landing on a different isolate. |

All three `/v1/*` endpoints are non-streaming (`stream: false` only) and accept the same request body as the corresponding upstream API, plus two optional JudgeJev-specific fields:

- `models: string[]` - logical model names to run this request against.
- `modelConfigs: ModelRoute[]` - explicit provider registrations for this request (see below). When omitted, JudgeJev defaults to a single OpenAI route matching the request's `model`.

### Registering models and fan-out

Each entry in `modelConfigs` is a route registration:

```json
{
  "name": "local-qwen",
  "provider": "openai",
  "model": "Qwen/Qwen3-1.7B",
  "endpoint": "http://192.168.2.106:8000/v1",
  "apiKey": "optional-per-route-key",
  "fanout": { "fast": 2, "coding": 1 }
}
```

`fanout` is a dictionary of logical model name -> attempt count. When an inbound request asks for `model: "fast"`, JudgeJev walks every registered route, and for each one whose `fanout` map has a `"fast"` entry, fans out that many concurrent calls to it. A route with no `fanout` falls back to matching its own `name`/`logicalModel`/`aliases` directly (legacy single-route behavior).

When a request doesn't supply its own `modelConfigs`, JudgeJev falls back to the `MODEL_CONFIGS` environment variable - the same JSON array shape, letting you register default routes (e.g. a local box) without repeating them on every call. There is no separate per-provider base-URL setting; a route's `endpoint` is the only way to point it somewhere other than the provider's real API.

## Jev judging

Jev - [TypeSafe's](https://docs.typesafe.ai) decision model, a fixed public API - picks the winning candidate. It's not an LLM JudgeJev prompts itself, and not one of the models in its own fan-out list.

`src/jev-client.ts` adapts the original request, every candidate, and a rubric into a single TypeSafe [`choice`](https://docs.typesafe.ai/primitives/choice) question (`POST https://api.typesafe.ai/v1/systemone`) - the candidate ids are the options, their content lives in `state`, and the rubric becomes the instructions - then decodes the winning choice back into JudgeJev's response.

- `JEV_API_KEY` unset (default): skip Jev entirely and serve the longest-candidate local heuristic. This is the dev-time bypass - useful before you have a Jev key.
- `JEV_API_KEY` set: ask Jev to choose and return its chosen candidate unchanged. There's no endpoint to configure - it's fixed and public.
- `JEV_MODEL`: which Jev version to use (`jev-latest`, `jev-preview`, or a pinned version). Defaults to `jev-latest`.
- `JEV_ON_FAILURE`: if the judging call itself fails (network error, undecodable verdict, etc.), `fallback` (default) silently serves the local heuristic's winner; `error` returns a `judge_error` instead. Use `error` while testing Jev integration so a broken call can't be masked by the fallback.

### Rubrics

The rubric a request is judged against isn't fixed - it's picked per request. `src/rubrics.ts` holds a small, pluggable registry (`RUBRICS`, keyed by id) meant for quick iteration: add, edit, or retire a rubric there without touching any wire contract. Each rubric has a `description` (what it's for, shown to Jev when picking) and a set of `questions` to weigh when comparing candidates.

Two Jev calls happen per request, not one:

1. **Rubric selection**, fired alongside the fan-out (not after it) - Jev is given the original request and every registered rubric's `description`, and picks the best fit. Since this runs concurrently with the provider calls, it's normally already resolved by the time there are candidates to judge, at no added latency.
2. **Judging**, once candidates are in - the selected rubric's questions become the judge's instructions.

If rubric selection fails or `JEV_API_KEY` is unset, it silently falls back to the default rubric (`general`) - that failure never surfaces as a `judge_error` or interacts with `JEV_ON_FAILURE`, which only governs the judging call itself.

Registered by default: `general`, `coding`, `math`, `tool-call`, `translation`.

See [`env.template`](env.template) for the full list of environment variables (`MODEL_CONFIGS`, Jev config).

## Local development

```bash
npm install
cp env.template .env   # fill in MODEL_CONFIGS / Jev key
npm test                # vitest
npm run typecheck       # tsc --noEmit
npm run dev              # wrangler dev
```

## Benchmarks

JudgeJev's core claim - fan-out + Jev judging beats a single model call - is checkable, not just asserted. See [`benchmarks/`](benchmarks/) for methodology and results: a concurrency benchmark of the underlying inference server, and an accuracy benchmark (methodology published, results in progress) comparing JudgeJev's winner against single-model baselines.
