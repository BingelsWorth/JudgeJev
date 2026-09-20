#!/usr/bin/env bash
# Orchestrates the full benchmark suite - every task this repo has an
# automated lm-eval-harness score for, baseline and through-JudgeJev, across
# the temperature sweep that matters for a same-model fan-out comparison.
# Everything runs strictly sequentially - one lm_eval invocation at a time,
# in order - never in the background and never in parallel, to keep results
# reproducible and avoid hammering the shared vLLM box with overlapping
# suites.
#
# Tasks, mapped to the rubrics in src/rubrics.ts:
#   humaneval -> coding       (raw completions - see run-humaneval.sh)
#   mbpp      -> coding       (2nd opinion, same shape as humaneval)
#   gsm8k     -> math         (chat completions - see run-gsm8k.sh)
#   math500   -> math         (2nd opinion, harder than gsm8k)
#   mmlu      -> general      (broad knowledge, multiple-choice-as-generation)
#   wmt16     -> translation  (BLEU/TER/chrF-scored en->de)
#   tool-call rubric is intentionally NOT covered here - there's no
#   lm-eval-harness task for it; the standard benchmark (BFCL) is a separate
#   tool that would need its own integration, not a run-*.sh script.
#
# Baseline runs ONCE per temperature per task - it doesn't depend on
# MODEL_CONFIGS' fan-out count, so there's no reason to repeat it just
# because you're about to compare a different fan-out size. Through-JudgeJev
# runs repeat (default 3x) per temperature per task, same as the manual runs
# this was built from, since fan-out+judge results have more run-to-run
# variance than a single deterministic-ish baseline call does.
#
# Fan-out size (e.g. 3x vs 5x) is NOT automated here - see
# run-fanout-sweep.sh, which wraps this script and handles that.
#
# gsm8k doesn't get a temperature sweep - unlike the other tasks' short
# completions, its long reasoning chains already pick up enough
# floating-point drift in batched inference to diverge at the default
# temperature, so a sweep isn't needed there (see README.md).
#
# Usage:
#   ./run-suite.sh                          # everything
#   ./run-suite.sh --only humaneval
#   ./run-suite.sh --only humaneval,mbpp     # comma-separated list
#   ./run-suite.sh --judgejev-runs 5         # override the default 3 repeats
#   ./run-suite.sh --skip-baseline           # only refresh judgejev runs
#   ./run-suite.sh --limit 20                # quick smoke test of the whole suite
#   ./run-suite.sh --fanout-label 3          # see --fanout-label below
#
# --fanout-label: only affects judgejev legs (baseline doesn't depend on
# fan-out size) - appends `-fanout_<label>` to every judgejev results
# folder name, so results from different MODEL_CONFIGS fan-out counts don't
# silently overwrite each other under the same folder. Set automatically by
# run-fanout-sweep.sh; pass it by hand only if you're comparing fan-out
# sizes manually instead of through that script.
#
# Requires JudgeJev running first for the judgejev legs (`npm run dev` from
# the repo root) - each underlying script warns (but doesn't block) if it
# can't reach it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ONLY=""
JUDGEJEV_RUNS=3
SKIP_BASELINE=0
LIMIT=""
FANOUT_LABEL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --judgejev-runs) JUDGEJEV_RUNS="$2"; shift 2 ;;
    --skip-baseline) SKIP_BASELINE=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --fanout-label) FANOUT_LABEL="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

COMPLETIONS_TEMPS=(0 0.3 0.7 1.0)

LIMIT_ARGS=()
LIMIT_ARGS_GSM8K=()
if [ -n "${LIMIT}" ]; then
  LIMIT_ARGS=(--limit "${LIMIT}")
  LIMIT_ARGS_GSM8K=("${LIMIT}")
fi

step() {
  echo
  echo ">>> $*"
  "$@"
}

# Every raw-completions task (humaneval, mmlu, wmt16, mbpp, math500) follows
# the exact same shape: sweep temperature, baseline once, judgejev N times.
# $1 is the script to invoke; any remaining args are that script's own
# fixed args (e.g. `--task mmlu`), passed before --temp/--target.
sweep_completions_task() {
  local script="$1"; shift
  local fixed_args=("$@")
  local fanout_args=()
  if [ -n "${FANOUT_LABEL}" ]; then
    fanout_args=(--fanout-label "${FANOUT_LABEL}")
  fi
  for temp in "${COMPLETIONS_TEMPS[@]}"; do
    if [ "${SKIP_BASELINE}" -eq 0 ]; then
      step "${script}" "${fixed_args[@]+"${fixed_args[@]}"}" --temp "${temp}" "${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"}"
    fi
    for i in $(seq 1 "${JUDGEJEV_RUNS}"); do
      step "${script}" "${fixed_args[@]+"${fixed_args[@]}"}" --target judgejev --temp "${temp}" "${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"}" "${fanout_args[@]+"${fanout_args[@]}"}"
    done
  done
}

run_humaneval() { sweep_completions_task ./run-humaneval.sh; }
run_mbpp()      { sweep_completions_task ./run-completions-task.sh --task mbpp; }
run_mmlu()      { sweep_completions_task ./run-completions-task.sh --task mmlu; }
run_wmt16()     { sweep_completions_task ./run-completions-task.sh --task wmt16; }
run_math500()   { sweep_completions_task ./run-completions-task.sh --task math500; }

run_gsm8k() {
  local gsm8k_limit="${LIMIT_ARGS_GSM8K[0]:-100}"
  if [ "${SKIP_BASELINE}" -eq 0 ]; then
    step ./run-gsm8k.sh baseline gsm8k "${gsm8k_limit}"
  fi
  for i in $(seq 1 "${JUDGEJEV_RUNS}"); do
    step ./run-gsm8k.sh judgejev gsm8k "${gsm8k_limit}" "" "${FANOUT_LABEL}"
  done
}

DEFAULT_TASKS="humaneval,mbpp,gsm8k,math500,mmlu,wmt16"
IFS=',' read -ra REQUESTED_TASKS <<< "${ONLY:-${DEFAULT_TASKS}}"

for task in "${REQUESTED_TASKS[@]}"; do
  case "${task}" in
    humaneval) run_humaneval ;;
    mbpp)      run_mbpp ;;
    gsm8k)     run_gsm8k ;;
    math500)   run_math500 ;;
    mmlu)      run_mmlu ;;
    wmt16)     run_wmt16 ;;
    *)
      echo "Unknown --only value '${task}' - expected one of: humaneval, mbpp, gsm8k, math500, mmlu, wmt16" >&2
      exit 1
      ;;
  esac
done

echo
echo ">>> Suite complete."
