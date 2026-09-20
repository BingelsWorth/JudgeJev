# Results: same-model fan-out (HumanEval)

**Fan out to N *copies of the same model*, no model diversity, and let Jev judge which one to keep.** Both fan-out sizes tested here target the exact same task/model/temperatures, so the columns are directly comparable.

## Setup

- Task: `humaneval`, full 164-problem set, seed `1234`, raw `/v1/completions` (no chat template) - see [`../accuracy.md`](../accuracy.md) and [`README.md`](README.md) for why.
- Model: `Qwen/Qwen3-1.7B`, served locally via vLLM.
- Fan-out: `MODEL_CONFIGS` fanout count set to either `5` or `3` - every "through JudgeJev" run fans the same prompt out to that many calls of the *same* model, then has Jev pick a winner via the `coding` rubric.
- Baseline: a single direct call to the model, no fan-out, no Jev - the thing fan-out+judging needs to beat. Baseline doesn't depend on fan-out count, so it's shared across both columns.
- 3 runs per condition (`./run-humaneval.sh` / `./run-humaneval.sh --target judgejev`, varying `--temp`).

## Results

| Temperature | Baseline pass@1 (single shot, n=3) | 5x fan-out + judge (n=3) | 5x Δ | 3x fan-out + judge (n=3) | 3x Δ |
| --- | --- | --- | --- | --- | --- |
| 0 (greedy) | **0.423** (0.421, 0.415, 0.433) | not meaningful - see "Why temperature 0 doesn't work" | — | not meaningful (same reason) | — |
| 0.3 | **0.376** (0.372, 0.378, 0.378) | **0.486** (0.488, 0.463, 0.506) | **+11.0 pts** | **0.476** (0.470, 0.488, 0.470) | **+10.0 pts** |
| 0.7 | **0.344** (0.342, 0.342, 0.348) | **0.514** (0.549, 0.482, 0.512) | **+17.1 pts** | **0.512** (0.500, 0.512, 0.524) | **+16.9 pts** |
| 1.0 | **0.323** (0.323, 0.317, 0.329) | **0.526** (0.549, 0.531, 0.500) | **+20.3 pts** | **0.423** (0.409, 0.439, 0.421) | **+10.0 pts** |

Raw results: `results/baseline-humaneval*/`, `results/through-judgejev-humaneval*/` (folder suffix is `-temp_<N>` for any temperature other than the default `0`). The 5x numbers above were captured before the `through-judgejev-humaneval*` result files were overwritten by the 3x re-run - the table is the surviving record of that data, the raw JSON for it is gone.

## Insights

- **At every temperature tested, fan-out+judging beats the single-shot baseline by a wide, consistent margin regardless of fan-out size** - the smallest gap in the whole table is still +10 points. Each individual run's own stderr is ~0.037-0.039; gaps this size, repeated across 3 independent runs per condition, aren't run-to-run noise.
- **The baseline gets *worse* as temperature rises** (0.423 → 0.376 → 0.344 → 0.323): sampling hurts a single shot, monotonically, confirmed all the way to temp 1.0. That's the exact cost fan-out+judging is supposed to buy back.
- **Fan-out size mostly doesn't matter at moderate temperatures, but matters a lot at high temperature.** At temp 0.3 and 0.7, 5x and 3x land within ~1-2 points of each other (486 vs 476, 514 vs 512) - going from 3 to 5 candidates buys almost nothing there. At temp 1.0, though, 5x clearly pulls ahead of 3x (526 vs 423, roughly double the improvement over baseline: +20.3 pts vs +10.0 pts) - at higher temperature individual candidates get noisier and less reliable, so having more of them to choose from matters more for Jev to reliably find a good one.
- **Temperature 0 has no meaningful through-JudgeJev number at either fan-out size** - at greedy decoding, every fanned-out call to the same model returns byte-identical text (confirmed directly, see `README.md`), so JudgeJev's own duplicate-pruning collapses them all down to 1 candidate before Jev ever gets a real choice. Fan-out only works here *because* of sampling diversity, not despite it - this is the core mechanism, not a quirk of this one benchmark (see `../accuracy.md`'s "Why this benchmark exists").
- **Practical read**: if you're running at a moderate temperature (0.3-0.7), 3x fan-out captures nearly all the benefit 5x does at lower cost. If you're running hotter (temp ~1.0) to get more diversity per candidate, the extra fan-out width starts to matter more - worth confirming with a temp-1.0 re-test at fan-out sizes between 3 and 5 before treating that as a firm cutoff, since this is one run's worth of data per cell.
