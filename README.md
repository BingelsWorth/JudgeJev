# JudgeJev
DeepThink meets llm as judge. Use heavy prefill caching to run the same request in parallel and let Jev give you the best result.

## What it does

A client sends one normal OpenAI/Anthropic-shaped request to JudgeJev. JudgeJev fans that request out concurrently to every configured provider/model route, waits for all attempts to finish, has Jev pick the best candidate, and returns that winner in the original request's response shape - the caller can't tell it wasn't a single upstream call.

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

JudgeJev is an LLM fan-out proxy: it fans one request out to every configured provider/model route, then hands the results to Jev - [TypeSafe's](https://docs.typesafe.ai) decision model, a fixed public API, not an LLM JudgeJev prompts itself and not one of the models in its own fan-out list - which decides which candidate wins.

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

If rubric selection fails or `JEV_API_KEY` is unset, it silently falls back to the default rubric (`general-v1`) - that failure never surfaces as a `judge_error` or interacts with `JEV_ON_FAILURE`, which only governs the judging call itself.

See [`env.template`](env.template) for the full list of environment variables (`MODEL_CONFIGS`, Jev config).

## Local development

```bash
npm install
cp env.template .env   # fill in MODEL_CONFIGS / Jev key
npm test                # vitest
npm run typecheck       # tsc --noEmit
npm run dev              # wrangler dev
```

`test-integration.mjs` (`npx tsx --env-file=.env test-integration.mjs`) exercises a real local provider box and Jev endpoint end-to-end - useful for confirming connectivity that the mocked unit tests can't cover.





## Qwen3-1.7B Parallel Inference Benchmark

> These results are a synthetic testing point, not production workload data. They are kept here as a baseline for comparing future models, inference settings, and hardware.

### Test Configuration

| Setting                | Value                      |
| ---------------------- | -------------------------- |
| Model                  | `Qwen/Qwen3-1.7B`          |
| GPU                    | NVIDIA GeForce RTX 3070 Ti |
| Inference Server       | vLLM                       |
| Max Model Length       | 16,384 tokens              |
| KV Cache               | BF16                       |
| GPU Memory Utilization | 80%                        |
| Attention Backend      | `TRITON_ATTN`              |
| Prefix Caching         | Enabled                    |
| Max Sequences          | 10                         |
| Output Length          | 256 tokens                 |
| Concurrency Tested     | 1, 3, 5                    |
| Context Sizes          | ~2k, ~4k, ~8k, ~16k        |

### Same Prompt / Prefix-Cache Friendly

Aggregate generated tokens per second:

| Prompt |   C1 |    C3 |    C5 |
| ------ | ---: | ----: | ----: |
| ~2k    | 54.7 | 154.8 | 243.9 |
| ~4k    | 52.8 | 151.2 | 235.3 |
| ~8k    | 47.9 | 140.2 | 210.9 |
| ~16k   | 40.2 | 127.4 | 179.6 |

Wall-clock time to complete the full batch:

| Prompt |    C1 |    C3 |    C5 |
| ------ | ----: | ----: | ----: |
| ~2k    | 4.68s | 4.96s | 5.25s |
| ~4k    | 4.85s | 5.08s | 5.44s |
| ~8k    | 5.35s | 5.48s | 6.07s |
| ~16k   | 6.36s | 6.03s | 7.13s |

### Unique Prompts / No Shared Prefix

Aggregate generated tokens per second:

| Prompt |   C1 |    C3 |    C5 |
| ------ | ---: | ----: | ----: |
| ~2k    | 55.1 | 140.8 | 221.9 |
| ~4k    | 52.4 | 132.9 | 150.0 |
| ~8k    | 44.6 |  78.8 |  83.6 |
| ~16k   | 34.0 |  50.1 |  46.5 |

Wall-clock time to complete the full batch:

| Prompt |    C1 |     C3 |     C5 |
| ------ | ----: | -----: | -----: |
| ~2k    | 4.65s |  5.45s |  5.77s |
| ~4k    | 4.89s |  5.78s |  8.53s |
| ~8k    | 5.74s |  9.75s | 15.31s |
| ~16k   | 7.53s | 15.32s | 27.52s |

### Prefix Cache Impact at Concurrency 5

| Prompt | Same Prompt tok/s | Unique Prompt tok/s | Same Wall Time | Unique Wall Time |
| ------ | ----------------: | ------------------: | -------------: | ---------------: |
| ~2k    |             243.9 |               221.9 |          5.25s |            5.77s |
| ~4k    |             235.3 |               150.0 |          5.44s |            8.53s |
| ~8k    |             210.9 |                83.6 |          6.07s |           15.31s |
| ~16k   |             179.6 |                46.5 |          7.13s |           27.52s |

### Actual Prompt Token Counts

The synthetic prompt generator did not land exactly on the nominal context sizes.

| Target | Same Prompt | Unique Prompt |
| ------ | ----------: | ------------: |
| 2k     |       1,907 |         2,076 |
| 4k     |       3,774 |         4,113 |
| 8k     |       7,508 |         8,182 |
| 16k    |      14,629 |        15,943 |

### Notes

The workload is intended to approximate Judge Jev-style fan-out, where several inference requests are launched concurrently.

`SAME` represents requests sharing essentially the same context and therefore benefiting from vLLM prefix caching.

`UNIQUE` represents independent contexts and is intended as the more pessimistic comparison where shared-prefix caching cannot substantially reduce prompt processing.

These numbers should be treated as a baseline for this specific model, hardware, vLLM configuration, and synthetic prompt workload rather than general model-performance claims.
