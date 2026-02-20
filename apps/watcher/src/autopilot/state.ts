import { readFile } from "node:fs/promises";
import { nowIso, repoPath, writeJson } from "./common";
import type { AutopilotState, DeploymentStage } from "./types";

const DEFAULT_STATE_PATH = repoPath("apps/watcher/data/autopilot-state.json");

export function resolveStatePath(): string {
  return process.env.AUTOPILOT_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
}

export async function readAutopilotState(path = resolveStatePath()): Promise<AutopilotState | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as AutopilotState;
  } catch {
    return null;
  }
}

export async function writeAutopilotState(
  patch: Partial<AutopilotState>,
  options?: {
    path?: string;
    phase?: number;
    stage?: DeploymentStage;
    emergencyStop?: boolean;
    requireHumanApproval?: boolean;
    requiresTimelock?: boolean;
  }
): Promise<AutopilotState> {
  const path = options?.path ?? resolveStatePath();
  const current = (await readAutopilotState(path)) ?? {
    timestamp: nowIso(),
    phase: options?.phase ?? 1,
    stage: options?.stage ?? "shadow_canary",
    emergencyStop: options?.emergencyStop ?? false,
    requireHumanApproval: options?.requireHumanApproval ?? true,
    requiresTimelock: options?.requiresTimelock ?? false
  };

  const next: AutopilotState = {
    ...current,
    ...patch,
    timestamp: nowIso()
  };

  await writeJson(path, next);
  return next;
}
