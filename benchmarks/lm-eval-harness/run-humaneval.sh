#!/usr/bin/env bash
# Runs HumanEval against a raw /v1/completions endpoint (no chat template) -
# either the model directly (baseline) or through JudgeJev's fan-out+judge
# proxy, which also exposes a real /v1/completions passthrough.
#
# This deliberately does NOT use --apply_chat_template / local-chat-completions.
# HumanEval's task design (and every "_instruct" variant shipped with
# lm-eval-harness) assumes the backend can pre-fill the assistant's response so
# generation continues an already-open code fence. Plain OpenAI-compatible chat
# completions has no such feature, so the model always writes its own opening
# fence and every shipped extraction filter grabs the wrong span (confirmed:
# every "_instruct" variant scored ~0 regardless of code quality). Raw
# completion mode sidesteps this entirely - the prompt already ends
# mid-function, so the model just continues writing real code, no chat
# template or thinking involved.
#
# Usage - only pass the flags you're actually changing:
#   ./run-humaneval.sh                              # baseline, temp 0 (unchanged default)
#   ./run-humaneval.sh --temp 0.7                    # control: same temp as judgejev, single shot
#   ./run-humaneval.sh --target judgejev --temp 0.7  # treatment: same temp, 5x fan-out + judge
#   ./run-humaneval.sh --limit 20
#   ./run-humaneval.sh --output my-custom-name
#
# --target: "baseline" (default) - hits ${MODEL_SERVER_URL}/v1/completions
#           directly (MODEL_SERVER_URL from the repo-root .env, falls back
#           to http://192.168.2.106:8000 if unset). No fan-out, no Jev.
#           "judgejev" - hits JudgeJev's own /v1/completions instead
#           (http://localhost:8787, model "fast" - requires `npm run dev`
#           running from the repo root first).
#
# --temp: defaults to 0 - matching the original baseline this repo committed
# (`results/baseline-humaneval`, pass@1 0.421 ± 0.039). Omit --output and a
# non-zero --temp gets its own results folder automatically (see "Results
# land in" below), so you don't need to think about naming to avoid
# overwriting the default baseline.
#
# Why temperature matters for `--target judgejev` specifically: fan-out
# only has something to judge between if the candidates actually differ,
# and they won't at temperature 0 for a short completion. Confirmed
# directly - 5x curl with the same prompt at temperature 0 returned
# byte-identical text every time (JudgeJev's own duplicate-pruning step
# would then collapse those 5 "candidates" down to 1 before Jev ever gets
# to pick between anything), while 5x with no temperature field at all
# (letting the upstream model's own sampling default apply) returned 5
# genuinely different approaches. lm-eval-harness's `local-completions`
# client can't send "no temperature" - its request builder unconditionally
# does `temperature = gen_kwargs.pop("temperature", 0)` - so pass --temp
# explicitly to see fan-out do anything at all. gsm8k doesn't need this
# because its multi-thousand-token reasoning chains have enough
# floating-point drift in batched inference to diverge even at temperature
# 0; humaneval's short completions don't.
#
# But raising temperature also makes a *single* shot noisier on its own,
# independent of fan-out - so comparing a temp>0 judgejev run only against
# the temp-0 baseline conflates "sampling changed the model's behavior"
# with "fan-out+judging helped." Run the baseline control at the same
# --temp too before trusting a judgejev delta.
#
# --limit: optional - full HumanEval is 164 problems and fast enough (raw
# completion, no reasoning overhead) to just run in full.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT_ENV="../../.env"
[ -f "${ROOT_ENV}" ] && { set -a; source "${ROOT_ENV}"; set +a; }

TARGET="baseline"
TEMPERATURE="0"
OUTPUT_NAME=""
LIMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --temp|--temperature) TEMPERATURE="$2"; shift 2 ;;
    --output|--output-name) OUTPUT_NAME="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "${TARGET}" in
  baseline)
    BASE_URL="${MODEL_SERVER_URL:-http://192.168.2.106:8000}/v1/completions"
    MODEL="Qwen/Qwen3-1.7B"
    DEFAULT_OUTPUT_NAME="baseline-humaneval"
    ;;
  judgejev)
    BASE_URL="http://localhost:8787/v1/completions"
    MODEL="fast"
    DEFAULT_OUTPUT_NAME="through-judgejev-humaneval"
    HEALTH_URL="http://localhost:8787/health"
    if ! curl -sf -m 5 "${HEALTH_URL}" >/dev/null 2>&1; then
      echo "Warning: could not reach JudgeJev at ${HEALTH_URL} - is it running (npm run dev)? Continuing anyway." >&2
    fi
    ;;
  *)
    echo "Unknown target '${TARGET}' - expected 'baseline' or 'judgejev'" >&2
    exit 1
    ;;
esac

# Results land in `results/${DEFAULT_OUTPUT_NAME}` unchanged at the default
# temperature (0), or its own `results/${DEFAULT_OUTPUT_NAME}-temp_<N>`
# folder for any other temperature - same run, just kept apart so results
# at different temperatures never land in the same folder unless you
# explicitly ask for that via --output.
if [ -n "${OUTPUT_NAME}" ]; then
  : # explicit --output wins as-is
elif [ "${TEMPERATURE}" = "0" ]; then
  OUTPUT_NAME="${DEFAULT_OUTPUT_NAME}"
else
  OUTPUT_NAME="${DEFAULT_OUTPUT_NAME}-temp_${TEMPERATURE}"
fi

if [ ! -x .venv/bin/lm_eval ]; then
  echo "Setting up .venv (uv required: https://docs.astral.sh/uv/)..."
  uv venv --python 3.11 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi

LIMIT_ARGS=()
if [ -n "${LIMIT}" ]; then
  LIMIT_ARGS=(--limit "${LIMIT}")
fi

# HF_ALLOW_CODE_EVAL=1: HumanEval scores by executing the model's generated
# code - this is that benchmark's own documented consent gate, not specific
# to this setup. See README.md.
HF_ALLOW_CODE_EVAL=1 .venv/bin/lm_eval run \
  --model local-completions \
  --model_args "base_url=${BASE_URL},model=${MODEL},num_concurrent=5,max_retries=3,tokenized_requests=False,tokenizer_backend=None,timeout=180" \
  --tasks humaneval \
  --confirm_run_unsafe_code \
  --gen_kwargs "max_gen_toks=1024,temperature=${TEMPERATURE},until=[\"\\nclass\",\"\\ndef\",\"\\n#\",\"\\nif\"]" \
  --seed 1234 \
  --output_path "results/${OUTPUT_NAME}" \
  --log_samples \
  "${LIMIT_ARGS[@]+"${LIMIT_ARGS[@]}"}"
