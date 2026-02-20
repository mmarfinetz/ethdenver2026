# Autonomous Improvement Architecture Plan

Date: 2026-02-20  
Repo: `self-sustaining-onchain-agent-base`

## 1. Goals

- Enable safe, incremental self-improvement of strategy behavior.
- Keep protocol and safety invariants immutable unless explicitly human-approved.
- Ensure every change is verifiable, reversible, and attributable.

## 2. Non-Negotiable Autonomy Boundaries

Allowed for autonomous edits:
- Strategy parameters in policy modules.
- Scheduling and pacing heuristics.
- Non-critical refactors and observability improvements.

Forbidden for autonomous edits:
- Chain IDs and default network constants.
- Token/contract addresses and token decimal checks.
- Health factor safety floors and kill-switch semantics.
- Any behavior that weakens chain validation, bytecode checks, or risk gates.

Current protected code locations in this repo:
- `packages/shared/src/constants.ts`
- `apps/agent/src/config.ts`
- `apps/agent/src/chain.ts`
- `apps/agent/src/policy/hfMath.ts`
- `apps/watcher/src/watcher.ts`

## 3. Target Architecture

### 3.1 Services

- Trading runtime: `apps/agent` (unchanged responsibility).
- Autopilot controller: new module under `apps/watcher/src/autopilot/*`.
- Dashboard visibility: extend `apps/dashboard` API/state views for autopilot status.

### 3.2 Autopilot Responsibilities

- Consume run logs (`RUN_LOG_PATH`) and chain state metrics.
- Detect degradations: PnL trend, runway trend, failure/revert rates, HF proximity.
- Generate patch proposals and open PRs on a dedicated branch namespace.
- Never push directly to `main`/`master`.

### 3.3 Suggested Module Layout

- `apps/watcher/src/autopilot/collector.ts`: ingest runs + metrics.
- `apps/watcher/src/autopilot/heuristics.ts`: generate candidate parameter changes.
- `apps/watcher/src/autopilot/patcher.ts`: apply code/config patch templates.
- `apps/watcher/src/autopilot/policyGate.ts`: machine-checkable diff gate.
- `apps/watcher/src/autopilot/verifier.ts`: run replay/tests/build checks.
- `apps/watcher/src/autopilot/pr.ts`: branch + commit + PR creation.
- `apps/watcher/src/autopilot/deploy.ts`: staged deploy and rollback orchestration.
- `apps/watcher/src/autopilot/provenance.ts`: artifact attestation verification.

## 4. Machine-Checkable Policy Gate

Add `autonomy/policy.yaml` and enforce it in CI + autopilot local gate.

Example policy schema:

```yaml
version: 1
mode:
  require_human_approval_default: true
allowed:
  paths:
    - "apps/agent/src/policy/**"
    - "apps/agent/src/scheduler.ts"
    - "apps/agent/src/metrics.ts"
    - "apps/watcher/src/autopilot/**"
forbidden:
  paths:
    - "packages/shared/src/constants.ts"
    - "apps/agent/src/chain.ts"
  symbols:
    - "packages/shared/src/constants.ts:BASE_MAINNET_CHAIN_ID"
    - "packages/shared/src/constants.ts:BASE_SEPOLIA_CHAIN_ID"
    - "packages/shared/src/constants.ts:CHAIN_DEFAULTS"
    - "packages/shared/src/constants.ts:USDC_DECIMALS"
    - "apps/agent/src/config.ts:HF_TARGET"
    - "apps/agent/src/config.ts:HF_BUFFER"
    - "apps/watcher/src/watcher.ts:triggerShutdown"
limits:
  max_files_changed: 12
  max_added_lines: 400
  max_deleted_lines: 250
risk:
  timelock_required_if:
    - "touches:apps/agent/src/policy/**"
    - "changes_numeric_literal_over_pct:20"
```

Gate behavior:
- Hard-fail on forbidden paths/symbols.
- Hard-fail when diff budgets are exceeded.
- Require explicit human approval for high-risk diffs.

## 5. Verification Pipeline (Required Before Merge/Deploy)

Every autopilot PR must pass:
- Historical replay/backtest against stored runs.
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter agent test`
- `pnpm --filter contracts test`
- Lint stage after lint scripts are added to packages.

Replay/backtest requirements:
- Baseline window and candidate window run on identical historical inputs.
- Candidate must not increase HF breach count or failure count.
- Candidate must not worsen runway-collapse incidents.
- Candidate should improve or preserve net delta and successful operation rate.

## 6. Staged Deployment and Auto-Rollback

Deployment stages:
- Shadow canary: candidate runs in dry-run only for `N` cycles (suggest `N=50`).
- Live canary: single canary instance executes limited live actions.
- Full promotion: only after canary success criteria.

Promotion gates:
- No safety violations.
- No increase in revert/error rate.
- HF min and runway thresholds remain within guardrails.
- Net economics non-degrading vs baseline.

Automatic rollback triggers:
- Any HF floor breach.
- Consecutive failed operations above threshold.
- Runway urgency reaching `dead` unexpectedly.
- Canary SLO regression beyond configured tolerance.

## 7. Provenance and Attestation

CI must produce a deployable artifact bundle for `apps/agent` and `apps/watcher`:
- Include commit SHA, `pnpm-lock.yaml` hash, build timestamp.
- Sign artifact (Sigstore/Cosign keyless recommended).
- Emit provenance attestation (SLSA-style).

Deploy controller must verify before rollout:
- Signature validity.
- Attestation subject equals artifact digest.
- Commit SHA matches approved PR merge commit.

Persist provenance with runtime decisions:
- Extend run records with `agentVersion`, `autopilotVersion`, `modelId`, `policyVersion`, `commitSha`.
- Store in `runs.ndjson` and expose in dashboard API.

## 8. Human Override Model

Controls:
- Emergency stop flag (`AUTOPILOT_EMERGENCY_STOP=true`).
- Approval-required mode (`AUTOPILOT_REQUIRE_HUMAN_APPROVAL=true`).
- Timelock for high-risk self-upgrades (for example 24h).

Operational behavior:
- Emergency stop blocks new autopilot proposals/deploys immediately.
- Existing watcher shutdown path remains authoritative for runtime safety.
- High-risk scope cannot auto-merge or auto-deploy, even if tests pass.

## 9. Phase Rollout Plan

### Phase 1: PR Suggestions Only

- Autopilot creates branches/PRs with policy-allowed low-risk edits.
- No auto-merge, no auto-deploy.
- Human approval required for every PR.

Exit criteria:
- 30+ PRs with zero forbidden-diff incidents.
- No safety regressions from accepted PRs.

### Phase 2: Auto-Merge Low-Risk PRs

- Enable auto-merge for policy-marked low-risk changes only.
- Keep deploy human-triggered.

Exit criteria:
- 30 days stable operation with zero rollback-triggering regressions.

### Phase 3: Autonomous Canary Deploy (Low-Risk Scope)

- Autopilot may deploy low-risk merged changes to canary.
- Full rollout remains conditional on canary + policy checks.

Exit criteria:
- 60 days stable canary promotions with successful auto-rollback drills.

### Phase 4: Expanded Autonomy (Still Guarded)

- Expand allowed change scope gradually based on measured reliability.
- Continue immutable forbidden set unless explicit governance change.

## 10. Repo-Level Implementation Plan

1. Add policy and gate:
- `autonomy/policy.yaml`
- `apps/watcher/src/autopilot/policyGate.ts`
- CI job `policy-gate` in `.github/workflows/ci.yml`

2. Add autopilot controller (PR-only first):
- `apps/watcher/src/autopilot/*`
- New script: `pnpm --filter watcher autopilot:start`

3. Add replay/backtest harness:
- `apps/watcher/src/autopilot/replay.ts`
- New script: `pnpm --filter watcher autopilot:replay`

4. Add provenance checks:
- CI artifact signing and attestation workflow.
- Deploy verifier in `apps/watcher/src/autopilot/provenance.ts`

5. Add dashboard visibility:
- Include autopilot state/provenance in `apps/dashboard/src/lib/queries.ts`
- Add UI indicators in `apps/dashboard/src/app/page.tsx`

## 11. Trust Model Summary

- Autopilot is untrusted for direct production mutation.
- CI policy gate and branch protection are trusted enforcement layers.
- Deployment system trusts only signed, attested CI artifacts.
- Human operators retain hard override authority at all phases.
