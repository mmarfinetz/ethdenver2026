#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/e2e/base-sepolia/hooks/deploy-hook.sh <action>" >&2
  exit 1
fi

action="$1"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
report_dir="${E2E_REPORT_DIR:-$root_dir/autonomy/reports/e2e/base-sepolia}"
log_path="$report_dir/deploy-hooks.log"

mkdir -p "$report_dir"
printf "%s action=%s stage=%s\n" \
  "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  "$action" \
  "${AUTOPILOT_DEPLOY_STAGE:-unknown}" >>"$log_path"

echo "[e2e] deploy hook action=$action log=$log_path"
