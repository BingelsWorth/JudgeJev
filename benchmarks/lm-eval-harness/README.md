# lm-evaluation-harness setup

Accuracy benchmarking tooling for [`../accuracy.md`](../accuracy.md). Uses [EleutherAI's lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), the standard LLM eval framework, so scores here are comparable to published numbers for the same model/task elsewhere - not just internally consistent.

This is a separate Python environment (`uv`-managed venv), kept isolated from the main TypeScript project. Nothing here is part of `npm test`.

## Setup

Requires [`uv`](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

(`./run-gsm8k.sh` and `./run-baseline-humaneval.sh` both do this automatically on first run.)

## Running `gsm8k` (math, chat completions) - baseline or through JudgeJev

One script, `target` picks which one it hits, so the two runs can't drift apart from each other:

```bash
./run-gsm8k.sh [target] [tasks] [limit] [output_name]
```

- `target=baseline` (default) - hits `${MODEL_SERVER_URL}/v1/chat/completions` directly (`MODEL_SERVER_URL` from the repo-root `.env`, falls back to `http://192.168.2.106:8000` if unset). No fan-out, no Jev. Other defaults: `gsm8k`, `100`, `baseline-single-model` - matching the committed results.
- `target=judgejev` - hits JudgeJev's proxy instead (`http://localhost:8787/v1/chat/completions`, model `fast` - the logical/fan-out name from `MODEL_CONFIGS`, not an upstream model id). Requires JudgeJev running first:

  ```bash
  # From the repo root, in another terminal:
  npm run dev   # starts JudgeJev at http://localhost:8787, reading MODEL_CONFIGS/JEV_API_KEY from .env

  # Then, once http://localhost:8787/health responds:
  ./run-gsm8k.sh judgejev
  ```

  Same task, sample count, and seed as the baseline by default, so the two are directly comparable - `local-chat-completions` doesn't care which OpenAI-compatible endpoint it's talking to, only the `target` argument changes which one it hits.

**Before comparing results**, confirm both runs actually asked the model the same question - `benchmarks/lm-eval-harness` has no way to catch a bug on the JudgeJev side that changes what the fanned-out models receive (this exact thing happened once: `state.request` was briefly the JSON-encoded request envelope instead of the real question - see `test/e2e.test.ts`'s "Prompt extraction" regression test and `test/proxy.test.ts`'s prompt-extraction suite for the coverage that now guards against it).

## Running `humaneval` (coding, raw completions - see below for why)

Baseline only - see "Why raw completions for humaneval" below for why this can't go through JudgeJev the same way `gsm8k` does.

```bash
./run-baseline-humaneval.sh [base_url] [model] [output_name] [limit]
```

`base_url` defaults to `${MODEL_SERVER_URL}/v1/completions` (note: `/v1/completions`, not `/v1/chat/completions`), reading `MODEL_SERVER_URL` from the repo-root `.env` (falls back to `http://192.168.2.106:8000` if unset). Other defaults: `Qwen/Qwen3-1.7B`, `baseline-humaneval`, full 164-problem set - matching the committed results.

## Why `local-chat-completions` + `think_end_token` for gsm8k

- `local-chat-completions` is lm-eval-harness's model type for any OpenAI-compatible chat completions endpoint - both a raw provider box and JudgeJev's proxy expose this shape, so the same harness setup works for both "before" and "after" runs.
- `Qwen/Qwen3-1.7B` is a reasoning model: it emits a `<think>...</think>` block before answering. `think_end_token=</think>` tells the harness to strip everything up through that tag before grading the answer - the harness's own documented mechanism for this, not a JudgeJev-specific workaround. `max_gen_toks` is set generously (3000) because that thinking can run long before the model reaches its actual answer.

## Why raw completions for `humaneval`, not `local-chat-completions`

`humaneval`'s "instruct" variant (and `mbpp_instruct`) assume the backend can **pre-fill the assistant's turn**, so the model's generation continues an already-open code fence and its own first ` ``` ` marks the *close*. Plain OpenAI-compatible chat completions has no such feature, so the model writes its own fresh opening fence instead - and every shipped extraction filter for these instruct tasks then grabs the wrong span. Confirmed directly: every instruct variant scored ~0 regardless of code quality, across multiple independent attempts with different fixes (removing stop sequences, raising token budgets, switching tasks).

The fix is `--tasks humaneval` (the *base*, non-chat task) against the model's raw `/v1/completions` endpoint (`local-completions`, no `--apply_chat_template`) - true text continuation, no chat template, no thinking. Two things needed overriding from the task's defaults to make this work against vLLM specifically:

- `until=["\nclass","\ndef","\n#","\nif"]` - the base task's default stop list has 5 entries, but vLLM's OpenAI-compatible server rejects more than 4 stop sequences per request (`local-chat-completions` silently truncates to 4 for you; `local-completions` doesn't, so it needs this override or you'll get a 400).
- `HF_ALLOW_CODE_EVAL=1` env var - HumanEval scores by executing the model's generated code; this is that benchmark's own documented consent gate (separate from lm-eval-harness's own `--confirm_run_unsafe_code` flag, which is also required).

This also means the coding-through-JudgeJev comparison isn't a solved problem yet: JudgeJev has no raw-completions endpoint to point `local-completions` at (see the open question in `../accuracy.md`).

## Results

`results/<name>/` - one directory per run, containing the aggregated scores and (with `--log_samples`) every individual sample's prompt/response/grade, so a reviewer can spot-check specific failures, not just trust the aggregate number.
