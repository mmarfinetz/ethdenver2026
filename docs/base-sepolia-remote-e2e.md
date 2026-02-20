# Base Sepolia Remote-Backed E2E Runbook

This runbook validates the full execute-mode autopilot path in a real git remote context:

1. proposal generation
2. policy/replay/verification/provenance checks
3. branch + commit + push + PR creation
4. champion scaffold output
5. optional onchain ChampionRegistry sync on Base Sepolia

## 1. Prerequisites

- Real git repo with `.git` metadata and writable remote (for example `origin`).
- GitHub token with repo PR permissions.
- Base Sepolia RPC URL (`84532`) and funded deployer key.
- Foundry (`forge`, `cast`) and workspace dependencies installed.
- `apps/agent/.env` and `apps/watcher/.env` configured for Sepolia (`CHAIN_ID=84532`).

## 2. Configure E2E Env

1. Copy the template:

```bash
cp scripts/e2e/base-sepolia/e2e.env.example scripts/e2e/base-sepolia/e2e.env
```

2. Fill required values in `scripts/e2e/base-sepolia/e2e.env`:
- `AUTOPILOT_GITHUB_REPOSITORY`
- `AUTOPILOT_GITHUB_TOKEN`
- `BASE_SEPOLIA_RPC_URL`
- `DEPLOYER_PRIVATE_KEY`
- `CHAMPION_LINEAGE_ARCHIVE_ROOT`
- `CHAMPION_PROVENANCE_ARCHIVE_ROOT`
- `E2E_SIGNING_PRIVATE_KEY_FILE`
- `E2E_SIGNING_PUBLIC_KEY_FILE`

3. If you need staging signing keys:

```bash
openssl genpkey -algorithm ed25519 -out /tmp/e2e-ed25519-private.pem
openssl pkey -in /tmp/e2e-ed25519-private.pem -pubout -out /tmp/e2e-ed25519-public.pem
```

## 3. Execute Checklist

1. Preflight:

```bash
pnpm e2e:sepolia:preflight
```

2. Deploy `ChampionRegistry` on Base Sepolia:

```bash
pnpm e2e:sepolia:deploy-registry
```

3. Run remote-backed autopilot E2E (execute mode):

```bash
pnpm e2e:sepolia:run
```

4. Sync latest champion lineage entry onchain:

```bash
pnpm e2e:sepolia:sync-champion
```

5. Or run all steps end-to-end:

```bash
pnpm e2e:sepolia:all
```

## 4. Outputs to Check

- Registry deploy output:
  - `autonomy/reports/e2e/base-sepolia/champion-registry.env`
  - `autonomy/reports/e2e/base-sepolia/champion-registry.json`
- Autopilot reports:
  - `autonomy/reports/e2e/base-sepolia/replay.json`
  - `autonomy/reports/e2e/base-sepolia/verification.json`
  - `autonomy/reports/e2e/base-sepolia/deploy-decision.json`
  - `autonomy/reports/e2e/base-sepolia/pr-draft.json`
- Champion scaffold state:
  - `apps/watcher/data/champions/state.json`

Quick checks:

```bash
cat autonomy/reports/e2e/base-sepolia/pr-draft.json
cast call "$AUTOPILOT_CHAMPION_REGISTRY_ADDRESS" "championCount()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$AUTOPILOT_CHAMPION_REGISTRY_ADDRESS" "currentChampionId()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## 5. Expected Done State

- PR draft JSON status is `opened` or `existing`.
- Replay/verification/provenance checks pass.
- Deploy controller report produced.
- Champion scaffold state updated.
- Onchain registry has incremented `championCount` after sync.
