#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${AUTOPILOT_REPLAY_OUTPUT_PATH:-}" ]]; then
  echo "[e2e] AUTOPILOT_REPLAY_OUTPUT_PATH is required" >&2
  exit 1
fi

if [[ -z "${AUTOPILOT_REPLAY_CANDIDATE_ENV_PATH:-}" ]]; then
  echo "[e2e] AUTOPILOT_REPLAY_CANDIDATE_ENV_PATH is required" >&2
  exit 1
fi

if [[ -n "${AUTOPILOT_REPLAY_INPUT_PATH:-}" ]]; then
  echo "[e2e] replay baseline input: ${AUTOPILOT_REPLAY_INPUT_PATH}"
fi

bash scripts/e2e/base-sepolia/generate-behavioral-log.sh \
  --env-file "${AUTOPILOT_REPLAY_CANDIDATE_ENV_PATH}" \
  --output "${AUTOPILOT_REPLAY_OUTPUT_PATH}"

echo "[e2e] behavioral challenger log ready: ${AUTOPILOT_REPLAY_OUTPUT_PATH}"
