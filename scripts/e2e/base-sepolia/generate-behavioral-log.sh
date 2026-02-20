#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/e2e/base-sepolia/generate-behavioral-log.sh --env-file <path> --output <path>

Options:
  --env-file   Agent env file used to run one or more dry-run cycles.
  --output     Output NDJSON run log path.

Environment:
  E2E_AGENT_WAIT_SECONDS      Max wait time for run records (default: 180)
  E2E_AGENT_MIN_RUN_LINES     Minimum run lines required (default: 1)
  E2E_AGENT_INTERVAL_SECONDS  Override RUN_INTERVAL_SECONDS in generated run (default: 20)
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[e2e] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$ENV_FILE" || -z "$OUTPUT_PATH" ]]; then
  usage
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[e2e] env file not found: $ENV_FILE" >&2
  exit 1
fi

WAIT_SECONDS="${E2E_AGENT_WAIT_SECONDS:-180}"
MIN_LINES="${E2E_AGENT_MIN_RUN_LINES:-1}"
INTERVAL_SECONDS="${E2E_AGENT_INTERVAL_SECONDS:-20}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/ssa-agent-behavioral-XXXXXX")"
tmp_env="$tmp_dir/agent.env"
agent_log="$tmp_dir/agent.log"
agent_pid=""

cleanup() {
  if [[ -n "$agent_pid" ]] && kill -0 "$agent_pid" >/dev/null 2>&1; then
    kill "$agent_pid" >/dev/null 2>&1 || true
    wait "$agent_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cp "$ENV_FILE" "$tmp_env"
cat >>"$tmp_env" <<EOF
DRY_RUN=true
RUN_LOG_PATH=$OUTPUT_PATH
RUN_INTERVAL_SECONDS=$INTERVAL_SECONDS
AUTOPILOT_VERSION=e2e-sepolia-behavioral
EOF

rm -f "$OUTPUT_PATH"

set -a
# shellcheck disable=SC1090
source "$tmp_env"
set +a

corepack pnpm --filter agent dry-run >"$agent_log" 2>&1 &
agent_pid="$!"

line_count=0
for ((i = 0; i < WAIT_SECONDS; i += 1)); do
  if [[ -f "$OUTPUT_PATH" ]]; then
    line_count="$(wc -l <"$OUTPUT_PATH" | tr -d '[:space:]')"
    if [[ "$line_count" -ge "$MIN_LINES" ]]; then
      break
    fi
  fi
  if ! kill -0 "$agent_pid" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if kill -0 "$agent_pid" >/dev/null 2>&1; then
  kill "$agent_pid" >/dev/null 2>&1 || true
  wait "$agent_pid" >/dev/null 2>&1 || true
fi

line_count=0
if [[ -f "$OUTPUT_PATH" ]]; then
  line_count="$(wc -l <"$OUTPUT_PATH" | tr -d '[:space:]')"
fi

if [[ "$line_count" -lt "$MIN_LINES" ]]; then
  echo "[e2e] failed to capture enough behavioral runs ($line_count/$MIN_LINES)" >&2
  echo "[e2e] agent log tail:" >&2
  tail -n 40 "$agent_log" >&2 || true
  exit 1
fi

echo "[e2e] generated behavioral run log: $OUTPUT_PATH ($line_count lines)"
