#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_ENV="${AGENT_ENV:-$ROOT_DIR/apps/agent/.env}"
WATCHER_ENV="${WATCHER_ENV:-$ROOT_DIR/apps/watcher/.env}"

fail() {
  echo "[preflight:error] $*" >&2
  exit 1
}

warn() {
  echo "[preflight:warn] $*" >&2
}

info() {
  echo "[preflight] $*"
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

to_lower() {
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]'
}

bool_is_falsey() {
  local value
  value="$(to_lower "$1")"
  case "$value" in
    "" | "0" | "false" | "no" | "n")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_decimal() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

is_zero_decimal() {
  [[ "$1" =~ ^0+([.]0+)?$ ]]
}

is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_zero_address() {
  local value
  value="$(to_lower "$1")"
  [[ "$value" == "0x0000000000000000000000000000000000000000" ]]
}

mask_address() {
  local value="$1"
  if [[ "${#value}" -lt 12 ]]; then
    printf "%s" "$value"
    return
  fi
  printf "%s...%s" "${value:0:8}" "${value: -4}"
}

mask_url_host() {
  local value="$1"
  local host
  host="$(printf "%s" "$value" | sed -E 's#^[a-zA-Z]+://([^/@]+@)?([^/:?]+).*#\2#')"
  printf "%s" "${host:-unknown}"
}

require_file "$AGENT_ENV"
require_file "$WATCHER_ENV"

agent_chain_id="$(read_env_value "$AGENT_ENV" "CHAIN_ID")"
watcher_chain_id="$(read_env_value "$WATCHER_ENV" "CHAIN_ID")"
agent_chain_id="${agent_chain_id:-8453}"
watcher_chain_id="${watcher_chain_id:-8453}"

[[ "$agent_chain_id" == "8453" ]] || fail "apps/agent/.env CHAIN_ID must be 8453 for mainnet (got $agent_chain_id)"
[[ "$watcher_chain_id" == "8453" ]] || fail "apps/watcher/.env CHAIN_ID must be 8453 for mainnet (got $watcher_chain_id)"

agent_dry_run="$(read_env_value "$AGENT_ENV" "DRY_RUN")"
if ! bool_is_falsey "${agent_dry_run:-false}"; then
  fail "apps/agent/.env DRY_RUN must be false for continuous live operation"
fi

agent_mode="$(to_lower "$(read_env_value "$AGENT_ENV" "COMPUTE_BILLING_MODE")")"
watcher_mode="$(to_lower "$(read_env_value "$WATCHER_ENV" "COMPUTE_BILLING_MODE")")"
agent_mode="${agent_mode:-escrow}"
watcher_mode="${watcher_mode:-escrow}"

[[ "$agent_mode" == "escrow" || "$agent_mode" == "conway" ]] || fail "invalid agent COMPUTE_BILLING_MODE: $agent_mode"
[[ "$watcher_mode" == "escrow" || "$watcher_mode" == "conway" ]] || fail "invalid watcher COMPUTE_BILLING_MODE: $watcher_mode"
[[ "$agent_mode" == "$watcher_mode" ]] || fail "agent/watcher COMPUTE_BILLING_MODE mismatch ($agent_mode vs $watcher_mode)"

agent_rpc="$(read_env_value "$AGENT_ENV" "BASE_RPC_URL")"
watcher_rpc="$(read_env_value "$WATCHER_ENV" "BASE_RPC_URL")"
[[ -n "$agent_rpc" ]] || fail "apps/agent/.env BASE_RPC_URL is required"
[[ -n "$watcher_rpc" ]] || fail "apps/watcher/.env BASE_RPC_URL is required"

agent_escrow="$(read_env_value "$AGENT_ENV" "ESCROW_ADDRESS")"
watcher_escrow="$(read_env_value "$WATCHER_ENV" "ESCROW_ADDRESS")"
[[ -n "$agent_escrow" ]] || fail "apps/agent/.env ESCROW_ADDRESS is required"
[[ -n "$watcher_escrow" ]] || fail "apps/watcher/.env ESCROW_ADDRESS is required"
is_zero_address "$agent_escrow" && fail "apps/agent/.env ESCROW_ADDRESS must be non-zero"
is_zero_address "$watcher_escrow" && fail "apps/watcher/.env ESCROW_ADDRESS must be non-zero"
[[ "$(to_lower "$agent_escrow")" == "$(to_lower "$watcher_escrow")" ]] || fail "agent/watcher ESCROW_ADDRESS mismatch"

monthly_cost_usdc="$(read_env_value "$AGENT_ENV" "MONTHLY_SERVER_COST_USDC")"
monthly_cost_usdc="${monthly_cost_usdc:-7.50}"
is_decimal "$monthly_cost_usdc" || fail "apps/agent/.env MONTHLY_SERVER_COST_USDC must be a decimal number"
is_zero_decimal "$monthly_cost_usdc" && fail "apps/agent/.env MONTHLY_SERVER_COST_USDC must be > 0 in live mode"

run_interval_seconds="$(read_env_value "$AGENT_ENV" "RUN_INTERVAL_SECONDS")"
run_interval_seconds="${run_interval_seconds:-60}"
is_positive_int "$run_interval_seconds" || fail "apps/agent/.env RUN_INTERVAL_SECONDS must be a positive integer"

watch_interval_seconds="$(read_env_value "$WATCHER_ENV" "WATCH_INTERVAL_SECONDS")"
watch_interval_seconds="${watch_interval_seconds:-300}"
is_positive_int "$watch_interval_seconds" || fail "apps/watcher/.env WATCH_INTERVAL_SECONDS must be a positive integer"

shutdown_command="$(read_env_value "$WATCHER_ENV" "SHUTDOWN_COMMAND")"
shutdown_command="${shutdown_command:-systemctl stop ssa-agent}"
if [[ ! "$shutdown_command" =~ ^systemctl[[:space:]]+stop[[:space:]]+[[:alnum:]_.@-]*agent([.]service)?$ ]]; then
  fail "apps/watcher/.env SHUTDOWN_COMMAND should stop the agent systemd service (got: $shutdown_command)"
fi

if [[ "$agent_mode" == "escrow" ]]; then
  watcher_min_escrow="$(read_env_value "$WATCHER_ENV" "ESCROW_MIN_BALANCE_USDC")"
  watcher_min_escrow="${watcher_min_escrow:-0}"
  is_decimal "$watcher_min_escrow" || fail "apps/watcher/.env ESCROW_MIN_BALANCE_USDC must be a decimal number"
  is_zero_decimal "$watcher_min_escrow" && fail "apps/watcher/.env ESCROW_MIN_BALANCE_USDC must be > 0 in escrow mode"
else
  agent_conway_api="$(read_env_value "$AGENT_ENV" "CONWAY_API_BASE_URL")"
  watcher_conway_api="$(read_env_value "$WATCHER_ENV" "CONWAY_API_BASE_URL")"
  [[ -n "$agent_conway_api" ]] || fail "apps/agent/.env CONWAY_API_BASE_URL is required in conway mode"
  [[ -n "$watcher_conway_api" ]] || fail "apps/watcher/.env CONWAY_API_BASE_URL is required in conway mode"

  watcher_min_credits="$(read_env_value "$WATCHER_ENV" "CONWAY_MIN_CREDITS_BALANCE_USDC")"
  watcher_min_payer="$(read_env_value "$WATCHER_ENV" "CONWAY_MIN_PAYER_BALANCE_USDC")"
  watcher_min_credits="${watcher_min_credits:-0}"
  watcher_min_payer="${watcher_min_payer:-0}"
  is_decimal "$watcher_min_credits" || fail "apps/watcher/.env CONWAY_MIN_CREDITS_BALANCE_USDC must be a decimal number"
  is_decimal "$watcher_min_payer" || fail "apps/watcher/.env CONWAY_MIN_PAYER_BALANCE_USDC must be a decimal number"
  is_zero_decimal "$watcher_min_credits" && fail "apps/watcher/.env CONWAY_MIN_CREDITS_BALANCE_USDC must be > 0 in conway mode"
  is_zero_decimal "$watcher_min_payer" && fail "apps/watcher/.env CONWAY_MIN_PAYER_BALANCE_USDC must be > 0 in conway mode"
fi

agent_ingest_url="$(read_env_value "$AGENT_ENV" "DASHBOARD_INGEST_URL")"
agent_ingest_secret="$(read_env_value "$AGENT_ENV" "INGEST_SECRET")"
watcher_ingest_url="$(read_env_value "$WATCHER_ENV" "DASHBOARD_INGEST_URL")"
watcher_ingest_secret="$(read_env_value "$WATCHER_ENV" "INGEST_SECRET")"
if [[ -z "$agent_ingest_url" || -z "$agent_ingest_secret" || -z "$watcher_ingest_url" || -z "$watcher_ingest_secret" ]]; then
  warn "dashboard telemetry is not fully configured in agent/watcher env files"
fi

info "pass chainId=8453 mode=$agent_mode"
info "agent rpc host=$(mask_url_host "$agent_rpc") runInterval=${run_interval_seconds}s monthlyCostUsdc=$monthly_cost_usdc"
info "watcher rpc host=$(mask_url_host "$watcher_rpc") watchInterval=${watch_interval_seconds}s shutdown='${shutdown_command}'"
info "escrow=$(mask_address "$agent_escrow")"
