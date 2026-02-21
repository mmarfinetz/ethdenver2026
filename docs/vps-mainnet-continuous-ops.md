# VPS Mainnet Continuous Operations

This runbook deploys `agent` + `watcher` as persistent `systemd` services on a VPS and enforces live cost-payment configuration.

## 1) VPS prerequisites

- Ubuntu/Debian VPS with systemd
- Node.js 20+ and Corepack available
- A non-root deploy user (example: `ubuntu`)

## 2) Clone and configure

```bash
sudo mkdir -p /opt/ethdenver2026
sudo chown -R "$USER":"$USER" /opt/ethdenver2026
git clone https://github.com/mmarfinetz/ethdenver2026.git /opt/ethdenver2026
cd /opt/ethdenver2026
```

Create env files:

```bash
cp apps/agent/.env.example apps/agent/.env
cp apps/watcher/.env.example apps/watcher/.env
```

Required production settings:

- `apps/agent/.env`
  - `DRY_RUN=false`
  - `CHAIN_ID=8453`
  - `COMPUTE_BILLING_MODE=escrow` or `conway`
  - `ESCROW_ADDRESS=<non-zero>`
  - `MONTHLY_SERVER_COST_USDC=<your real monthly VPS cost>`
- `apps/watcher/.env`
  - `CHAIN_ID=8453`
  - `COMPUTE_BILLING_MODE` must match agent
  - `ESCROW_ADDRESS=<same as agent>`
  - Escrow mode: `ESCROW_MIN_BALANCE_USDC>0`
  - Conway mode: `CONWAY_MIN_CREDITS_BALANCE_USDC>0` and `CONWAY_MIN_PAYER_BALANCE_USDC>0`

Telemetry to dashboard (recommended):

- `apps/agent/.env`: `DASHBOARD_INGEST_URL`, `INGEST_SECRET`
- `apps/watcher/.env`: `DASHBOARD_INGEST_URL`, `INGEST_SECRET`
- Dashboard host env: matching `INGEST_SECRET` + `BLOB_READ_WRITE_TOKEN`

## 3) Preflight validation

```bash
bash scripts/vps/preflight-mainnet.sh
```

This fails fast if live mainnet/cost-payment settings are unsafe or inconsistent.

## 4) Install persistent systemd services

```bash
cd /opt/ethdenver2026
sudo RUN_USER="$USER" REPO_DIR=/opt/ethdenver2026 SERVICE_PREFIX=ssa \
  bash scripts/vps/install-systemd-services.sh
```

This will:

- run preflight checks
- install deps and build `agent` + `watcher`
- create and enable:
  - `ssa-agent.service`
  - `ssa-watcher.service`
- configure watcher shutdown command to `systemctl stop ssa-agent`

## 5) Verify continuous operation

```bash
systemctl status ssa-agent ssa-watcher
journalctl -u ssa-agent -f
journalctl -u ssa-watcher -f
```

Both services are `Restart=always` and `enabled`, so they restart after crashes and reboots.

## 6) Verify cost-payment health

```bash
bash scripts/vps/check-billing-health.sh
```

This verifies:

- latest run is fresh
- `computeBurnUsdc` is positive
- recent runs include successful billing decisions (`pay-escrow`, `fund-escrow`, or `topup-credits`)

## 7) Deploy updates safely

```bash
cd /opt/ethdenver2026
bash scripts/vps/deploy-update.sh
```

This pulls latest code, rebuilds, re-runs preflight, and restarts services.
