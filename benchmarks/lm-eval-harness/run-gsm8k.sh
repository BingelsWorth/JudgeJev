#!/usr/bin/env bash
# Runs the gsm8k lm-evaluation-harness benchmark against EITHER the model
# directly (baseline, "before") OR through JudgeJev's fan-out+judge pipeline
# ("after") - same task/limit/seed either way, so the two are directly
# comparable. Which one you hit is the `target` argument, not a different
# script, so the two runs can't silently drift out of sync with each other.
#
# Usage:
#   ./run-gsm8k.sh [target] [tasks] [limit] [output_name] [fanout_label] [run_label]
#
# target: "baseline" (default) - hits ${MODEL_SERVER_URL}/v1/chat/completions
#         directly, no JudgeJev involved.
#         "judgejev" - hits JudgeJev's proxy instead (requires `npm run dev`
#         running from the repo root; `model` is the logical/fan-out name
#         from MODEL_CONFIGS, e.g. "fast" - not an upstream model id).
#
# fanout_label: only meaningful for target=judgejev (baseline doesn't depend
# on fan-out size, so it's ignored there) and only applies when output_name
# is left blank - appends `-fanout_<label>` to the default judgejev results
# folder name so runs at different MODEL_CONFIGS fan-out counts don't
# silently overwrite each other under the same name. Set automatically by
# run-fanout-sweep.sh.
#
# MODEL_SERVER_URL is read from the repo-root .env if present.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT_ENV="../../.env"
[ -f "${ROOT_ENV}" ] && { set -a; source "${ROOT_ENV}"; set +a; }

TARGET="${1:-baseline}"
TASKS="${2:-gsm8k}"
LIMIT="${3:-100}"
OUTPUT_NAME_ARG="${4:-}"
FANOUT_LABEL="${5:-}"
RUN_LABEL="${6:-run_1}"

case "${TARGET}" in
  baseline)
    BASE_URL="${MODEL_SERVER_URL:-http://192.168.2.106:8000}/v1/chat/completions"
    MODEL="Qwen/Qwen3-1.7B"
    NUM_CONCURRENT=5
    OUTPUT_NAME="${OUTPUT_NAME_ARG:-baseline-gsm8k}"
    ;;
  judgejev)
    BASE_URL="http://localhost:8787/v1/chat/completions"
    MODEL="fast"
    NUM_CONCURRENT=2
    if [ -n "${OUTPUT_NAME_ARG}" ]; then
      OUTPUT_NAME="${OUTPUT_NAME_ARG}"
    elif [ -n "${FANOUT_LABEL}" ]; then
      OUTPUT_NAME="judgejev-gsm8k-fanout_${FANOUT_LABEL}"
    else
      OUTPUT_NAME="judgejev-gsm8k"
    fi
    HEALTH_URL="${BASE_URL%%/v1/*}/health"
    if ! curl -sf -m 5 "${HEALTH_URL}" >/dev/null 2>&1; then
      echo "Warning: could not reach JudgeJev at ${HEALTH_URL} - is it running (npm run dev)? Continuing anyway." >&2
    fi
    ;;
  *)
    echo "Unknown target '${TARGET}' - expected 'baseline' or 'judgejev'" >&2
    exit 1
    ;;
esac

if [ -z "${OUTPUT_NAME_ARG}" ]; then
  OUTPUT_NAME="${OUTPUT_NAME}-${RUN_LABEL}"
fi

if [ ! -x .venv/bin/lm_eval ]; then
  echo "Setting up .venv (uv required: https://docs.astral.sh/uv/)..."
  uv venv --python 3.11 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi

.venv/bin/lm_eval run \
  --model local-chat-completions \
  --model_args "base_url=${BASE_URL},model=${MODEL},num_concurrent=${NUM_CONCURRENT},max_retries=3,think_end_token=</think>,max_gen_toks=3000,timeout=180" \
  --tasks "${TASKS}" \
  --apply_chat_template \
  --limit "${LIMIT}" \
  --seed 1234 \
  --output_path "results/${OUTPUT_NAME}" \
  --log_samples
