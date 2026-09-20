#!/usr/bin/env bash
# Automates the one manual step run-suite.sh couldn't: switching
# MODEL_CONFIGS' fan-out count between full suite passes.
#
# For each requested fan-out size, this:
#   1. Rewrites every "fanout" entry in the repo-root .env's MODEL_CONFIGS
#      to that size (every other line/field of .env is left untouched).
#   2. Restarts `npm run dev` so the new config actually takes effect (wrangler
#      doesn't hot-reload env var changes) and waits for /health.
#   3. Runs run-suite.sh (baseline only on the FIRST fan-out size - baseline
#      doesn't depend on fan-out, so re-running it for every size would be
#      wasted work; every later size passes --skip-baseline automatically).
#   4. Stops the dev server before moving to the next size.
#
# The .env file is ALWAYS restored to its original contents when this script
# exits - normally, on error, or on Ctrl-C - and any dev server this script
# started is always stopped. Nothing about your working .env survives this
# script by design; it's a scratch config for the duration of the sweep only.
#
# Usage:
#   ./run-fanout-sweep.sh                       # sweeps fan-out 3 then 5
#   ./run-fanout-sweep.sh --fanouts 2,3,5
#   ./run-fanout-sweep.sh --only humaneval --judgejev-runs 5 --limit 20
#   (any flag run-suite.sh understands but this script doesn't consume gets
#   passed straight through to every run-suite.sh invocation)
#
# Still fully sequential - one fan-out size's suite (and its one dev server)
# runs to completion before the next size's .env edit + restart happens.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT_DIR="../.."
ROOT_ENV="${ROOT_DIR}/.env"
DEV_LOG="/tmp/judgejev-fanout-sweep-dev.log"
HEALTH_URL="http://localhost:8787/health"

FANOUTS="3,5"
SUITE_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --fanouts) FANOUTS="$2"; shift 2 ;;
    *) SUITE_ARGS+=("$1"); shift ;;
  esac
done

if [ ! -f "${ROOT_ENV}" ]; then
  echo "No .env found at ${ROOT_ENV} - MODEL_CONFIGS must already be set there." >&2
  exit 1
fi

ENV_BACKUP="$(mktemp)"
cp "${ROOT_ENV}" "${ENV_BACKUP}"

cleanup() {
  pkill -f "wrangler dev" 2>/dev/null || true
  cp "${ENV_BACKUP}" "${ROOT_ENV}"
  rm -f "${ENV_BACKUP}"
}
trap cleanup EXIT INT TERM

# Rewrites only the MODEL_CONFIGS line's "fanout" values - every other field
# (including JEV_API_KEY) is preserved byte-for-byte.
set_fanout() {
  local n="$1"
  python3 - "${ROOT_ENV}" "${n}" <<'PYEOF'
import json, pathlib, sys

env_path = pathlib.Path(sys.argv[1])
n = int(sys.argv[2])
lines = env_path.read_text().splitlines(keepends=True)
out = []
changed = False
for line in lines:
    if line.startswith("MODEL_CONFIGS="):
        trailing_newline = "\n" if line.endswith("\n") else ""
        value = line[len("MODEL_CONFIGS="):].rstrip("\n")
        configs = json.loads(value)
        for route in configs:
            fanout = route.get("fanout")
            if isinstance(fanout, dict):
                for key in list(fanout.keys()):
                    fanout[key] = n
        # Compact separators (no spaces) - `.env` gets `source`d as literal
        # shell via `set -a; source .env`, and an unquoted space in the
        # value would make bash treat the rest of the line as separate
        # commands. json.dumps' default separators include a space after
        # ":" and "," which breaks exactly this way.
        out.append(f"MODEL_CONFIGS={json.dumps(configs, separators=(',', ':'))}{trailing_newline}")
        changed = True
    else:
        out.append(line)
if not changed:
    print("MODEL_CONFIGS not found in .env", file=sys.stderr)
    sys.exit(1)
env_path.write_text("".join(out))
PYEOF
}

start_dev_server() {
  pkill -f "wrangler dev" 2>/dev/null || true
  sleep 1
  (cd "${ROOT_DIR}" && nohup npm run dev > "${DEV_LOG}" 2>&1 &)

  local waited=0
  until curl -sf -m 2 "${HEALTH_URL}" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [ "${waited}" -ge 30 ]; then
      echo "JudgeJev didn't come up on :8787 within 30s - see ${DEV_LOG}" >&2
      exit 1
    fi
  done
}

stop_dev_server() {
  pkill -f "wrangler dev" 2>/dev/null || true
  sleep 1
}

IFS=',' read -ra FANOUT_LIST <<< "${FANOUTS}"
first=1
for n in "${FANOUT_LIST[@]}"; do
  echo
  echo "=== Fan-out ${n} ==="
  set_fanout "${n}"
  start_dev_server
  # --fanout-label labels every judgejev results folder with this size, so
  # results from different sizes in this sweep never land in (or silently
  # overwrite) the same folder - always the actual fan-out size, appended
  # after SUITE_ARGS so it wins over any --fanout-label a caller passed in.
  if [ "${first}" -eq 1 ]; then
    ./run-suite.sh "${SUITE_ARGS[@]+"${SUITE_ARGS[@]}"}" --fanout-label "${n}"
    first=0
  else
    ./run-suite.sh --skip-baseline "${SUITE_ARGS[@]+"${SUITE_ARGS[@]}"}" --fanout-label "${n}"
  fi
  stop_dev_server
done

echo
echo ">>> Fan-out sweep complete (tested: ${FANOUTS}). .env restored to its original contents."
