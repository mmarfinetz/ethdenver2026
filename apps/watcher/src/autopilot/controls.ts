import { readFile } from "node:fs/promises";
import { parseBoolean, repoPath } from "./common";
import type { ApprovalRecord, AutonomyPolicy, PolicyGateResult } from "./types";

export type ControlState = {
  emergencyStop: boolean;
  requireHumanApproval: boolean;
  timelockHours: number;
  approvalFile: string;
};

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid positive integer: ${raw}`);
  }
  return parsed;
}

async function readApproval(path: string): Promise<ApprovalRecord | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ApprovalRecord;
  } catch {
    return null;
  }
}

function hasTimelockElapsed(approval: ApprovalRecord, timelockHours: number): boolean {
  const approvedAtMs = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAtMs)) return false;
  const elapsedMs = Date.now() - approvedAtMs;
  return elapsedMs >= timelockHours * 60 * 60 * 1000;
}

function hasNotExpired(approval: ApprovalRecord): boolean {
  if (!approval.expiresAt) return true;
  const expiresAtMs = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return Date.now() <= expiresAtMs;
}

export function loadControls(policy: AutonomyPolicy): ControlState {
  const emergencyStopEnv = policy.override_controls.emergency_stop_env;
  const requireApprovalEnv = policy.override_controls.approval_mode_env;
  const timelockEnv = policy.override_controls.timelock_env;
  const approvalFileEnv = policy.override_controls.approval_file_env;

  const emergencyStop = parseBoolean(process.env[emergencyStopEnv], false);
  const requireHumanApproval = parseBoolean(
    process.env[requireApprovalEnv],
    policy.mode.require_human_approval_default
  );
  const timelockHours = parsePositiveInteger(process.env[timelockEnv], policy.risk.timelock_hours);
  const approvalFile = process.env[approvalFileEnv]?.trim() || repoPath("autonomy/approval.json");

  return {
    emergencyStop,
    requireHumanApproval,
    timelockHours,
    approvalFile
  };
}

export async function assertHumanControls(options: {
  controls: ControlState;
  gate: PolicyGateResult;
  proposalId?: string;
}): Promise<void> {
  const { controls, gate } = options;
  if (controls.emergencyStop) {
    throw new Error("Autopilot blocked by emergency stop");
  }

  const needsApproval = controls.requireHumanApproval || gate.requiresHumanApproval;
  if (!needsApproval && !gate.requiresTimelock) return;

  const approval = await readApproval(controls.approvalFile);
  if (!approval?.approved) {
    throw new Error(`Human approval required; no valid approval record found at ${controls.approvalFile}`);
  }
  if (!hasNotExpired(approval)) {
    throw new Error(`Human approval at ${controls.approvalFile} is expired`);
  }
  if (options.proposalId && approval.proposalId && approval.proposalId !== options.proposalId) {
    throw new Error(
      `Approval proposalId mismatch. expected=${options.proposalId}, got=${approval.proposalId}`
    );
  }
  if (gate.requiresTimelock && !hasTimelockElapsed(approval, controls.timelockHours)) {
    throw new Error(`Timelock not elapsed (${controls.timelockHours}h) for approved high-risk change`);
  }
}
