#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_DIR="${REPO_DIR:-$ROOT_DIR}"
SERVICE_PREFIX="${SERVICE_PREFIX:-ssa}"
BRANCH="${BRANCH:-}"

AGENT_SERVICE="${SERVICE_PREFIX}-agent"
WATCHER_SERVICE="${SERVICE_PREFIX}-watcher"

fail() {
  echo "[deploy:error] $*" >&2
  exit 1
}

info() {
  echo "[deploy] $*"
}

require_path() {
  local path="$1"
  [[ -e "$path" ]] || fail "missing required path: $path"
}

require_path "$REPO_DIR/.git"
require_path "$REPO_DIR/package.json"

PNPM_INSTALL_FLAG="--frozen-lockfile"
if [[ ! -f "$REPO_DIR/pnpm-lock.yaml" ]]; then
  PNPM_INSTALL_FLAG="--no-frozen-lockfile"
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
fi

SYSTEMCTL="systemctl"
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  SYSTEMCTL="sudo systemctl"
fi

info "repoDir=$REPO_DIR branch=$BRANCH servicePrefix=$SERVICE_PREFIX"

info "updating source"
git -C "$REPO_DIR" fetch origin
git -C "$REPO_DIR" checkout "$BRANCH"
git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"

info "installing dependencies and building"
bash -lc "cd '$REPO_DIR' && corepack pnpm install $PNPM_INSTALL_FLAG"
bash -lc "cd '$REPO_DIR' && corepack pnpm --filter agent build"
bash -lc "cd '$REPO_DIR' && corepack pnpm --filter watcher build"

info "running preflight"
bash -lc "cd '$REPO_DIR' && bash scripts/vps/preflight-mainnet.sh"

info "restarting services"
$SYSTEMCTL restart "${AGENT_SERVICE}.service" "${WATCHER_SERVICE}.service"

info "service status snapshot"
$SYSTEMCTL --no-pager --full status "${AGENT_SERVICE}.service" | sed -n '1,14p'
$SYSTEMCTL --no-pager --full status "${WATCHER_SERVICE}.service" | sed -n '1,14p'

info "update complete"
