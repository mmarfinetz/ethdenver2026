# Mainnet Conway Supervised Canary Checklist

Scope: first Base mainnet live launch with `COMPUTE_BILLING_MODE=conway`.

Operator: `__________`  
Date: `__________`  
Rollback owner: `__________`

## 1) Preflight

- [ ] `apps/agent/.env` is set for mainnet and Conway billing:
  - `CHAIN_ID=8453`
  - `ALLOW_TESTNET=false`
  - `COMPUTE_BILLING_MODE=conway`
  - `CONWAY_API_BASE_URL` and `CONWAY_API_KEY`
  - `CONWAY_CREDITS_BALANCE_PATH` and `CONWAY_CREDITS_TOPUP_PATH`
  - `CONWAY_X402_ENABLED` and (if enabled) `CONWAY_PAYER_PRIVATE_KEY`
  - `CONWAY_PAYER_ADDRESS` (or let it derive from payer private key)
  - `CONWAY_CREDITS_MIN_BALANCE_USDC`, `CONWAY_CREDITS_TARGET_BALANCE_USDC`
  - `CONWAY_PAYER_MIN_BALANCE_USDC`, `CONWAY_PAYER_TARGET_BALANCE_USDC`
  - `CONWAY_PAYER_MAX_FUND_USDC_PER_TICK`, `CONWAY_PAYER_MAX_FUND_USDC_PER_DAY`
  - `CONWAY_CREDITS_TOPUP_COOLDOWN_SECONDS`, `CONWAY_PAYER_FUND_COOLDOWN_SECONDS`
  - `CONWAY_FALLBACK_TO_ESCROW_ON_ERROR=false` (recommended for first canary)
  - `DRY_RUN=true`
- [ ] Canary run log path is isolated in `apps/agent/.env`:
  - `RUN_LOG_PATH=./data/runs-conway-canary.ndjson`
- [ ] `apps/watcher/.env` safety controls are set:
  - `CHAIN_ID=8453`, `ALLOW_TESTNET=false`
  - `WATCH_INTERVAL_SECONDS`, `WATCH_FAILURE_THRESHOLD`, `ESCROW_MIN_BALANCE_USDC`, `SHUTDOWN_COMMAND`
  - `CONWAY_PAYER_ADDRESS`, `CONWAY_MIN_CREDITS_BALANCE_USDC`, `CONWAY_MIN_PAYER_BALANCE_USDC`
  - `WATCH_LOW_CREDITS_GRACE_CHECKS`, `WATCH_LOW_PAYER_GRACE_CHECKS`
  - `AUTOPILOT_EMERGENCY_STOP=false`
  - `AUTOPILOT_REQUIRE_HUMAN_APPROVAL=true`
  - `AUTOPILOT_TIMELOCK_HOURS=24`
  - `AUTOPILOT_APPROVAL_FILE=../../autonomy/approval.json`
- [ ] `apps/watcher/.env` replay baselines point to real logs:
  - `AUTOPILOT_BASELINE_RUN_LOG_PATH=../agent/data/runs.ndjson`
  - `AUTOPILOT_CANDIDATE_RUN_LOG_PATH=../agent/data/runs-conway-canary.ndjson`
- [ ] Optional (if watcher should read Conway balance directly):
  - `COMPUTE_BILLING_MODE=conway`
  - `CONWAY_API_BASE_URL`, `CONWAY_API_KEY`, `CONWAY_CREDITS_BALANCE_PATH`, `CONWAY_FALLBACK_TO_ESCROW_ON_ERROR`
- [ ] Validation commands pass:

```bash
pnpm typecheck
pnpm build
pnpm --filter agent test
pnpm --filter contracts test
pnpm watcher:verify
```

- [ ] One smoke cycle in dry run succeeds:

```bash
pnpm agent:dry-run
```

## 2) Launch

- [ ] Terminal A (funding watchdog):

```bash
pnpm watcher:start
```

- [ ] Set `DRY_RUN=false` in `apps/agent/.env`.
- [ ] Terminal B (live agent):

```bash
pnpm agent:start
```

- [ ] Record launch timestamp and operator on call.

## 3) Monitor (Supervised Window)

Target: first `25` live runs (matches `autonomy/policy.yaml` `deployment.live_canary_min_runs`).

- [ ] Stream canary runs:

```bash
tail -f apps/agent/data/runs-conway-canary.ndjson
```

- [ ] Every ~5 runs, check for regressions:

```bash
rg '"status":"error"' apps/agent/data/runs-conway-canary.ndjson | tail -n 5
rg '"fundingSource":"escrow-fallback"|"topupStatus":"error"' apps/agent/data/runs-conway-canary.ndjson | tail -n 10
```

- [ ] Every ~15 minutes, evaluate baseline vs canary:

```bash
pnpm --filter watcher autopilot:replay
cat autonomy/reports/replay.json
```

- [ ] Keep latest `autonomy/reports/verification.json` and `autonomy/reports/replay.json` attached to operator notes.

## 4) Rollback

Trigger rollback immediately if any of the following occurs:

- replay report has `ok=false`
- repeated `"status":"error"` in canary runs
- repeated `"topupStatus":"error"` or unexpected `"fundingSource":"escrow-fallback"`
- watcher executes `SHUTDOWN_COMMAND`

Rollback actions:

1. Stop the live agent process (or run your service stop command).
2. Set `COMPUTE_BILLING_MODE=escrow` and `DRY_RUN=true` in `apps/agent/.env`.
3. If autopilot service is active, set `AUTOPILOT_EMERGENCY_STOP=true` in `apps/watcher/.env`.
4. Restart in safe mode and verify:

```bash
pnpm agent:dry-run
pnpm watcher:start
```

5. Preserve artifacts:
   - `apps/agent/data/runs-conway-canary.ndjson`
   - `autonomy/reports/replay.json`
   - `autonomy/reports/verification.json`

## 5) Success Criteria

- [ ] `>=25` live canary runs completed.
- [ ] Latest `autonomy/reports/replay.json` has `ok=true`.
- [ ] No unresolved canary `status=error` runs.
- [ ] No watcher-triggered shutdown.
- [ ] Human sign-off recorded (if enforced): `autonomy/approval.json`.
