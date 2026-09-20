#!/usr/bin/env bash
# Runs HumanEval directly against the model's raw /v1/completions endpoint (no
# JudgeJev, no chat template) - the "before" baseline for coding.
#
# This deliberately does NOT use --apply_chat_template / local-chat-completions.
# HumanEval's task design (and every "_instruct" variant shipped with
# lm-eval-harness) assumes the backend can pre-fill the assistant's response so
# generation continues an already-open code fence. Plain OpenAI-compatible chat
# completions - what both this model server and JudgeJev expose - has no such
# feature, so the model always writes its own opening fence and every shipped
# extraction filter grabs the wrong span (confirmed: every "_instruct" variant
# scored ~0 regardless of code quality). Raw completion mode sidesteps this
# entirely - the prompt already ends mid-function, so the model just continues
# writing real code, no chat template or thinking involved.
#
# Usage:
#   ./run-baseline-humaneval.sh [base_url] [model] [output_name] [limit]
#
# base_url defaults to "${MODEL_SERVER_URL}/v1/completions", reading
# MODEL_SERVER_URL from the repo-root .env if present.
#
# `limit` is optional - full HumanEval is 164 problems and fast enough
# (raw completion, no reasoning overhead) to just run in full.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT_ENV="../../.env"
[ -f "${ROOT_ENV}" ] && { set -a; source "${ROOT_ENV}"; set +a; }

BASE_URL="${1:-${MODEL_SERVER_URL:-http://192.168.2.106:8000}/v1/completions}"
MODEL="${2:-Qwen/Qwen3-1.7B}"
OUTPUT_NAME="${3:-baseline-humaneval}"
LIMIT="${4:-}"

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
  --gen_kwargs 'max_gen_toks=1024,until=["\nclass","\ndef","\n#","\nif"]' \
  --seed 1234 \
  --output_path "results/${OUTPUT_NAME}" \
  --log_samples \
  "${LIMIT_ARGS[@]}"
