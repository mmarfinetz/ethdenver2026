# How The Agent Works (Judge Explainer)

This document explains the runtime agent in plain language, with enough technical detail to show what is actually happening onchain.

## One-Sentence Summary

The agent runs an ERC-4337 smart account strategy on Base, measures whether each cycle is economically worth it, executes only HF-safe actions, and continuously funds its own compute runway so it can keep operating.

## What Runs Where

- Offchain brain: `apps/agent/src/agent.ts`
- Onchain settlement: Aave + swap + USDC transfer via the smart account
- Account abstraction execution: `apps/agent/src/aa/*`
- Billing abstraction (escrow or Conway credits): `apps/agent/src/billing/*`
- Public observability: `apps/dashboard/*` + run logs

No custom strategy contract is required in the hot path; the smart account executes batched calls.

## The Runtime Loop (Every Interval)

At each tick, the agent does this:

1. Reads live state:
- balances (ETH/WETH/wstETH/USDC),
- Aave account data (collateral, debt, health factor),
- reserve borrow rate,
- oracle prices,
- current compute-credit balance (escrow or Conway).

2. Updates wstETH rate history and estimates APR drift from onchain samples.

3. Computes economics:
- `netDelta = yield - interest - gas - swap - compute`
- plus break-even equity approximation.

4. Computes runway:
- estimated per-tick compute cost in USDC,
- days of runway from current credit balance,
- urgency bucket: `nominal | elevated | critical | dead`.

5. Chooses exactly one action:
- `delever` if HF is below target,
- `loop` only if profitable + risk-gated + below loop throttle,
- `fund-escrow` / `pay-escrow` (or `topup-credits`) to keep compute funded,
- `none` when no safe/valid action exists.

6. For onchain actions:
- builds batched calls,
- appends ERC-8021 builder attribution suffix,
- submits one UserOperation through bundler/paymaster.

7. Records run telemetry:
- decision, reason, economics, runway, risk,
- `userOpHash` + `txHash` for live executions.

Key code: `apps/agent/src/agent.ts`, `apps/agent/src/storage.ts`.

## How It Pays For Infra (And Stays Alive)

This is the core “self-sustaining” mechanism.

### 1) Per-tick compute cost is estimated automatically

The agent does not use a hardcoded flat fee per run. It computes:

- amortized server cost per tick from `MONTHLY_SERVER_COST_USDC`,
- trailing average of real gas cost from recent runs,
- safety buffer via `COMPUTE_BUFFER_BPS`.

Key code: `apps/agent/src/policy/economics.ts`.

### 2) Runway is translated into urgency states

Runway days are calculated from:

- `creditBalanceUsdc / dailyPerTickCostUsdc`

Then mapped to:

- `nominal` (healthy),
- `elevated`,
- `critical`,
- `dead`.

Default thresholds are controlled by env:
- `RUNWAY_NOMINAL_DAYS` (default 14),
- `RUNWAY_ELEVATED_DAYS` (default 7),
- `RUNWAY_DEAD_DAYS` (default 2).

Key code: `apps/agent/src/policy/runway.ts`.

### 3) Funding behavior adapts by urgency

- `nominal`: can run strategy; also does routine idle-USDC payments.
- `elevated`: prioritizes topping runway back toward nominal before aggressive looping.
- `critical/dead`: switches to emergency funding behavior and can harvest wstETH->USDC (HF-safe) to refill credits.

This means the agent explicitly prioritizes “stay online” when runway is tight.

### 4) Two billing modes

- `escrow` mode:
  - runway balance is escrow USDC balance,
  - topups are onchain `USDC.transfer` to escrow.
  - files: `apps/agent/src/billing/escrowProvider.ts`

- `conway` mode:
  - runway balance comes from Conway credits API,
  - topups can happen through Conway API (x402 flow supported),
  - optional fallback to escrow balance on API failure.
  - files: `apps/agent/src/billing/conwayProvider.ts`

The provider interface is unified, so the decision engine stays the same.

### 5) Optional gas payment in USDC

If Circle Paymaster is enabled, gas can be paid in USDC:

- agent prepends USDC approval call for paymaster,
- paymaster deducts USDC gas cost,
- run record captures `gasPaymentUsdc`.

Key code: `apps/agent/src/aa/paymaster.ts`, `apps/agent/src/agent.ts`.

## How It Stays Safe

### Startup hard checks (fail fast)

Before starting live loop:

- verifies chain ID,
- verifies required contracts have code,
- verifies token decimals match expectations,
- enforces builder code format.

Key code: `apps/agent/src/chain.ts`.

### Health-factor guardrails

- `HF_TARGET` and `HF_BUFFER` define minimum safety envelope.
- Loop/delever/harvest plans are projected before execution.
- If projected HF is unsafe, plan is rejected.

Key code: `apps/agent/src/policy/hfMath.ts`, `apps/agent/src/agent.ts`.

### Risk gate + fallback

- Monte Carlo risk engine estimates liquidation probability (`pLiq7d`, `pLiq30d`).
- Looping only allowed when risk accepted.
- If risk model is unavailable, policy falls back to HF-only guardrails (still safety constrained).

Key code: `apps/agent/src/policy/riskEngine.ts`.

### Runaway behavior damping

- max loops are throttled by urgency (`nominal` full, `elevated` half, `critical/dead` zero),
- scheduler interval stretches as urgency worsens (2x/4x/8x),
- no overlapping runs (scheduler is single-flight).

Key code: `apps/agent/src/policy/runway.ts`, `apps/agent/src/scheduler.ts`.

## Why This Is Verifiable

Each run writes an auditable record with:

- decision + reason,
- risk + economics + runway state,
- funding source and topup status,
- `userOpHash` and `txHash` for live actions,
- runtime provenance metadata (versions/commit/policy/model ids).

These records feed the dashboard and can be cross-checked against EntryPoint/UserOp events and USDC transfer logs.

Key code: `apps/agent/src/storage.ts`, `apps/dashboard/src/lib/queries.ts`.

## 60-Second Judge Script

“Our agent is not just an execution bot; it also manages its own operating runway. Every cycle it reads Aave position + prices + rates, estimates net carry after all costs, and computes how many days of compute credits are left. If safety is degraded it delevers first. If runway is low, it prioritizes funding compute credits/escrow before taking new leverage. It executes through an ERC-4337 smart account, and every live action is logged with userOp hash + tx hash so judges can verify behavior onchain. The key point is: it can preserve capital, pay its own infra, and keep itself online under changing conditions.”
