#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_ENV="${AGENT_ENV:-$ROOT_DIR/apps/agent/.env}"
WINDOW_RUNS="${WINDOW_RUNS:-40}"
MAX_AGE_MINUTES="${MAX_AGE_MINUTES:-30}"

fail() {
  echo "[billing-health:error] $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "missing file: $path"
}

read_env_value() {
  local path="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $0 ~ "^[[:space:]]*"key"=" {
      value = substr($0, index($0, "=") + 1);
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value);
      print value;
      exit;
    }
  ' "$path"
}

require_file "$AGENT_ENV"

run_log_path_raw="$(read_env_value "$AGENT_ENV" "RUN_LOG_PATH")"
run_log_path_raw="${run_log_path_raw:-./data/runs.ndjson}"

if [[ "$run_log_path_raw" = /* ]]; then
  RUN_LOG_PATH="$run_log_path_raw"
else
  RUN_LOG_PATH="$ROOT_DIR/apps/agent/$run_log_path_raw"
fi

require_file "$RUN_LOG_PATH"

node - "$RUN_LOG_PATH" "$WINDOW_RUNS" "$MAX_AGE_MINUTES" <<'NODE'
const fs = require("node:fs");

const runLogPath = process.argv[2];
const windowRuns = Number(process.argv[3]);
const maxAgeMinutes = Number(process.argv[4]);

if (!Number.isFinite(windowRuns) || windowRuns <= 0) {
  console.error("[billing-health:error] WINDOW_RUNS must be > 0");
  process.exit(1);
}
if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
  console.error("[billing-health:error] MAX_AGE_MINUTES must be > 0");
  process.exit(1);
}

const raw = fs.readFileSync(runLogPath, "utf8");
const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
if (lines.length === 0) {
  console.error("[billing-health:error] run log is empty");
  process.exit(1);
}

const parseBigIntLike = (value) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const runs = lines.map((line) => JSON.parse(line));
const last = runs[runs.length - 1];
const lastTimestampMs = Date.parse(String(last.timestamp ?? ""));
if (!Number.isFinite(lastTimestampMs)) {
  console.error("[billing-health:error] latest run has invalid timestamp");
  process.exit(1);
}

const ageMinutes = (Date.now() - lastTimestampMs) / 60000;
if (ageMinutes > maxAgeMinutes) {
  console.error(
    `[billing-health:error] latest run is stale (${ageMinutes.toFixed(1)}m > ${maxAgeMinutes}m): ${last.timestamp}`
  );
  process.exit(1);
}

const computeBurnUsdc = parseBigIntLike(last.computeBurnUsdc);
if (computeBurnUsdc <= 0n) {
  console.error("[billing-health:error] latest run computeBurnUsdc is not positive");
  process.exit(1);
}

const recent = runs.slice(-windowRuns);
const billingDecisions = new Set(["pay-escrow", "fund-escrow", "topup-credits"]);
const successfulBillingRuns = recent.filter((run) => billingDecisions.has(run.decision) && run.status === "ok");
if (successfulBillingRuns.length === 0) {
  console.error(
    `[billing-health:error] no successful billing decisions found in last ${recent.length} runs`
  );
  process.exit(1);
}

const lastBilling = successfulBillingRuns[successfulBillingRuns.length - 1];
console.log(
  `[billing-health] ok runs=${runs.length} latest=${last.timestamp} latestDecision=${last.decision} latestStatus=${last.status} latestComputeBurnUsdc=${computeBurnUsdc.toString()} lastBillingDecision=${lastBilling.decision} lastBillingTimestamp=${lastBilling.timestamp}`
);
NODE
