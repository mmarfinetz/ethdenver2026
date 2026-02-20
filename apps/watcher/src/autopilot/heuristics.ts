import { readFile } from "node:fs/promises";
import { repoPath } from "./common";
import type { ParameterProposal, RunAggregate } from "./types";

const TUNEABLE_KEYS = [
  "HF_BUFFER",
  "RUN_INTERVAL_SECONDS",
  "COMPUTE_BUFFER_BPS",
  "RUNWAY_ELEVATED_DAYS",
  "MAX_LOOPS",
  "LOOP_BORROW_BPS"
] as const;

type TunableKey = (typeof TUNEABLE_KEYS)[number];

type KnobMap = Record<TunableKey, string>;

const DEFAULT_AGENT_ENV_EXAMPLE_PATH = repoPath("apps/agent/.env.example");

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asNumber(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readKnobs(path: string): Promise<KnobMap> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  const result: Partial<KnobMap> = {};

  for (const key of TUNEABLE_KEYS) {
    const line = lines.find((entry) => entry.startsWith(`${key}=`));
    result[key] = line ? line.slice(key.length + 1).trim() : "";
  }

  return result as KnobMap;
}

export async function proposeParameterChanges(
  metrics: RunAggregate,
  path = process.env.AUTOPILOT_AGENT_ENV_EXAMPLE_PATH?.trim() || DEFAULT_AGENT_ENV_EXAMPLE_PATH
): Promise<ParameterProposal[]> {
  const current = await readKnobs(path);
  const proposals: ParameterProposal[] = [];

  const currentHfBuffer = asNumber(current.HF_BUFFER);
  const currentInterval = Math.round(asNumber(current.RUN_INTERVAL_SECONDS));
  const currentComputeBuffer = Math.round(asNumber(current.COMPUTE_BUFFER_BPS));
  const currentRunwayElevated = Math.round(asNumber(current.RUNWAY_ELEVATED_DAYS));
  const currentMaxLoops = Math.round(asNumber(current.MAX_LOOPS));
  const currentLoopBorrowBps = Math.round(asNumber(current.LOOP_BORROW_BPS));

  if (metrics.errorRate > 0.2) {
    const proposed = clamp(Number((currentHfBuffer * 1.15).toFixed(2)), 0.05, 0.5).toFixed(2);
    if (proposed !== current.HF_BUFFER) {
      proposals.push({
        key: "HF_BUFFER",
        current: current.HF_BUFFER,
        proposed,
        reason: `Error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeded 20%; increasing HF buffer for safety`
      });
    }
  }

  if (metrics.runwayDeadCount > 0) {
    const proposedComputeBuffer = String(clamp(Math.round(currentComputeBuffer * 1.2), 500, 5000));
    if (proposedComputeBuffer !== current.COMPUTE_BUFFER_BPS) {
      proposals.push({
        key: "COMPUTE_BUFFER_BPS",
        current: current.COMPUTE_BUFFER_BPS,
        proposed: proposedComputeBuffer,
        reason: `Detected ${metrics.runwayDeadCount} dead-runway runs; increasing compute cost safety margin`
      });
    }

    const proposedRunwayElevated = String(clamp(currentRunwayElevated + 1, 3, 21));
    if (proposedRunwayElevated !== current.RUNWAY_ELEVATED_DAYS) {
      proposals.push({
        key: "RUNWAY_ELEVATED_DAYS",
        current: current.RUNWAY_ELEVATED_DAYS,
        proposed: proposedRunwayElevated,
        reason: "Dead-runway events observed; widening elevated urgency runway threshold"
      });
    }
  }

  if (metrics.successRate >= 0.9 && metrics.errorRate < 0.05 && metrics.netDeltaUsdSum > 0n) {
    const proposedInterval = String(clamp(Math.round(currentInterval * 0.9), 30, 600));
    if (proposedInterval !== current.RUN_INTERVAL_SECONDS) {
      proposals.push({
        key: "RUN_INTERVAL_SECONDS",
        current: current.RUN_INTERVAL_SECONDS,
        proposed: proposedInterval,
        reason: "High stability with positive economics; tightening scheduler cadence for faster adaptation"
      });
    }
  }

  if (metrics.errorRate > 0.3 && currentMaxLoops > 1) {
    const proposedMaxLoops = String(clamp(currentMaxLoops - 1, 1, 10));
    if (proposedMaxLoops !== current.MAX_LOOPS) {
      proposals.push({
        key: "MAX_LOOPS",
        current: current.MAX_LOOPS,
        proposed: proposedMaxLoops,
        reason: "High error rate suggests reducing compounded loop attempts"
      });
    }

    const proposedBorrow = String(clamp(Math.round(currentLoopBorrowBps * 0.9), 500, 9000));
    if (proposedBorrow !== current.LOOP_BORROW_BPS) {
      proposals.push({
        key: "LOOP_BORROW_BPS",
        current: current.LOOP_BORROW_BPS,
        proposed: proposedBorrow,
        reason: "Reducing loop leverage aggressiveness under sustained failures"
      });
    }
  }

  return proposals;
}
