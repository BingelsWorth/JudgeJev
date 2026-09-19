# Accuracy benchmark: does fan-out + Jev judging actually help?

**Status: methodology defined, results not yet collected.** This document is the plan, published ahead of the run so the methodology itself can be reviewed and challenged before results exist to defend.

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
- **Grading**: candidate responses (JudgeJev's winner + each baseline) graded blind (grader doesn't know which is which) against the same rubric used for that prompt. Grading method TBD - options are human grading, a separate strong-model-as-grader pass, or both compared against each other for agreement.
- **Metrics**:
  - Win / tie / loss rate of JudgeJev's winner vs. each baseline, per rubric category and overall.
  - Rubric-selection accuracy: chosen rubric id vs. the prompt's known category.
  - Latency: end-to-end request time (this connects to the planned JudgeJev-level concurrency benchmark in [`README.md`](README.md)) - a pipeline that wins on quality but costs 10x the latency needs that tradeoff stated plainly, not hidden.

## Reproducing this once results exist

The goal is that this section becomes: the prompt set as a checked-in file, a runner script, and the exact `MODEL_CONFIGS`/`JEV_MODEL` used - so `npx tsx docs/benchmarks/run-accuracy-benchmark.mjs` (or equivalent) against your own routes reproduces comparable numbers, not just ours.

## Open questions before running this

- Who/what grades candidate quality, and how do we report grader disagreement/uncertainty rather than a single misleadingly-precise number?
- How large does the prompt set need to be per category before a win-rate difference is meaningful rather than noise?
- Should the "stronger reference model" baseline be pinned to a specific model+version so results stay comparable as models change upstream?
