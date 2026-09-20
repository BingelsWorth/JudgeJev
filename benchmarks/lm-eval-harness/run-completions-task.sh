#!/usr/bin/env bash
# Generic runner for every raw-completions task in the suite besides
# humaneval (which keeps its own script - see run-humaneval.sh - since it
# was built and documented first and its flag shape is identical anyway).
# Same underlying approach as run-humaneval.sh: raw /v1/completions, no
# chat template, either the model directly (baseline) or through JudgeJev's
# fan-out+judge proxy (judgejev).
#
# --task selects which of these to run:
#   mmlu     -> mmlu_generative   (general knowledge, exact_match)
#   wmt16    -> wmt16-en-de       (translation, BLEU/TER/chrF)
#   mbpp     -> mbpp              (coding, pass@1 - executes generated code,
#                                   needs consent, same as humaneval)
#   math500  -> hendrycks_math500 (harder math than gsm8k, exact_match)
#
# All four were verified directly against the real model before being wired
# in here: each resolves as an installed lm-eval-harness task, runs cleanly
# through `local-completions` with no chat-template/prefill issues (unlike
# humaneval's "_instruct" variants), and none of their stop-sequence lists
# exceed vLLM's 4-per-request limit (so, unlike humaneval, no manual `until`
# override is needed - only `temperature` gets passed via --gen_kwargs,
# which lm-eval-harness merges onto the task's own defaults rather than
# replacing them).
#
# Usage - only pass what you're changing:
#   ./run-completions-task.sh --task mmlu                              # baseline, temp 0
#   ./run-completions-task.sh --task mmlu --temp 0.7
#   ./run-completions-task.sh --task mmlu --target judgejev --temp 0.7
#   ./run-completions-task.sh --task wmt16 --limit 50
#
# --target: "baseline" (default) - hits ${MODEL_SERVER_URL}/v1/completions
#           directly. No fan-out, no Jev.
#           "judgejev" - hits JudgeJev's own /v1/completions instead
#           (http://localhost:8787/v1/completions, model "fast" - requires
#           `npm run dev` running from the repo root first).
#
# --temp: defaults to 0. See run-humaneval.sh's comments for why this
# matters a lot for --target judgejev specifically - fan-out only has
# something to judge between if the candidates actually differ, and short
# completions at temperature 0 come back byte-identical across all fanned-out
# copies of the same model.
#
# --output: defaults to `baseline-<task>` / `through-judgejev-<task>` at
# --temp 0, or that name with `-temp_<N>` appended for any other
# temperature - so results at different temperatures land in their own
# folder automatically, same convention as run-humaneval.sh.
#
# --limit: each task has its own sane default below (mmlu's default is
# applied PER SUBJECT across its 57 subjects, not overall, since
# lm-eval-harness applies --limit per-task within a group - the unlimited
# full run would be ~14,000 questions).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT_ENV="../../.env"
[ -f "${ROOT_ENV}" ] && { set -a; source "${ROOT_ENV}"; set +a; }

TASK_SHORT=""
TARGET="baseline"
TEMPERATURE="0"
OUTPUT_NAME=""
LIMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK_SHORT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --temp|--temperature) TEMPERATURE="$2"; shift 2 ;;
    --output|--output-name) OUTPUT_NAME="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "${TASK_SHORT}" ]; then
  echo "Missing required --task (mmlu|wmt16|mbpp|math500)" >&2
  exit 1
fi

UNSAFE_CODE=0
case "${TASK_SHORT}" in
  mmlu)    LM_TASK="mmlu_generative";   DEFAULT_LIMIT=5   ;;
  wmt16)   LM_TASK="wmt16-en-de";       DEFAULT_LIMIT=100 ;;
  mbpp)    LM_TASK="mbpp";              DEFAULT_LIMIT=100; UNSAFE_CODE=1 ;;
  math500) LM_TASK="hendrycks_math500"; DEFAULT_LIMIT=100 ;;
  *)
    echo "Unknown --task '${TASK_SHORT}' - expected mmlu, wmt16, mbpp, or math500" >&2
    exit 1
    ;;
esac
LIMIT="${LIMIT:-${DEFAULT_LIMIT}}"

case "${TARGET}" in
  baseline)
    BASE_URL="${MODEL_SERVER_URL:-http://192.168.2.106:8000}/v1/completions"
    MODEL="Qwen/Qwen3-1.7B"
    DEFAULT_OUTPUT_NAME="baseline-${TASK_SHORT}"
    ;;
  judgejev)
    BASE_URL="http://localhost:8787/v1/completions"
    MODEL="fast"
    DEFAULT_OUTPUT_NAME="through-judgejev-${TASK_SHORT}"
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

UNSAFE_CODE_ARGS=()
if [ "${UNSAFE_CODE}" -eq 1 ]; then
  UNSAFE_CODE_ARGS=(--confirm_run_unsafe_code)
  export HF_ALLOW_CODE_EVAL=1
fi

.venv/bin/lm_eval run \
  --model local-completions \
  --model_args "base_url=${BASE_URL},model=${MODEL},num_concurrent=5,max_retries=3,tokenized_requests=False,tokenizer_backend=None,timeout=180" \
  --tasks "${LM_TASK}" \
  --gen_kwargs "temperature=${TEMPERATURE}" \
  --seed 1234 \
  --limit "${LIMIT}" \
  --output_path "results/${OUTPUT_NAME}" \
  --log_samples \
  "${UNSAFE_CODE_ARGS[@]+"${UNSAFE_CODE_ARGS[@]}"}"
