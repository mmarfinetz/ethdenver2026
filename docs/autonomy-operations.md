# Autopilot Operations Specification (Implemented)

Date: 2026-02-20  
Scope: `apps/watcher/src/autopilot/*`, `autonomy/policy.yaml`, CI workflows

## 1. Explicit Autonomy Boundaries

Source of truth: `autonomy/policy.yaml`

- Allowed edit scope is explicitly allow-listed (`allowed.paths`).
- Forbidden and protected scope is explicitly deny-listed (`forbidden.paths`, `forbidden.symbols`).
- Protected locations include:
  - `packages/shared/src/constants.ts`
  - `apps/agent/src/config.ts`
  - `apps/agent/src/chain.ts`
  - `apps/agent/src/policy/hfMath.ts`
  - `apps/watcher/src/watcher.ts`
  - `contracts/src/**`

## 2. Dedicated Autopilot Service

Autopilot is isolated from `apps/agent` runtime code:

- Entry point: `apps/watcher/src/autopilot/index.ts`
- Modules:
  - `collector.ts`
  - `heuristics.ts`
  - `patcher.ts`
  - `policyGate.ts`
  - `replay.ts`
  - `verifier.ts`
  - `deploy.ts`
  - `provenance.ts`
  - `controls.ts`
  - `state.ts`
  - `pr.ts`

## 3. Machine-Checkable Policy Gate

Gate implementation:

- `apps/watcher/src/autopilot/policyGate.ts`
- CLI: `pnpm --filter watcher autopilot:policy-gate`

Checks enforced:

- allowed/forbidden path and symbol rules.
- diff-size budgets (`max_files_changed`, added/deleted line limits).
- high-risk/timelock triggers:
  - path-touch rules
  - numeric literal delta threshold rule.

## 4. Verification Requirements

Verification implementation:

- Replay/backtest: `apps/watcher/src/autopilot/replay.ts`
- Full verifier: `apps/watcher/src/autopilot/verifier.ts`

Required command set (policy-driven):

- `pnpm --filter watcher autopilot:replay`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter agent test`
- `pnpm --filter contracts test`

## 5. Staged Deployment + Rollback

Deployment stage evaluator:

- `apps/watcher/src/autopilot/deploy.ts`

Stages:

- `shadow_canary` -> `live_canary` -> `promoted`

Rollback triggers:

- HF floor breaches
- excessive consecutive failures
- increased runway-dead incidents
- canary error-rate regression beyond policy threshold.

## 6. Provenance + Attestation

Provenance implementation:

- `apps/watcher/src/autopilot/provenance.ts`
- CI workflow: `.github/workflows/autopilot-provenance.yml`

Artifacts:

- `autonomy/artifacts/manifest.json`
- `autonomy/artifacts/attestation.json`
- `autonomy/artifacts/manifest.sig` (when signing key is configured)

Verification checks:

- artifact digest integrity
- attestation subject digest match
- expected commit SHA match
- optional signature verification with configured public key.

## 7. Hard Human Overrides

Controls:

- `AUTOPILOT_EMERGENCY_STOP`
- `AUTOPILOT_REQUIRE_HUMAN_APPROVAL`
- `AUTOPILOT_TIMELOCK_HOURS`
- `AUTOPILOT_APPROVAL_FILE`
- Approval record template: `autonomy/approval.example.json`

Enforcement:

- `apps/watcher/src/autopilot/controls.ts`

Emergency stop blocks autopilot execution immediately. Approval/timelock is enforced before high-risk actions.

## 8. Phase 1-4 Rollout + Trust Model

Phase capabilities and exit criteria are codified in `autonomy/policy.yaml` (`rollout.phases`).

Trust model is codified in `autonomy/policy.yaml` (`rollout.trust_model`) and surfaced in dashboard telemetry.

## 9. Remote-Backed Base Sepolia E2E

Use `scripts/e2e/base-sepolia/remote-e2e.sh` for real-remote execute-mode staging:

- `pnpm e2e:sepolia:preflight`
- `pnpm e2e:sepolia:deploy-registry`
- `pnpm e2e:sepolia:run`
- `pnpm e2e:sepolia:sync-champion`

Checklist and env template:

- `docs/base-sepolia-remote-e2e.md`
- `scripts/e2e/base-sepolia/e2e.env.example`
