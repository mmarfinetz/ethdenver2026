#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_DIR="${REPO_DIR:-$ROOT_DIR}"
RUN_USER="${RUN_USER:-${SUDO_USER:-}}"
RUN_GROUP="${RUN_GROUP:-$RUN_USER}"
SERVICE_PREFIX="${SERVICE_PREFIX:-ssa}"

AGENT_SERVICE="${SERVICE_PREFIX}-agent"
WATCHER_SERVICE="${SERVICE_PREFIX}-watcher"
AGENT_UNIT="/etc/systemd/system/${AGENT_SERVICE}.service"
WATCHER_UNIT="/etc/systemd/system/${WATCHER_SERVICE}.service"

fail() {
  echo "[install:error] $*" >&2
  exit 1
}

info() {
  echo "[install] $*"
}

ensure_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    fail "run as root (example: sudo RUN_USER=ubuntu bash scripts/vps/install-systemd-services.sh)"
  fi
}

require_path() {
  local path="$1"
  [[ -e "$path" ]] || fail "missing required path: $path"
}

upsert_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -qE "^${key}=" "$file"; then
    sed -i.bak -E "s#^${key}=.*#${key}=${value}#" "$file"
    rm -f "${file}.bak"
  else
    printf "\n%s=%s\n" "$key" "$value" >> "$file"
  fi
}

ensure_root
[[ -n "$RUN_USER" ]] || fail "set RUN_USER to the non-root account that should run the services"
id "$RUN_USER" >/dev/null 2>&1 || fail "user not found: $RUN_USER"
id -g "$RUN_GROUP" >/dev/null 2>&1 || fail "group not found: $RUN_GROUP"

require_path "$REPO_DIR/package.json"
require_path "$REPO_DIR/apps/agent/.env"
require_path "$REPO_DIR/apps/watcher/.env"

PNPM_INSTALL_FLAG="--frozen-lockfile"
if [[ ! -f "$REPO_DIR/pnpm-lock.yaml" ]]; then
  PNPM_INSTALL_FLAG="--no-frozen-lockfile"
fi

info "repoDir=$REPO_DIR user=$RUN_USER group=$RUN_GROUP servicePrefix=$SERVICE_PREFIX"

upsert_env_key "$REPO_DIR/apps/watcher/.env" "SHUTDOWN_COMMAND" "systemctl stop ${AGENT_SERVICE}"

info "running mainnet preflight checks"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && bash scripts/vps/preflight-mainnet.sh"

info "installing dependencies and building agent/watcher"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && corepack pnpm install $PNPM_INSTALL_FLAG"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && corepack pnpm --filter agent build"
sudo -u "$RUN_USER" bash -lc "cd '$REPO_DIR' && corepack pnpm --filter watcher build"

info "writing $AGENT_UNIT"
cat > "$AGENT_UNIT" <<EOF
[Unit]
Description=Self-Sustaining Agent (Base Mainnet)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$REPO_DIR/apps/agent
Environment=NODE_ENV=production
ExecStart=/usr/bin/env bash -lc 'corepack pnpm start'
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

info "writing $WATCHER_UNIT"
cat > "$WATCHER_UNIT" <<EOF
[Unit]
Description=Self-Sustaining Watcher (Base Mainnet)
After=network-online.target ${AGENT_SERVICE}.service
Wants=network-online.target ${AGENT_SERVICE}.service
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$REPO_DIR/apps/watcher
Environment=NODE_ENV=production
ExecStart=/usr/bin/env bash -lc 'corepack pnpm start'
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

info "reloading systemd and enabling services"
systemctl daemon-reload
systemctl enable --now "${AGENT_SERVICE}.service" "${WATCHER_SERVICE}.service"

info "service status snapshot"
systemctl --no-pager --full status "${AGENT_SERVICE}.service" | sed -n '1,14p'
systemctl --no-pager --full status "${WATCHER_SERVICE}.service" | sed -n '1,14p'

info "tail logs with: journalctl -u ${AGENT_SERVICE} -f"
info "tail logs with: journalctl -u ${WATCHER_SERVICE} -f"
