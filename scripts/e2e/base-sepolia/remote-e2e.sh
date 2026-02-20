#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/e2e/base-sepolia"
DEFAULT_REPORT_DIR="autonomy/reports/e2e/base-sepolia"

E2E_ENV_FILE="${E2E_ENV_FILE:-$SCRIPT_DIR/e2e.env}"

log() {
  echo "[e2e] $*"
}

fail() {
  echo "[e2e] $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/e2e/base-sepolia/remote-e2e.sh <command>

Commands:
  preflight       Validate git/remote/token/sepolia prerequisites.
  deploy-registry Deploy ChampionRegistry to Base Sepolia and write report env/json outputs.
  run             Execute remote-backed autopilot E2E (PR execute mode + replay + verification + provenance).
  sync-champion   Submit the latest champion scaffold lineage entry onchain.
  all             preflight -> deploy-registry -> run -> sync-champion

Optional:
  E2E_ENV_FILE=<path>  Load an env file before executing commands.
USAGE
}

load_env_file() {
  if [[ -f "$E2E_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$E2E_ENV_FILE"
    set +a
    log "loaded env file $E2E_ENV_FILE"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing required command: $1"
  fi
}

resolve_report_dir() {
  local report_dir="${E2E_REPORT_DIR:-$DEFAULT_REPORT_DIR}"
  if [[ "$report_dir" != /* ]]; then
    report_dir="$ROOT_DIR/$report_dir"
  fi
  echo "$report_dir"
}

resolve_token() {
  if [[ -n "${AUTOPILOT_GITHUB_TOKEN:-}" ]]; then
    echo "$AUTOPILOT_GITHUB_TOKEN"
    return
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "$GITHUB_TOKEN"
    return
  fi
  if [[ -n "${GH_TOKEN:-}" ]]; then
    echo "$GH_TOKEN"
    return
  fi
  echo ""
}

resolve_remote() {
  echo "${AUTOPILOT_PR_REMOTE:-${E2E_GIT_REMOTE:-origin}}"
}

resolve_base_branch() {
  echo "${AUTOPILOT_PR_BASE:-${E2E_GIT_BASE_BRANCH:-main}}"
}

resolve_rpc_url() {
  if [[ -n "${BASE_SEPOLIA_RPC_URL:-}" ]]; then
    echo "$BASE_SEPOLIA_RPC_URL"
    return
  fi
  echo "${BASE_RPC_URL:-}"
}

read_env_value() {
  local file="$1"
  local key="$2"
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  echo "${line#*=}"
}

infer_repository_slug() {
  local remote="$1"
  local remote_url slug
  remote_url="$(git remote get-url "$remote" 2>/dev/null || true)"
  slug=""
  case "$remote_url" in
    git@github.com:*)
      slug="${remote_url#git@github.com:}"
      ;;
    https://github.com/*)
      slug="${remote_url#https://github.com/}"
      ;;
    ssh://git@github.com/*)
      slug="${remote_url#ssh://git@github.com/}"
      ;;
  esac
  slug="${slug%.git}"
  echo "$slug"
}

prepare_approval_file() {
  local approval_file="$1"
  if [[ -f "$approval_file" ]]; then
    return
  fi
  mkdir -p "$(dirname "$approval_file")"
  cat >"$approval_file" <<EOF
{
  "approved": true,
  "approvedBy": "e2e-sepolia-script",
  "approvedAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
EOF
  log "wrote approval file $approval_file"
}

run_preflight() {
  load_env_file
  cd "$ROOT_DIR"

  require_cmd corepack
  require_cmd git
  require_cmd node
  require_cmd forge
  require_cmd cast

  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git repository"

  local remote base_branch token
  remote="$(resolve_remote)"
  base_branch="$(resolve_base_branch)"
  token="$(resolve_token)"

  git remote get-url "$remote" >/dev/null 2>&1 || fail "git remote not found: $remote"
  [[ -n "$token" ]] || fail "missing GitHub token (AUTOPILOT_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN)"

  [[ -f "$ROOT_DIR/apps/agent/.env" ]] || fail "missing apps/agent/.env"
  [[ -f "$ROOT_DIR/apps/watcher/.env" ]] || fail "missing apps/watcher/.env"

  local agent_chain watcher_chain
  agent_chain="$(read_env_value "$ROOT_DIR/apps/agent/.env" "CHAIN_ID")"
  watcher_chain="$(read_env_value "$ROOT_DIR/apps/watcher/.env" "CHAIN_ID")"
  [[ "$agent_chain" == "84532" ]] || fail "apps/agent/.env CHAIN_ID must be 84532 (got ${agent_chain:-unset})"
  [[ "$watcher_chain" == "84532" ]] || fail "apps/watcher/.env CHAIN_ID must be 84532 (got ${watcher_chain:-unset})"

  local rpc_url
  rpc_url="$(resolve_rpc_url)"
  [[ -n "$rpc_url" ]] || fail "BASE_SEPOLIA_RPC_URL or BASE_RPC_URL must be set"

  local live_chain_id
  live_chain_id="$(cast chain-id --rpc-url "$rpc_url")"
  [[ "$live_chain_id" == "84532" ]] || fail "rpc url does not resolve to Base Sepolia (expected 84532, got $live_chain_id)"

  local key_private key_public
  key_private="${E2E_SIGNING_PRIVATE_KEY_FILE:-}"
  key_public="${E2E_SIGNING_PUBLIC_KEY_FILE:-}"
  [[ -n "$key_private" && -f "$key_private" ]] || fail "missing E2E_SIGNING_PRIVATE_KEY_FILE"
  [[ -n "$key_public" && -f "$key_public" ]] || fail "missing E2E_SIGNING_PUBLIC_KEY_FILE"

  git fetch "$remote" "$base_branch" >/dev/null

  log "preflight passed (remote=$remote base=$base_branch chain=84532)"
}

run_deploy_registry() {
  load_env_file
  cd "$ROOT_DIR"
  bash scripts/e2e/base-sepolia/deploy-champion-registry.sh
}

run_autopilot_e2e() {
  load_env_file
  run_preflight
  cd "$ROOT_DIR"

  local report_dir
  report_dir="$(resolve_report_dir)"
  mkdir -p "$report_dir"

  local registry_env_path
  registry_env_path="$report_dir/champion-registry.env"
  if [[ -f "$registry_env_path" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$registry_env_path"
    set +a
    log "loaded deployed registry metadata from $registry_env_path"
  fi

  local remote base_branch rpc_url token commit_sha base_sha head_sha
  remote="$(resolve_remote)"
  base_branch="$(resolve_base_branch)"
  rpc_url="$(resolve_rpc_url)"
  token="$(resolve_token)"
  commit_sha="$(git rev-parse HEAD)"
  base_sha="$(git rev-parse "$remote/$base_branch")"
  head_sha="$(git rev-parse HEAD)"

  local repository_slug
  repository_slug="${AUTOPILOT_GITHUB_REPOSITORY:-$(infer_repository_slug "$remote")}"
  [[ -n "$repository_slug" ]] || fail "unable to infer GitHub repository slug; set AUTOPILOT_GITHUB_REPOSITORY"

  local baseline_env candidate_env baseline_log candidate_log
  baseline_env="${E2E_AGENT_BASELINE_ENV_PATH:-apps/agent/.env}"
  candidate_env="${E2E_AGENT_CANDIDATE_ENV_PATH:-apps/agent/.env}"
  baseline_log="$report_dir/baseline-runs.ndjson"
  candidate_log="$report_dir/candidate-runs.ndjson"

  bash scripts/e2e/base-sepolia/generate-behavioral-log.sh \
    --env-file "$baseline_env" \
    --output "$baseline_log"

  local approval_file
  approval_file="${AUTOPILOT_APPROVAL_FILE:-$ROOT_DIR/autonomy/approval.json}"
  if [[ "${AUTOPILOT_REQUIRE_HUMAN_APPROVAL:-false}" == "true" ]]; then
    prepare_approval_file "$approval_file"
  fi

  local private_key_file public_key_file
  private_key_file="${E2E_SIGNING_PRIVATE_KEY_FILE:-}"
  public_key_file="${E2E_SIGNING_PUBLIC_KEY_FILE:-}"

  local hook_script
  hook_script="bash scripts/e2e/base-sepolia/hooks/deploy-hook.sh"

  export BASE_RPC_URL="$rpc_url"
  export BASE_SEPOLIA_RPC_URL="$rpc_url"
  export CHAIN_ID=84532
  export ALLOW_TESTNET=true

  export AUTOPILOT_COMMIT_SHA="$commit_sha"
  export AUTOPILOT_EXPECTED_COMMIT_SHA="$commit_sha"
  export AUTOPILOT_GIT_BASE="$base_sha"
  export AUTOPILOT_GIT_HEAD="$head_sha"
  export AUTOPILOT_GITHUB_REPOSITORY="$repository_slug"
  export AUTOPILOT_GITHUB_TOKEN="$token"
  export AUTOPILOT_PR_MODE="${AUTOPILOT_PR_MODE:-execute}"
  export AUTOPILOT_PR_REMOTE="$remote"
  export AUTOPILOT_PR_BASE="$base_branch"
  export AUTOPILOT_PR_DRAFT_PATH="${AUTOPILOT_PR_DRAFT_PATH:-$report_dir/pr-draft.json}"

  export AUTOPILOT_PHASE="${AUTOPILOT_PHASE:-3}"
  export AUTOPILOT_RUN_VERIFICATION=true
  export AUTOPILOT_VERIFY_PROVENANCE=true
  export AUTOPILOT_PROVENANCE_REQUIRE_SIGNATURE=true
  export AUTOPILOT_POLICY_GATE_STRICT_DIFF_SOURCE=true

  export AUTOPILOT_BASELINE_RUN_LOG_PATH="$baseline_log"
  export AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH="$candidate_log"
  export AUTOPILOT_BASELINE_ENV_PATH="$baseline_env"
  export AUTOPILOT_CANDIDATE_ENV_PATH="$candidate_env"
  export AUTOPILOT_REPLAY_CANDIDATE_COMMAND="bash scripts/e2e/base-sepolia/replay-candidate-command.sh"
  export AUTOPILOT_REPLAY_REPORT_PATH="${AUTOPILOT_REPLAY_REPORT_PATH:-$report_dir/replay.json}"
  export AUTOPILOT_VERIFY_REPORT_PATH="${AUTOPILOT_VERIFY_REPORT_PATH:-$report_dir/verification.json}"
  export AUTOPILOT_DEPLOY_REPORT_PATH="${AUTOPILOT_DEPLOY_REPORT_PATH:-$report_dir/deploy-decision.json}"

  export AUTOPILOT_DEPLOY_STAGE="${AUTOPILOT_DEPLOY_STAGE:-shadow_canary}"
  export AUTOPILOT_DEPLOY_PROMOTE_TO_LIVE_COMMAND="${AUTOPILOT_DEPLOY_PROMOTE_TO_LIVE_COMMAND:-$hook_script promote-live}"
  export AUTOPILOT_DEPLOY_PROMOTE_TO_PROD_COMMAND="${AUTOPILOT_DEPLOY_PROMOTE_TO_PROD_COMMAND:-$hook_script promote-prod}"
  export AUTOPILOT_DEPLOY_ROLLBACK_COMMAND="${AUTOPILOT_DEPLOY_ROLLBACK_COMMAND:-$hook_script rollback}"

  export AUTOPILOT_APPROVAL_FILE="$approval_file"
  export AUTOPILOT_CHAMPION_STATE_PATH="${AUTOPILOT_CHAMPION_STATE_PATH:-$ROOT_DIR/apps/watcher/data/champions/state.json}"

  if [[ -n "${AUTOPILOT_CHAMPION_REGISTRY_ADDRESS:-}" ]]; then
    log "using champion registry: $AUTOPILOT_CHAMPION_REGISTRY_ADDRESS"
  else
    log "champion registry address not set; run deploy-registry first if onchain sync is required"
  fi

  export AUTOPILOT_SIGNING_PRIVATE_KEY_PEM="$(cat "$private_key_file")"
  export AUTOPILOT_SIGNING_PUBLIC_KEY_PEM="$(cat "$public_key_file")"

  log "building artifacts for provenance"
  corepack pnpm --filter agent build
  corepack pnpm --filter watcher build

  log "generating provenance bundle"
  corepack pnpm --filter watcher autopilot:provenance:generate

  log "running autopilot execute-mode E2E"
  corepack pnpm --filter watcher autopilot:start

  log "autopilot run complete"
  log "reports:"
  log "  replay      $AUTOPILOT_REPLAY_REPORT_PATH"
  log "  verify      $AUTOPILOT_VERIFY_REPORT_PATH"
  log "  deploy      $AUTOPILOT_DEPLOY_REPORT_PATH"
  log "  pr draft    $AUTOPILOT_PR_DRAFT_PATH"
  log "  champion    $AUTOPILOT_CHAMPION_STATE_PATH"
}

run_sync_champion() {
  load_env_file
  cd "$ROOT_DIR"
  bash scripts/e2e/base-sepolia/sync-champion-registry.sh
}

main() {
  local command="${1:-}"
  case "$command" in
    preflight)
      run_preflight
      ;;
    deploy-registry)
      run_deploy_registry
      ;;
    run)
      run_autopilot_e2e
      ;;
    sync-champion)
      run_sync_champion
      ;;
    all)
      run_preflight
      run_deploy_registry
      run_autopilot_e2e
      run_sync_champion
      ;;
    -h|--help|"")
      usage
      ;;
    *)
      fail "unknown command: $command"
      ;;
  esac
}

main "$@"
