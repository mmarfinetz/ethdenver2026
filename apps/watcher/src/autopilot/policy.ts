import { readText, repoPath } from "./common";
import type { AutonomyPolicy, RolloutPhase } from "./types";

const DEFAULT_POLICY_PATH = repoPath("autonomy/policy.yaml");

export async function loadPolicy(path = process.env.AUTOPILOT_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH): Promise<AutonomyPolicy> {
  const raw = await readText(path);
  const parsed = parsePolicy(raw, path);
  validatePolicy(parsed, path);
  return parsed;
}

function parsePolicy(raw: string, path: string): AutonomyPolicy {
  try {
    return JSON.parse(raw) as AutonomyPolicy;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse policy at ${path}. This repo expects JSON-compatible YAML (YAML subset). Parse error: ${message}`
    );
  }
}

function validatePolicy(policy: AutonomyPolicy, path: string): void {
  if (policy.version !== 1) {
    throw new Error(`Unsupported policy version in ${path}: ${policy.version}`);
  }
  if (!Array.isArray(policy.allowed.paths) || policy.allowed.paths.length === 0) {
    throw new Error(`Policy ${path} must define allowed.paths`);
  }
  if (!Array.isArray(policy.forbidden.paths) || !Array.isArray(policy.forbidden.symbols)) {
    throw new Error(`Policy ${path} must define forbidden.paths and forbidden.symbols arrays`);
  }
  if (!Array.isArray(policy.rollout.phases) || policy.rollout.phases.length === 0) {
    throw new Error(`Policy ${path} must define rollout.phases`);
  }
  if (policy.limits.max_files_changed <= 0 || policy.limits.max_added_lines <= 0 || policy.limits.max_deleted_lines <= 0) {
    throw new Error(`Policy ${path} diff limits must be positive integers`);
  }
}

export function getCurrentPhase(policy: AutonomyPolicy): RolloutPhase {
  const requestedPhase = Number.parseInt(process.env.AUTOPILOT_PHASE ?? "", 10);
  const phaseNumber = Number.isFinite(requestedPhase) ? requestedPhase : policy.mode.default_phase;
  const phase = policy.rollout.phases.find((item) => item.phase === phaseNumber);
  if (!phase) {
    throw new Error(`AUTOPILOT_PHASE ${phaseNumber} is not defined in policy rollout phases`);
  }
  return phase;
}

export function hasCapability(policy: AutonomyPolicy, capability: string): boolean {
  const phase = getCurrentPhase(policy);
  return phase.capabilities.includes(capability);
}
