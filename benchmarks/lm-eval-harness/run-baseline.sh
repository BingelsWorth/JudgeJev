#!/usr/bin/env bash
# Runs lm-evaluation-harness directly against a single model (no JudgeJev involved) -
# this is the "before" baseline. See ../../docs/benchmarks/accuracy.md for what this
# is for and how the "after" (through JudgeJev) run will compare against it.
#
# Usage:
#   ./run-baseline.sh [base_url] [model] [tasks] [limit] [output_name]
#
# Defaults match the baseline already committed under results/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BASE_URL="${1:-http://192.168.2.106:8000/v1/chat/completions}"
MODEL="${2:-Qwen/Qwen3-1.7B}"
TASKS="${3:-gsm8k}"
LIMIT="${4:-100}"
OUTPUT_NAME="${5:-baseline-single-model}"

if [ ! -x .venv/bin/lm_eval ]; then
  echo "Setting up .venv (uv required: https://docs.astral.sh/uv/)..."
  uv venv --python 3.11 .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi

.venv/bin/lm_eval run \
  --model local-chat-completions \
  --model_args "base_url=${BASE_URL},model=${MODEL},num_concurrent=5,max_retries=3,think_end_token=</think>,max_gen_toks=3000,timeout=180" \
  --tasks "${TASKS}" \
  --apply_chat_template \
  --limit "${LIMIT}" \
  --seed 1234 \
  --output_path "results/${OUTPUT_NAME}" \
  --log_samples
