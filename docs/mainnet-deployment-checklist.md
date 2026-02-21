# Base Mainnet Deployment Checklist

Status: **Pre-deployment**
Target: Base Mainnet (chain ID `8453`)

---

## 1. Smart Contract Review & Verification

- [ ] **Audit `SimpleAccount.sol`** -- the custom ERC-4337 account contract handles user funds directly. Review:
  - `validateUserOp` signature recovery (ecrecover + `v` normalization at line 96-104)
  - `execute` / `executeBatch` access control (`onlyOwnerOrEntryPoint`)
  - `_isValidSignature` does not protect against signature malleability (s-value range check missing)
  - `missingAccountFunds` refund silently ignores failure (line 81-82)
  - No reentrancy guards on `execute` / `executeBatch`
- [ ] **Audit `SimpleAccountFactory.sol`** -- verify CREATE2 address derivation matches `getAddress` prediction
- [ ] **Audit `ChampionRegistry.sol`** -- review access control and state mutation safety
- [ ] **Consider using established audited implementations** (e.g., eth-infinitism `SimpleAccount` or Safe) instead of custom contracts for mainnet real funds
- [ ] **Run Slither / Aderyn / Mythril** static analysis on all contracts
- [ ] **Verify Solidity compiler version** -- currently `0.8.23`, confirm no known compiler bugs affect your code

## 2. Contract Deployment

- [ ] **Decide: deploy your own factory or use the default**
  - Default `SimpleAccountFactory` at `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985` -- verify this contract is legitimate and matches your expected bytecode
  - If deploying your own: `forge script script/DeployAA.s.sol:DeployAA --rpc-url $BASE_RPC_URL --broadcast --verify`
- [ ] **Deploy `ChampionRegistry`** if needed for production
  - `forge script script/DeployChampionRegistry.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify`
- [ ] **Verify all deployed contracts on BaseScan** (`forge verify-contract` or via BaseScan UI)
- [ ] **Confirm EntryPoint v0.7** exists at `0x0000000071727De22E5E9d8BAf0edAc6f37da032` on Base mainnet (it's a canonical deployment, but verify bytecode)

## 3. Onchain Address Verification

Verify every hardcoded/default address in `packages/shared/src/constants.ts` is correct on Base mainnet:

- [ ] USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` -- confirm via BaseScan, check `decimals() == 6`
- [ ] WETH: `0x4200000000000000000000000000000000000006` -- canonical Base WETH
- [ ] wstETH: `0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452` -- confirm this is Lido's canonical wstETH on Base
- [ ] Aave v3 Pool: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` -- verify via Aave docs/governance
- [ ] Uniswap V3 Router: `0x2626664c2603336E57B271c5C0b26F421741e481` -- verify via Uniswap docs
- [ ] EntryPoint v0.7: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- [ ] SimpleAccountFactory: `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985`
- [ ] Confirm Aave v3 on Base has a **wstETH supply market** and a **WETH borrow market** with sufficient liquidity

## 4. Key Management & Security

- [ ] **Generate a fresh `OWNER_PRIVATE_KEY`** -- never reuse testnet keys on mainnet
- [ ] **Store private key securely** -- use a hardware wallet, KMS (AWS/GCP), or secrets manager; never in `.env` on a production server
- [ ] **Verify `.gitignore` excludes**: `.env`, `*.env`, `data/`, private keys, any secrets
- [ ] **Set up key rotation plan** -- document how to `transferOwnership` on the smart account if the key is compromised
- [ ] **Separate deployer key from agent operator key** -- the `DEPLOYER_PRIVATE_KEY` (for contract deployment) should not be the same as `OWNER_PRIVATE_KEY` (for daily agent operation)
- [ ] **Escrow address (`ESCROW_ADDRESS`)** -- set this to a real multisig or secure address you control, not `0x000...000`

## 5. Environment Configuration (`apps/agent/.env`)

- [ ] `CHAIN_ID=8453`
- [ ] `ALLOW_TESTNET=false`
- [ ] `DRY_RUN=false` (only after all other checks pass)
- [ ] `BASE_RPC_URL` -- use a reliable paid RPC (Alchemy, QuickNode, Infura) not the public `https://mainnet.base.org`
- [ ] `BUNDLER_RPC_URL` -- use a paid Pimlico plan or equivalent (the public endpoint has rate limits). Confirm bundler supports EntryPoint v0.7 on Base
- [ ] `PAYMASTER_RPC_URL` -- if using a paymaster for gas sponsorship, configure here; otherwise leave empty and ensure the smart account has ETH for gas
- [ ] `OWNER_PRIVATE_KEY` -- production key (see key management above)
- [ ] `BUILDER_CODE` -- register a real builder code with Base (must start with `bc_`). See [Base Builder Codes](https://docs.base.org/builder-codes/)
- [ ] `ESCROW_ADDRESS` -- real escrow/multisig address
- [ ] `MONTHLY_SERVER_COST_USDC` -- set to actual monthly infra cost
- [ ] `COMPUTE_BUFFER_BPS` -- review buffer percentage (default 20%)
- [ ] `ZEROX_API_KEY` -- get a production 0x API key (the free tier has rate limits)
- [ ] `ZEROX_API_URL` -- confirm `https://base.api.0x.org/swap/allowance-holder/quote` is current

### Policy Knobs -- Review for Mainnet

- [ ] `HF_TARGET=1.60` -- is 1.60 conservative enough for mainnet? Consider 1.80+ initially
- [ ] `HF_BUFFER=0.10` -- combined with target, agent won't loop if HF < 1.70
- [ ] `MAX_LOOPS=5` -- limit consecutive loops to avoid over-leveraging
- [ ] `LOOP_BORROW_BPS=3500` -- borrows 35% of available capacity per loop; review
- [ ] `SLIPPAGE_BPS=100` -- 1% slippage tolerance; may need tuning based on pool depth
- [ ] `RUN_INTERVAL_SECONDS` -- set appropriate cadence (60s is aggressive for mainnet; consider 300-600s)
- [ ] `MAX_HARVEST_EQUITY_BPS=500` -- max 5% of equity harvested per cycle for compute

### Risk Engine

- [ ] `RISK_ENGINE_MODE=aave-wsteth` -- leave enabled
- [ ] `RISK_MONTE_CARLO_PATHS=10000` -- sufficient for production
- [ ] `RISK_MONTE_CARLO_HORIZON_DAYS=30`
- [ ] Review risk thresholds in `riskEngine.ts`: `pLiq7d <= 0.02` and `pLiq30d <= 0.05` -- are these acceptable?

## 6. Funding the Smart Account

- [ ] **Derive the smart account address** -- run `pnpm agent:dry-run` and note the logged `smartAccount=0x...` address
- [ ] **Fund with ETH** -- the smart account needs ETH to pay for gas (unless using a paymaster). Start with a small amount (e.g., 0.01 ETH)
- [ ] **Fund with wstETH** -- transfer initial wstETH collateral to the smart account. This is the seed capital for the looping strategy
- [ ] **Do NOT fund with more than you're willing to lose** -- this is unaudited code
- [ ] **Verify balances** on BaseScan before starting the agent

## 7. RPC & Infrastructure

- [ ] **RPC provider** -- set up a paid Base mainnet RPC with high rate limits and reliability (Alchemy recommended)
- [ ] **Bundler** -- confirm Pimlico (or your bundler) plan covers expected UserOp volume
- [ ] **0x API** -- get a production API key; confirm rate limits are sufficient
- [ ] **Server/VPS** -- provision a reliable server with:
  - Uptime monitoring
  - Auto-restart (systemd, pm2, or Docker with restart policy)
  - Disk space for `runs.ndjson` log growth
  - Secure network (firewall, no exposed ports)
- [ ] **DNS/networking** -- if running the dashboard publicly, set up HTTPS

## 8. Testing Progression

### 8a. Base Sepolia E2E (do this first)

- [ ] Complete full Sepolia E2E flow: `pnpm e2e:sepolia:all`
- [ ] Confirm successful UserOp on Sepolia BaseScan
- [ ] Verify dashboard reads correct data from Sepolia
- [ ] Run the watcher/autopilot verification suite: `pnpm watcher:verify`

### 8b. Mainnet Dry Run

- [ ] Set `DRY_RUN=true` with all mainnet config
- [ ] Run `pnpm agent:dry-run`
- [ ] Confirm startup validation passes (chain ID, bytecode checks, token decimals)
- [ ] Review the planned actions in logs -- are they sane?

### 8c. Mainnet Small Scale Live

- [ ] Set `DRY_RUN=false`
- [ ] Fund smart account with a **small** amount of wstETH (e.g., 0.01 wstETH)
- [ ] Run agent once and verify:
  - [ ] UserOp submitted and mined (check `data/runs.ndjson`)
  - [ ] `userOpHash` and `txHash` are real and visible on BaseScan
  - [ ] Aave position reflects the supply
  - [ ] ERC-8021 builder code suffix present in callData
  - [ ] Gas costs are reasonable
- [ ] Confirm dashboard displays real position data
- [ ] Let it run for several cycles and verify:
  - [ ] HF stays above target
  - [ ] Looping decisions are correct
  - [ ] Deleveraging triggers properly if HF drops
  - [ ] Compute payment flow works

## 9. CI / Build Verification

- [ ] `pnpm install` succeeds
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] `pnpm --filter agent test` passes
- [ ] `pnpm --filter contracts test` passes (via `forge test`)
- [ ] `pnpm --filter watcher test` passes
- [ ] `pnpm --filter watcher autopilot:policy-gate` passes
- [ ] `pnpm --filter watcher autopilot:replay` passes
- [ ] GitHub Actions CI is green on main

## 10. Monitoring & Alerting

- [ ] **Set up log monitoring** -- watch `data/runs.ndjson` for `"status":"error"` entries
- [ ] **Health factor alerts** -- alert if HF drops below 1.3 (well above liquidation)
- [ ] **Process monitoring** -- alert if agent process dies
- [ ] **Escrow balance monitoring** -- alert when runway drops to "elevated" or "critical"
- [ ] **Gas price monitoring** -- alert on Base gas spikes that could make operations unprofitable
- [ ] **Dashboard uptime** -- monitor the Next.js dashboard if deployed publicly
- [ ] **RPC health** -- monitor for RPC errors or latency spikes

## 11. Operational Runbooks

- [ ] **Emergency delever procedure** -- how to manually unwind the position if the agent fails
- [ ] **Key compromise response** -- steps to `transferOwnership` and secure funds
- [ ] **RPC failover** -- backup RPC endpoint configured
- [ ] **Rollback procedure** -- how to stop the agent and revert to manual management
- [ ] **Autopilot emergency stop** -- `AUTOPILOT_EMERGENCY_STOP=true` documented and tested

## 12. Dashboard Configuration (`apps/dashboard/.env.local`)

- [ ] `NEXT_PUBLIC_SMART_ACCOUNT_ADDRESS` set to your mainnet smart account
- [ ] `NEXT_PUBLIC_CHAIN_ID=8453`
- [ ] All token/pool/entrypoint addresses match mainnet
- [ ] `RUN_LOG_PATH` points to the agent's actual log file
- [ ] Dashboard does NOT expose private keys or sensitive config

## 13. Watcher / Autopilot (`apps/watcher/.env`)

- [ ] Configure watcher to monitor the correct mainnet smart account
- [ ] `AUTOPILOT_REQUIRE_HUMAN_APPROVAL=true` for initial deployment (Phase 1)
- [ ] `AUTOPILOT_EMERGENCY_STOP` is `false` but ready to flip
- [ ] Timelock configured per `autonomy/policy.yaml` (`timelock_hours: 24`)

## 14. Legal / Compliance

- [ ] Understand regulatory implications of running an autonomous DeFi agent with real funds
- [ ] Confirm you are compliant with applicable laws in your jurisdiction
- [ ] Consider Terms of Service for any public-facing dashboard

## 15. Go-Live Sequence

1. [ ] All above sections checked off
2. [ ] Deploy/verify contracts (if using custom factory)
3. [ ] Run mainnet dry-run -- confirm clean startup
4. [ ] Fund smart account with small seed capital
5. [ ] Start agent with `DRY_RUN=false`
6. [ ] Monitor first 10 cycles closely in logs
7. [ ] Verify on BaseScan: UserOps, Aave position, token transfers
8. [ ] Start dashboard and confirm real data
9. [ ] Gradually increase capital as confidence builds
10. [ ] Enable watcher monitoring
11. [ ] Document steady-state operations

---

## Known Risks & Limitations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Unaudited smart contracts | **Critical** | Use established audited AA implementations or get a formal audit |
| Signature malleability in `_isValidSignature` | Medium | EntryPoint nonce prevents replay, but add `s` range check |
| Single private key as owner | High | Use multisig or hardware wallet |
| 0x API dependency for swaps | Medium | Have fallback or circuit breaker if API is down |
| Bundler downtime | Medium | Monitor and have backup bundler endpoint |
| Aave governance risk (LT changes) | Medium | Risk engine models this; monitor Aave governance proposals |
| wstETH depeg / slashing event | Medium | Risk engine models this with Monte Carlo; monitor Lido |
| Public RPC rate limits | Low | Use paid RPC provider |
| `runs.ndjson` disk growth | Low | Set up log rotation |

---

*Last updated: 2026-02-21*
