# Self-Sustaining Onchain Agent on Base (ERC-4337)

Hackathon-ready MVP monorepo for a **self-sustaining onchain agent** using an **ERC-4337 smart account** on Base.

- Brains offchain: policy engine + scheduler + risk hook
- Settlement onchain: Aave + swap + compute USDC payment
- No strategy/treasury custom contracts in runtime
- Every userOp callData includes Base Builder Code attribution suffix (ERC-8021)

## Architecture

### Onchain (through smart account only)
- Aave v3 Pool: `supply`, `borrow`, `repay`, `withdraw`
- 0x-built swap calldata execution (smart account executes settlement tx)
- `USDC.transfer(COMPUTE_RECIPIENT, COMPUTE_COST_USDC)`

### Offchain
- `apps/agent`: policy/economics/risk/scheduler daemon
- `apps/watcher`: escrow watcher + autonomous improvement controller (`autopilot`)
- `apps/dashboard`: public Next.js dashboard + APIs
- `packages/shared`: ABIs, constants, types, utils

## Repo Tree

```text
/
  package.json
  pnpm-workspace.yaml
  .env.example
  README.md
  apps/
    agent/
      .env.example
      src/
        config.ts
        chain.ts
        aa/
          smartAccount.ts
          bundler.ts
          paymaster.ts
        builderCodes.ts
        aave.ts
        dex.ts
        policy/
          hfMath.ts
          economics.ts
          riskEngine.ts
        scheduler.ts
        storage.ts
        metrics.ts
        agent.ts
    dashboard/
      .env.example
      src/
        app/
          layout.tsx
          globals.css
          page.tsx
          api/
            state/route.ts
            runs/route.ts
        lib/
          viem.ts
          queries.ts
          format.ts
    watcher/
      .env.example
      src/
        watcher.ts
        autopilot/
          index.ts
          policyGate.ts
          replay.ts
          verifier.ts
          deploy.ts
          provenance.ts
  packages/
    shared/
      src/
        abis/
          aavePool.ts
          aaveOracle.ts
          aaveAddressProvider.ts
          erc20.ts
          entryPoint.ts
          simpleAccount.ts
          uniswapV3Router.ts
          wstEth.ts
          index.ts
        constants.ts
        types.ts
        utils.ts
        index.ts
  contracts/
    src/
      SimpleAccount.sol
      SimpleAccountFactory.sol
    script/
      DeployAA.s.sol
```

## Quick Start

### 1) Install

```bash
pnpm install
```

### 2) Configure agent

```bash
cp apps/agent/.env.example apps/agent/.env
```

Required critical fields in `apps/agent/.env`:
- `BASE_RPC_URL`
- `BUNDLER_RPC_URL`
- `ENTRYPOINT_ADDRESS`
- `FACTORY_ADDRESS` (pre-filled with Base v0.7 SimpleAccountFactory default)
- `OWNER_PRIVATE_KEY`
- `BUILDER_CODE`
- `COMPUTE_RECIPIENT`
- `COMPUTE_COST_USDC`
- `WSTETH_ADDRESS`, `WETH_ADDRESS`, `USDC_ADDRESS`
- `AAVE_POOL_ADDRESS`

Base mainnet addresses already wired in defaults/env templates:
- EntryPoint v0.7: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- SimpleAccountFactory v0.7: `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985`
- Aave v3 Pool: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
- wstETH: `0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452`
- WETH: `0x4200000000000000000000000000000000000006`
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Uniswap router: `0x2626664c2603336E57B271c5C0b26F421741e481`

Base Sepolia note: Aave test markets do not currently expose a native wstETH reserve; the provided Sepolia env uses WETH as a stand-in.

### Base Sepolia Demo Profile

Use separate local env files so you do not overwrite mainnet `.env` values:

```bash
cp apps/agent/.env.sepolia.example apps/agent/.env.sepolia.local
cp apps/watcher/.env.sepolia.example apps/watcher/.env.sepolia.local
```

Then run Sepolia-specific commands:

```bash
pnpm agent:dry-run:sepolia
pnpm watcher:start:sepolia
pnpm agent:start:sepolia
```

### 3) Configure watcher

```bash
cp apps/watcher/.env.example apps/watcher/.env
```

Required critical fields in `apps/watcher/.env`:
- `BASE_RPC_URL`
- `ESCROW_ADDRESS`
- `SHUTDOWN_COMMAND` (or your local equivalent)

Conway billing mode setup in watcher:
- set `COMPUTE_BILLING_MODE=conway`
- set `CONWAY_API_BASE_URL`
- set `CONWAY_PAYER_ADDRESS`
- set `CONWAY_MIN_CREDITS_BALANCE_USDC` and `CONWAY_MIN_PAYER_BALANCE_USDC`
- optional: `CONWAY_API_KEY`, `CONWAY_CREDITS_BALANCE_PATH`, `CONWAY_FALLBACK_TO_ESCROW_ON_ERROR`, `WATCH_LOW_CREDITS_GRACE_CHECKS`, `WATCH_LOW_PAYER_GRACE_CHECKS`

### 4) Configure dashboard

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local
```

Set:
- `NEXT_PUBLIC_SMART_ACCOUNT_ADDRESS` (the derived/deployed smart account)
- chain/token/pool/entrypoint values
- `RUN_LOG_PATH` (default expects local agent run logs)

### 5) Run agent

Dry run:

```bash
pnpm agent:dry-run
```

Live mode:

```bash
pnpm agent:start
```

### 6) Run dashboard

```bash
pnpm dashboard:dev
```

### 7) Run continuously on VPS (mainnet)

Use the production runbook:

- `docs/vps-mainnet-continuous-ops.md`

Key commands:

```bash
bash scripts/vps/preflight-mainnet.sh
sudo RUN_USER="$USER" REPO_DIR=/opt/ethdenver2026 SERVICE_PREFIX=ssa bash scripts/vps/install-systemd-services.sh
bash scripts/vps/check-billing-health.sh
```

## What the Agent Does Each Interval

1. Reads onchain state (balances, Aave position, reserve rates, oracle prices, wstETH rate)
2. Updates wstETH exchange-rate sample store for APR drift estimation
3. Computes:
   - HF guardrails
   - `Net_Δt = Yield_Δt - Interest_Δt - GasCost_Δt - SwapCost_Δt - ComputeCost_Δt`
   - break-even equity approximation
4. Risk engine hook:
   - returns unavailable by default (no fake values)
   - policy falls back to HF-only gating
5. Chooses action:
   - `delever` if HF below target
   - `loop` if net positive + risk ok + capacity + under max loop guard
   - `harvest-and-pay` if compute USDC needed
   - `pay-compute` when USDC balance is sufficient
6. Builds batched calls, appends ERC-8021 suffix to smart-account callData, signs and submits userOp
7. Waits for receipt and writes run record with real `userOpHash` + `txHash`

## Builder Code Suffix Verification

### In code
- `apps/agent/src/builderCodes.ts`
  - `buildDataSuffix(builderCode)` via `ox/erc8021 Attribution.toDataSuffix`
  - `applySuffix(callData, suffix)`
- `apps/agent/src/agent.ts`
  - suffix appended to **smart account execute/executeBatch callData** before signing userOp

### Onchain
1. Open tx on BaseScan
2. Inspect userOp call/input data
3. Confirm callData ends with ERC-8021 suffix bytes

## Dashboard Guarantees

- No mock TVL/PNL/txs
- If no runs: shows `No runs yet`
- If no compute payments: shows `No compute payments yet`
- Compute payments are derived from **onchain USDC Transfer logs** from smart account to compute recipient
- Recent userOps are sourced from run logs and EntryPoint `UserOperationEvent` logs

## Demo Script

1. Fund owner EOA with ETH on Base
2. Ensure `FACTORY_ADDRESS` and `ENTRYPOINT_ADDRESS` are valid for your bundler
3. Start agent in dry-run and confirm validation passes
4. Fund smart account with wstETH/ETH
5. Run live agent once (`RUN_INTERVAL_SECONDS` low, e.g. `30`)
6. Confirm:
   - a real `userOpHash` and `txHash` in `apps/agent/data/runs.ndjson` (or your configured path)
   - Aave collateral/debt/HF updated on dashboard
7. Trigger compute payment flow (`COMPUTE_COST_USDC` small), then verify USDC transfer shown in dashboard

## Optional: Deploy Local AA Factory

If you need your own factory:

```bash
cd contracts
forge script script/DeployAA.s.sol:DeployAA --rpc-url $BASE_RPC_URL --broadcast
```

Set deployed factory into `FACTORY_ADDRESS`.

## Runtime Data Policy

- No seeded runtime metrics
- No fabricated dashboard points
- No demo-mode data injection

## Autopilot Governance + Safety

Autopilot is implemented as a separate service under `apps/watcher/src/autopilot/*` and constrained by machine-checkable policy in `autonomy/policy.yaml`.

- Start autopilot controller:
  - `pnpm watcher:autopilot`
- Run policy gate:
  - `pnpm watcher:policy-gate`
- Run full verification bundle:
  - `pnpm watcher:verify`

See `docs/autonomy-operations.md` for boundaries, verification, staged deployment, provenance, and phase rollout controls.
For first mainnet Conway launch operations, use `docs/mainnet-conway-supervised-canary.md`.

## Base Sepolia Remote E2E

Run the execute-mode autopilot flow against a real git remote + Base Sepolia staging:

```bash
cp scripts/e2e/base-sepolia/e2e.env.example scripts/e2e/base-sepolia/e2e.env
pnpm e2e:sepolia:preflight
pnpm e2e:sepolia:all
```

Detailed checklist: `docs/base-sepolia-remote-e2e.md`.
