# Accuracy benchmark: does fan-out + Jev judging actually help?

**Status: tooling covers `math` (gsm8k, math500), `coding` (humaneval, mbpp), `general` (mmlu), and `translation` (wmt16) - every rubric except `tool-call`, which has no lm-eval-harness task (see "Grading" below). `run-suite.sh` runs all of it, baseline and through-JudgeJev, sequentially.** Step one was establishing what the model we're fanning out to scores *on its own*, with no JudgeJev involved - only with that baseline in hand does "does JudgeJev improve on it" become a meaningful question, rather than a number with nothing to compare against.

## Tooling

[**lm-evaluation-harness**](https://github.com/EleutherAI/lm-evaluation-harness) (EleutherAI) - the most widely used LLM eval framework, chosen specifically because scores it produces are comparable to published results for the same model/task elsewhere, not just internally consistent. Its `local-chat-completions` model type targets any OpenAI-compatible `/v1/chat/completions` endpoint, and its `local-completions` type targets a raw `/v1/completions` endpoint; JudgeJev's proxy exposes both (see `src/api/proxy.ts`'s `/v1/completions` route), so the *same* harness invocation works for the "before" (single model) and "after" (through JudgeJev) runs, just pointed at a different `base_url`.

Setup lives in [`lm-eval-harness/`](lm-eval-harness/) (a `uv`-managed Python venv, kept out of `npm`'s dependency tree since this is a separate ecosystem). See that directory's `README.md` to reproduce.

## Step 1: single-model baselines

What the model we're actually fanning out to (`Qwen/Qwen3-1.7B`, served locally, unauthenticated vLLM) scores by itself, with no fan-out and no judging.

### `math` — gsm8k

Grade-school math word problems, 100-sample subset, seed `1234`. Qwen3 is a reasoning model that emits a `<think>...</think>` block before answering; run through the chat-completions API (`--apply_chat_template`, `local-chat-completions`), with the harness's `think_end_token` option stripping that block before grading, same as JudgeJev's own judge-call parsing does.

| Metric | Score |
| --- | --- |
| `exact_match` (flexible-extract) | 0.77 ± 0.042 |
| `exact_match` (strict-match) | 0.43 ± 0.050 |

`flexible-extract` accepts the answer wherever it appears in the response; `strict-match` requires the exact `#### <answer>` format the few-shot prompt asks for - the gap between the two (77% vs 43%) is largely the model not reliably following that output format, not the model being wrong more often.

Raw results: `benchmarks/lm-eval-harness/results/baseline-single-model/`.

### `coding` — humaneval

Full 164-problem set, seed `1234`, run against the model's **raw `/v1/completions` API** (`local-completions`, no chat template) rather than chat completions.

| Metric | Score |
| --- | --- |
| `pass@1` | 0.421 ± 0.039 |

Captured at `temperature=0` (greedy decoding, `run-humaneval.sh`'s default). See "Why this benchmark exists" below for why that default matters for the through-JudgeJev comparison specifically - the fan-out side needs `--temp` set to something non-zero to have anything real to judge between, and the baseline needs the same `--temp` for a fair comparison.

**Why raw completions, not chat**: every code-gen task lm-eval-harness ships in an "instruct"/chat-shaped variant (`humaneval_instruct`, `mbpp_instruct`) assumes the backend can pre-fill the assistant's turn, so the model's generation continues an already-open code fence and its own first ` ``` ` is the *closing* one. Plain OpenAI-compatible chat completions - what this model server and JudgeJev both expose - has no such feature, so the model always writes its own fresh opening fence instead, and every one of those tasks' extraction filters then grabs the wrong span (confirmed directly: every instruct variant scored ~0 regardless of actual code quality, on multiple independent attempts). Raw completion mode sidesteps this entirely: the prompt already ends mid-function, so the model just continues writing real code - no chat template, no thinking, and ~10x faster to boot. See `benchmarks/lm-eval-harness/run-humaneval.sh` for the exact command.

This is the number JudgeJev's fan-out+judging pipeline needs to beat (or lose to honestly). Unlike the earlier version of this doc, this comparison is no longer architecturally blocked: JudgeJev's `/v1/completions` route fans a raw prompt out to every configured route's own raw `/v1/completions` API (no chat wrapping, `stop`/`max_tokens` forwarded as given) and lets Jev judge the results as plain text, same as any other endpoint - see `benchmarks/lm-eval-harness/run-humaneval.sh --target judgejev`.

Raw results: `benchmarks/lm-eval-harness/results/baseline-humaneval/`.

## Why this benchmark exists

JudgeJev's core bet is: firing the same request at multiple (often small, cheap, occasionally-wrong) models and having Jev pick the best response produces a better outcome than trusting any single model call - including a single call to a larger model. That's a testable claim, not an assumption we should get to keep for free. This benchmark is how we check it, and how anyone else can check it against us.

**This is also why fan-out can improve anything even when every candidate comes from the exact same model.** At a non-zero sampling temperature, asking the same model the same question twice gives two slightly different answers - fire it N times, have Jev grade the variants, keep the best one. At `temperature=0` (greedy decoding) there's no variance to grade in the first place: a short answer comes back byte-identical on every attempt (confirmed directly against the humaneval model - see `lm-eval-harness/run-humaneval.sh`'s comments), and JudgeJev's own duplicate-pruning step collapses those "candidates" down to one before Jev ever gets a real choice to make. This isn't specific to same-model fan-out - it's the whole mechanism by which repeated sampling + judging can beat a single call at all.

## What we're testing

1. **Does the fan-out + judge pipeline beat a single-model baseline?** For the same prompt, compare JudgeJev's chosen winner against a single call to one of the fanned-out models, and separately against a single call to a stronger reference model.
2. **Does rubric selection pick the domain a request is actually from?** Tracked as its own metric, not folded into (1) - a wrong rubric pick can still land on a good winner by accident, so this needs to be measured directly.
3. **Does more fan-out (higher `fanout` count) actually improve the win rate, or does it plateau?** Motivates whether the default fan-out counts in `env.template` are reasonable.

## Proposed methodology

- **Prompt set**: a fixed, published set of prompts spanning the default rubrics (`general`, `coding`, `math`, `tool-call`, `translation`), enough per category for the win-rate numbers to be more than noise. The prompt set itself gets published alongside results so a reviewer can rerun the exact same inputs.
- **Candidates**: fan out each prompt to N configured routes/models (small, local models - the case JudgeJev is actually built for) via `modelConfigs`/`MODEL_CONFIGS`, same as a real request.
- **Judging**: the real Jev path (`JEV_API_KEY` set, no bypass), so the benchmark exercises the exact production code path, not a special test harness.
- **Baselines to compare against**:
  - Single call to one of the fanned-out models (picked deterministically, e.g. first by priority) - isolates the value of fan-out+judging over "just ask one model."
  - Single call to a stronger/larger reference model - checks whether fan-out of small models can compete with brute-forcing a bigger one.
- **Grading**: lm-evaluation-harness scores every rubric except `tool-call` objectively now - no human or model-based grading needed, and results are comparable to published numbers for the same model/task: `math` via `gsm8k` and `math500`, `coding` via `humaneval` and `mbpp`, `general` via `mmlu` (broad knowledge, not open-ended quality - a proxy, not a perfect match for the rubric), `translation` via `wmt16` (BLEU/TER/chrF against a reference translation). `tool-call` has no built-in lm-eval-harness task at all - the standard benchmark for that ([BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)) is a separate tool, not evaluated here.
- **Metrics**:
  - Win / tie / loss rate of JudgeJev's winner vs. each baseline, per rubric category and overall.
  - Rubric-selection accuracy: chosen rubric id vs. the prompt's known category.
  - Latency: end-to-end request time (this connects to the planned JudgeJev-level concurrency benchmark in [`README.md`](README.md)) - a pipeline that wins on quality but costs 10x the latency needs that tradeoff stated plainly, not hidden.

## Reproducing

The whole suite, sequentially, baseline once per temperature + through-JudgeJev 3x per temperature per task:

```bash
cd benchmarks/lm-eval-harness
./run-suite.sh   # everything: humaneval, mbpp, gsm8k, math500, mmlu, wmt16

# in another terminal, from the repo root, before run-suite.sh reaches its judgejev legs:
npm run dev
```

To also sweep fan-out size (e.g. 3x vs 5x), use `run-fanout-sweep.sh` instead - it wraps `run-suite.sh` and handles the `.env`/server restart between sizes automatically.

See [`lm-eval-harness/README.md`](lm-eval-harness/README.md) for individual task scripts, flags, and defaults. Before trusting a comparison between two runs, confirm both actually received the same question - see that README's note on the prompt-extraction regression coverage.

## Open questions before running this

- `mmlu` is a proxy for the `general` rubric (broad knowledge, multiple-choice), not a direct measure of open-ended response quality - is that close enough, or does `general` still need a human/model-graded comparison alongside it?
- How large does the prompt set need to be per category before a win-rate difference is meaningful rather than noise?
- Should the "stronger reference model" baseline be pinned to a specific model+version so results stay comparable as models change upstream?
- `tool-call` remains uncovered - worth its own integration with BFCL, or is it out of scope for now?
