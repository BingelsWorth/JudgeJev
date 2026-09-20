# Accuracy benchmark: does fan-out + Jev judging actually help?

**Status: single-model baselines collected for `math` (gsm8k) and `coding` (humaneval). Tooling for the "through JudgeJev" run is ready for gsm8k; the coding side needs one more piece first (see below). No "through JudgeJev" run has happened yet.** Step one was establishing what the model we're fanning out to scores *on its own*, with no JudgeJev involved - only with that baseline in hand does "does JudgeJev improve on it" become a meaningful question, rather than a number with nothing to compare against.

## Tooling

[**lm-evaluation-harness**](https://github.com/EleutherAI/lm-evaluation-harness) (EleutherAI) - the most widely used LLM eval framework, chosen specifically because scores it produces are comparable to published results for the same model/task elsewhere, not just internally consistent. Its `local-chat-completions` model type targets any OpenAI-compatible `/v1/chat/completions` endpoint, which both a raw provider box and JudgeJev's own proxy expose - so the *same* harness invocation works for the "before" (single model) and "after" (through JudgeJev) runs, just pointed at a different `base_url`.

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

**Why raw completions, not chat**: every code-gen task lm-eval-harness ships in an "instruct"/chat-shaped variant (`humaneval_instruct`, `mbpp_instruct`) assumes the backend can pre-fill the assistant's turn, so the model's generation continues an already-open code fence and its own first ` ``` ` is the *closing* one. Plain OpenAI-compatible chat completions - what this model server and JudgeJev both expose - has no such feature, so the model always writes its own fresh opening fence instead, and every one of those tasks' extraction filters then grabs the wrong span (confirmed directly: every instruct variant scored ~0 regardless of actual code quality, on multiple independent attempts). Raw completion mode sidesteps this entirely: the prompt already ends mid-function, so the model just continues writing real code - no chat template, no thinking, and ~10x faster to boot. See `benchmarks/lm-eval-harness/run-baseline-humaneval.sh` for the exact command.

This is the number JudgeJev's fan-out+judging pipeline needs to beat (or lose to honestly) - but see the open methodology question below before assuming the comparison is that simple.

Raw results: `benchmarks/lm-eval-harness/results/baseline-humaneval/`.

## Why this benchmark exists

JudgeJev's core bet is: firing the same request at multiple (often small, cheap, occasionally-wrong) models and having Jev pick the best response produces a better outcome than trusting any single model call - including a single call to a larger model. That's a testable claim, not an assumption we should get to keep for free. This benchmark is how we check it, and how anyone else can check it against us.

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
- **Grading**: for domains with checkable answers (`math` via `gsm8k`, `coding` via `humaneval`), lm-evaluation-harness scores objectively - no human or model-based grading needed, and results are comparable to published numbers for the same model/task. `general` and `translation` are open-ended and lm-eval-harness's task suite doesn't score them meaningfully here; those still need blind human or strong-model-as-grader comparison (method TBD - not blocking the objective-task baseline work). `tool-call` has no built-in lm-eval-harness task at all - the standard benchmark for that ([BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)) is a separate tool, not evaluated here yet.
- **Metrics**:
  - Win / tie / loss rate of JudgeJev's winner vs. each baseline, per rubric category and overall.
  - Rubric-selection accuracy: chosen rubric id vs. the prompt's known category.
  - Latency: end-to-end request time (this connects to the planned JudgeJev-level concurrency benchmark in [`README.md`](README.md)) - a pipeline that wins on quality but costs 10x the latency needs that tradeoff stated plainly, not hidden.

## Reproducing

```bash
# Step 1: single-model baselines (no JudgeJev)
cd benchmarks/lm-eval-harness
./run-gsm8k.sh                 # gsm8k, chat completions, target=baseline (default)
./run-baseline-humaneval.sh    # humaneval, raw completions

# Step 2: through JudgeJev (gsm8k only, for now - see open question below) -
# in another terminal, from the repo root:
npm run dev         # starts JudgeJev at http://localhost:8787
# then, back in benchmarks/lm-eval-harness:
./run-gsm8k.sh judgejev
```

See [`lm-eval-harness/README.md`](lm-eval-harness/README.md) for arguments and defaults. Before trusting a comparison between two runs, confirm both actually received the same question - see that README's note on the prompt-extraction regression coverage.

## Open questions before running this

- **How does the coding comparison work at all, given JudgeJev has no raw-completions endpoint?** The clean `humaneval` baseline above only works because it bypasses chat entirely (`local-completions`, no template). JudgeJev only exposes chat-shaped endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) - there's no equivalent raw-completions path through it. So the "through JudgeJev" coding run is stuck with chat mode, which reintroduces the exact prefill/extraction mismatch documented above. Fixing this means writing a custom lm-eval-harness task/filter for `humaneval` that extracts code correctly from a non-prefilled chat response (a real regex scan for *any* fenced block, not "first backtick = closing fence") - not yet done.
- Who/what grades candidate quality for the open-ended rubrics (`general`, `translation`), and how do we report grader disagreement/uncertainty rather than a single misleadingly-precise number?
- How large does the prompt set need to be per category before a win-rate difference is meaningful rather than noise?
- Should the "stronger reference model" baseline be pinned to a specific model+version so results stay comparable as models change upstream?
