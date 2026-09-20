# lm-evaluation-harness setup

Accuracy benchmarking tooling for [`../accuracy.md`](../accuracy.md). Uses [EleutherAI's lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness), the standard LLM eval framework, so scores here are comparable to published numbers for the same model/task elsewhere - not just internally consistent.

This is a separate Python environment (`uv`-managed venv), kept isolated from the main TypeScript project. Nothing here is part of `npm test`.

## Setup

Requires [`uv`](https://docs.astral.sh/uv/):

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

(`./run-gsm8k.sh` and `./run-humaneval.sh` both do this automatically on first run.)

## Running the whole suite: `run-suite.sh`

Orchestrates every task below sequentially - one `lm_eval` invocation at a time, never in the background or in parallel, so results stay reproducible and the shared vLLM box never gets two suites' worth of concurrent load. Baseline runs once per temperature per task (it doesn't depend on fan-out size, so there's no reason to repeat it for every fan-out comparison); through-JudgeJev repeats 3x per temperature per task by default, to average out the run-to-run variance fan-out+judging actually has.

Covers every rubric in `src/rubrics.ts` that has an automated score, except `tool-call` (no lm-eval-harness task exists for it - see the note in `run-suite.sh`'s own header):

| Rubric | Task | What it measures |
| --- | --- | --- |
| `coding` | `humaneval` | Python function completion, pass@1 |
| `coding` (2nd opinion) | `mbpp` | Same idea, different problem set |
| `math` | `gsm8k` | Grade-school word problems |
| `math` (2nd opinion) | `math500` | Harder problems (MATH-500) |
| `general` | `mmlu` | Broad knowledge, 57 subjects |
| `translation` | `wmt16` | English→German, BLEU/TER/chrF |

```bash
./run-suite.sh                          # everything
./run-suite.sh --only humaneval
./run-suite.sh --only humaneval,mbpp    # comma-separated list
./run-suite.sh --judgejev-runs 5        # override the default 3 repeats
./run-suite.sh --skip-baseline          # only refresh judgejev runs - baseline unchanged
./run-suite.sh --limit 20               # quick smoke test of the whole suite
```

`run-suite.sh` on its own doesn't touch fan-out size - see `run-fanout-sweep.sh` below for that.

## Sweeping fan-out size too: `run-fanout-sweep.sh`

Automates the one thing `run-suite.sh` can't: switching `MODEL_CONFIGS`' fan-out count between full suite passes. For each size in the sweep, it rewrites the repo-root `.env`'s `MODEL_CONFIGS` (every other line, including `JEV_API_KEY`, is left untouched), restarts `npm run dev` so the change actually takes effect (wrangler doesn't hot-reload env vars), waits for `/health`, runs `run-suite.sh` (baseline only on the *first* size - it doesn't depend on fan-out), then stops the server before moving to the next size.

```bash
./run-fanout-sweep.sh                       # sweeps fan-out 3 then 5
./run-fanout-sweep.sh --fanouts 2,3,5
./run-fanout-sweep.sh --only humaneval --judgejev-runs 5 --limit 20   # passthrough flags
```

**Your `.env` is always restored to its original contents when this exits** - normally, on error, or on Ctrl-C - and any dev server it started is always stopped first. It's a scratch config for the sweep's duration only; nothing about your working setup persists past it. Verified directly: mutated `MODEL_CONFIGS` to `fanout: 3`, confirmed a real run through the live server produced exactly 3 workers, then confirmed `.env` and the server were both back to their original state after.

**Results are labeled by fan-out size automatically.** Every judgejev results folder gets `-fanout_<N>` appended (e.g. `through-judgejev-humaneval-temp_0.7-fanout_3` vs. `...-fanout_5`) via `--fanout-label`, which this script passes to `run-suite.sh` with the real fan-out size for each pass - so a `--fanouts 3,5` sweep never overwrites the 3x results with the 5x ones. Baseline folders are unaffected (baseline doesn't depend on fan-out size, so it's shared across both). Running `run-suite.sh` directly (not through this script) skips labeling by default - only worth doing by hand if you're comparing fan-out sizes without the sweep script.

Still fully sequential end to end - one fan-out size's entire suite (and its one dev server) finishes before the next size's `.env` edit and restart happen.

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

## Running `humaneval` (coding, raw completions - see below for why) - baseline or through JudgeJev

Flag-based - only pass what you're changing:

```bash
./run-humaneval.sh [--target baseline|judgejev] [--temp N] [--output name] [--limit N]
```

- `--target baseline` (default) - hits `${MODEL_SERVER_URL}/v1/completions` directly (note: `/v1/completions`, not `/v1/chat/completions`; `MODEL_SERVER_URL` from the repo-root `.env`, falls back to `http://192.168.2.106:8000` if unset). No fan-out, no Jev.
- `--target judgejev` - hits JudgeJev's own `/v1/completions` instead (`http://localhost:8787/v1/completions`, model `fast`). JudgeJev fans the raw prompt out to every configured route's own raw completions API - no chat wrapping - and has Jev judge the results as plain text, same as any other endpoint. Requires JudgeJev running first (`npm run dev` from the repo root; see the `gsm8k` section above for the exact steps).
- `--temp` defaults to `0`, matching the committed `baseline-humaneval` results (0.421 ± 0.039). See "Why temperature matters" below for why `--target judgejev` needs a non-zero value to be a meaningful comparison at all.
- `--output` defaults to `baseline-humaneval` / `through-judgejev-humaneval` at `--temp 0`, or that name with `-temp_<N>` appended for any other temperature - so results at different temperatures land in their own folder automatically instead of overwriting each other, unless you pass `--output` explicitly.

```bash
./run-humaneval.sh                              # unchanged: baseline, temp 0
./run-humaneval.sh --temp 0.7                    # control: same temp as judgejev, single shot
./run-humaneval.sh --target judgejev --temp 0.7  # treatment: same temp, 5x fan-out + judge
```

## Why temperature matters here at all

This is the reason fan-out + judging can improve anything when every candidate comes from the *same* model: at a non-zero temperature, the same model asked the same question twice gives two slightly different answers, some better than others - fan out N times, have Jev grade the variants, and keep the best one. At `temperature=0` (greedy decoding) there's no variance to grade in the first place - a short completion like a HumanEval snippet comes back byte-identical every time (confirmed directly: 5x curl with the same prompt at temperature 0 returned the exact same text), and JudgeJev's own duplicate-pruning step collapses those "candidates" down to 1 before Jev ever gets a choice to make. `gsm8k` didn't need an explicit override for this because its multi-thousand-token reasoning chains pick up enough floating-point drift from batched inference to diverge even at temperature 0; `humaneval`'s short completions don't have enough tokens for that to happen.

Raising temperature also makes a *single* shot noisier on its own, independent of fan-out - so a `--target judgejev --temp 0.7` run should be compared against a `--temp 0.7` baseline, not the default `--temp 0` one, or the delta conflates "sampling changed the model's behavior" with "fan-out+judging helped."

## Why `local-chat-completions` + `think_end_token` for gsm8k

- `local-chat-completions` is lm-eval-harness's model type for any OpenAI-compatible chat completions endpoint - both a raw provider box and JudgeJev's proxy expose this shape, so the same harness setup works for both "before" and "after" runs.
- `Qwen/Qwen3-1.7B` is a reasoning model: it emits a `<think>...</think>` block before answering. `think_end_token=</think>` tells the harness to strip everything up through that tag before grading the answer - the harness's own documented mechanism for this, not a JudgeJev-specific workaround. `max_gen_toks` is set generously (3000) because that thinking can run long before the model reaches its actual answer.

## Why raw completions for `humaneval`, not `local-chat-completions`

`humaneval`'s "instruct" variant (and `mbpp_instruct`) assume the backend can **pre-fill the assistant's turn**, so the model's generation continues an already-open code fence and its own first ` ``` ` marks the *close*. Plain OpenAI-compatible chat completions has no such feature, so the model writes its own fresh opening fence instead - and every shipped extraction filter for these instruct tasks then grabs the wrong span. Confirmed directly: every instruct variant scored ~0 regardless of code quality, across multiple independent attempts with different fixes (removing stop sequences, raising token budgets, switching tasks).

The fix is `--tasks humaneval` (the *base*, non-chat task) against the model's raw `/v1/completions` endpoint (`local-completions`, no `--apply_chat_template`) - true text continuation, no chat template, no thinking. Two things needed overriding from the task's defaults to make this work against vLLM specifically:

- `until=["\nclass","\ndef","\n#","\nif"]` - the base task's default stop list has 5 entries, but vLLM's OpenAI-compatible server rejects more than 4 stop sequences per request (`local-chat-completions` silently truncates to 4 for you; `local-completions` doesn't, so it needs this override or you'll get a 400).
- `HF_ALLOW_CODE_EVAL=1` env var - HumanEval scores by executing the model's generated code; this is that benchmark's own documented consent gate (separate from lm-eval-harness's own `--confirm_run_unsafe_code` flag, which is also required).

JudgeJev exposes the same raw `/v1/completions` shape (see `src/api/proxy.ts`), so `--target judgejev` above points `local-completions` at JudgeJev's proxy instead of the model directly, with `stop`/`max_tokens` forwarded through the fan-out unchanged - no chat-template mismatch to work around on that side either.

## Running `mmlu` / `wmt16` / `mbpp` / `math500` - baseline or through JudgeJev

One generic script instead of four near-identical ones - `humaneval` keeps its own since it existed first and the shape is identical anyway:

```bash
./run-completions-task.sh --task <mmlu|wmt16|mbpp|math500> [--target baseline|judgejev] [--temp N] [--output name] [--limit N]
```

Same flags, same temperature-folder convention, same `local-completions`/raw-completions approach as `run-humaneval.sh` - see that section above for what each flag does. All four were verified directly against the real model before being wired in: each resolves as an installed lm-eval-harness task, and - unlike `humaneval` - none of their stop-sequence lists exceed vLLM's 4-per-request limit, so no manual `until` override is needed; only `temperature` gets passed via `--gen_kwargs`, which lm-eval-harness merges onto the task's own defaults rather than replacing them.

- `mmlu` → `mmlu_generative`: the generation-based variant, not the default `multiple_choice`/loglikelihood one - JudgeJev's `/v1/completions` schema doesn't forward `echo`/`logprobs` (only `prompt`/`temperature`/`max_tokens`/`stop`), so the loglikelihood variant would silently lose those fields going through the proxy. `mmlu_generative` scores by generating "A"/"B"/"C"/"D" directly instead, avoiding the issue entirely. `--limit` applies **per subject** (57 subjects) - the default of `5` here means ~285 total samples, not 5; the full unlimited set is ~14,000 questions.
- `wmt16` → `wmt16-en-de`: BLEU/TER/chrF-scored English→German translation.
- `mbpp` → `mbpp` (base task, not `mbpp_instruct` - same prefill problem as `humaneval_instruct`, see above). Executes generated code to score, so it needs the same consent as `humaneval` (`--confirm_run_unsafe_code` + `HF_ALLOW_CODE_EVAL=1`, both wired in automatically).
- `math500` → `hendrycks_math500`: the fixed 500-problem MATH-500 subset - harder than `gsm8k`, same "Problem: ...\nAnswer:" generate_until shape.

## Results

`results/<name>/` - one directory per run, containing the aggregated scores and (with `--log_samples`) every individual sample's prompt/response/grade, so a reviewer can spot-check specific failures, not just trust the aggregate number.
