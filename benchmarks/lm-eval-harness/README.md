# lm-evaluation-harness setup

Accuracy benchmarking tooling for [`../accuracy.md`](../accuracy.md). Uses [EleutherAI's lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), the standard LLM eval framework, so scores here are comparable to published numbers for the same model/task elsewhere - not just internally consistent.

This is a separate Python environment (`uv`-managed venv), kept isolated from the main TypeScript project. Nothing here is part of `npm test`.

## Setup

Requires [`uv`](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

(`./run-baseline.sh` does this automatically on first run.)

## Running the baseline (single model, no JudgeJev)

```bash
./run-baseline.sh [base_url] [model] [tasks] [limit] [output_name]
```

Defaults: `http://192.168.2.106:8000/v1/chat/completions`, `Qwen/Qwen3-1.7B`, `gsm8k`, `100`, `baseline-single-model` - matching the committed results.

This targets the model directly - no fan-out, no Jev. It's step one: establish what the model scores on its own before JudgeJev can be meaningfully compared against it. The eventual "through JudgeJev" run reuses the same script, pointed at JudgeJev's own `/v1/chat/completions` (which is itself OpenAI-compatible) instead of the raw model server, with `model` set to whichever logical/fan-out model name routes to the same underlying model(s).

## Why `local-chat-completions` and `think_end_token`

- `local-chat-completions` is lm-eval-harness's model type for any OpenAI-compatible chat completions endpoint - both a raw provider box and JudgeJev's proxy expose this shape, so the same harness setup works for both "before" and "after" runs.
- `Qwen/Qwen3-1.7B` is a reasoning model: it emits a `<think>...</think>` block before answering. `think_end_token=</think>` tells the harness to strip everything up through that tag before grading the answer - the harness's own documented mechanism for this, not a JudgeJev-specific workaround. `max_gen_toks` is set generously (3000) because that thinking can run long before the model reaches its actual answer.

## Results

`results/<name>/` - one directory per run, containing the aggregated scores and (with `--log_samples`) every individual sample's prompt/response/grade, so a reviewer can spot-check specific failures, not just trust the aggregate number.
