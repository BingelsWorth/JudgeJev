# Concurrency benchmark: Qwen3-1.7B parallel inference

> These results are a synthetic testing point, not production workload data. They are kept here as a baseline for comparing future models, inference settings, and hardware. This measures the underlying inference server directly (vLLM) - it does not go through JudgeJev's proxy, fan-out, rubric-selection, or judging layers. A JudgeJev-level version of this benchmark (measuring end-to-end request time through the real `/v1/*` path) is planned - see [`README.md`](README.md).

## Test Configuration

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

## Same Prompt / Prefix-Cache Friendly

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

## Unique Prompts / No Shared Prefix

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

## Prefix Cache Impact at Concurrency 5

| Prompt | Same Prompt tok/s | Unique Prompt tok/s | Same Wall Time | Unique Wall Time |
| ------ | ----------------: | ------------------: | -------------: | ---------------: |
| ~2k    |             243.9 |               221.9 |          5.25s |            5.77s |
| ~4k    |             235.3 |               150.0 |          5.44s |            8.53s |
| ~8k    |             210.9 |                83.6 |          6.07s |           15.31s |
| ~16k   |             179.6 |                46.5 |          7.13s |           27.52s |

## Actual Prompt Token Counts

The synthetic prompt generator did not land exactly on the nominal context sizes.

| Target | Same Prompt | Unique Prompt |
| ------ | ----------: | ------------: |
| 2k     |       1,907 |         2,076 |
| 4k     |       3,774 |         4,113 |
| 8k     |       7,508 |         8,182 |
| 16k    |      14,629 |        15,943 |

## Notes

The workload is intended to approximate Judge Jev-style fan-out, where several inference requests are launched concurrently.

`SAME` represents requests sharing essentially the same context and therefore benefiting from vLLM prefix caching.

`UNIQUE` represents independent contexts and is intended as the more pessimistic comparison where shared-prefix caching cannot substantially reduce prompt processing.

These numbers should be treated as a baseline for this specific model, hardware, vLLM configuration, and synthetic prompt workload rather than general model-performance claims.
