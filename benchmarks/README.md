# Benchmarks

This directory exists so JudgeJev's claims are checkable, not just asserted: for each area we test, we publish what we measured, how, and on what hardware/config, so someone else can rerun it and get a comparable result. If a number here can't be reproduced from the methodology described, that's a bug in the writeup - open an issue.

## What's here

- [`concurrency.md`](concurrency.md) - raw inference throughput under concurrent load, at various prompt sizes, with and without prefix-cache-friendly prompts. This is an infrastructure-level benchmark of the underlying model server (vLLM), not of JudgeJev's own proxy/fan-out/judging overhead.
- [`accuracy.md`](accuracy.md) - does fanning the same request out to multiple (often small/cheap) models and having Jev pick a winner actually produce a better answer than a single model call? Single-model baseline collected via [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) (see [`lm-eval-harness/`](lm-eval-harness/)); the "through JudgeJev" comparison hasn't run yet.

## Planned

- The "through JudgeJev" side of the accuracy benchmark: same task/seed as the collected baseline, pointed at JudgeJev's own `/v1/chat/completions` instead of the model directly.
- A JudgeJev-level concurrency/latency benchmark using [`vllm bench serve`](https://github.com/vllm-project/vllm) (vLLM's own load-testing tool, targets any OpenAI-compatible endpoint): end-to-end request time through the real proxy (fan-out + rubric selection + judging), not just the underlying inference server - to separate "how fast is the model" from "how much overhead does JudgeJev itself add." Not started.
- Rubric-selection accuracy as its own tracked metric, not folded into the general accuracy benchmark: does Jev pick the intended rubric (`coding`, `math`, `tool-call`, `translation`, `general`) for a request drawn from that domain?
