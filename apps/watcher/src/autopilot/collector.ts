import { valueToBigInt } from "@ssa/shared/utils";
import { readFile } from "node:fs/promises";
import { repoPath } from "./common";
import type { RunAggregate } from "./types";

const DEFAULT_RUN_LOG_PATH = repoPath("apps/agent/data/runs.ndjson");

type ParsedRun = {
  timestamp: string;
  status: "ok" | "error" | "skipped";
  mode: "dry-run" | "live";
  healthFactor: bigint;
  runwayUrgency: string | null;
  netDeltaUsd: bigint;
};

function parseRunLine(line: string): ParsedRun | undefined {
  const payload = JSON.parse(line) as Record<string, unknown>;
  const position = (payload.position as Record<string, unknown>) ?? {};
  const runway = (payload.runway as Record<string, unknown>) ?? {};
  const economics = (payload.economics as Record<string, unknown>) ?? {};

  if (typeof payload.timestamp !== "string") return undefined;
  const rawStatus = payload.status;
  const status: ParsedRun["status"] = rawStatus === "ok" || rawStatus === "skipped" ? rawStatus : "error";

  return {
    timestamp: payload.timestamp,
    status,
    mode: payload.mode === "live" ? "live" : "dry-run",
    healthFactor: valueToBigInt(position.healthFactor),
    runwayUrgency: typeof runway.urgency === "string" ? runway.urgency : null,
    netDeltaUsd: valueToBigInt(economics.netDeltaUsd)
  };
}

function toAggregate(runs: ParsedRun[], hfFloorWad: bigint): RunAggregate {
  let okRuns = 0;
  let errorRuns = 0;
  let skippedRuns = 0;
  let dryRunCount = 0;
  let liveRunCount = 0;
  let runwayDeadCount = 0;
  let hfBreachCount = 0;
  let netDeltaUsdSum = 0n;
  let consecutiveFailures = 0;
  let trailingFailures = 0;
  let minHealthFactorWad: bigint | null = null;

  for (const run of runs) {
    if (run.mode === "live") liveRunCount += 1;
    else dryRunCount += 1;

    if (run.status === "ok") okRuns += 1;
    else if (run.status === "error") errorRuns += 1;
    else skippedRuns += 1;

    if (run.status === "error") {
      trailingFailures += 1;
    } else {
      trailingFailures = 0;
    }
    if (trailingFailures > consecutiveFailures) consecutiveFailures = trailingFailures;

    if (run.runwayUrgency === "dead") runwayDeadCount += 1;
    if (run.healthFactor > 0n && (minHealthFactorWad == null || run.healthFactor < minHealthFactorWad)) {
      minHealthFactorWad = run.healthFactor;
    }
    if (run.healthFactor > 0n && run.healthFactor < hfFloorWad) hfBreachCount += 1;
    netDeltaUsdSum += run.netDeltaUsd;
  }

  const totalRuns = runs.length;
  const successRate = totalRuns === 0 ? 0 : okRuns / totalRuns;
  const errorRate = totalRuns === 0 ? 0 : errorRuns / totalRuns;

  return {
    totalRuns,
    okRuns,
    errorRuns,
    skippedRuns,
    dryRunCount,
    liveRunCount,
    successRate,
    errorRate,
    minHealthFactorWad,
    hfBreachCount,
    runwayDeadCount,
    netDeltaUsdSum,
    consecutiveFailures,
    latestTimestamp: totalRuns === 0 ? null : runs[totalRuns - 1].timestamp
  };
}

export async function collectRunMetrics(options?: {
  runLogPath?: string;
  hfFloorWad?: bigint;
  limit?: number;
}): Promise<RunAggregate> {
  const runLogPath = options?.runLogPath ?? process.env.RUN_LOG_PATH?.trim() ?? DEFAULT_RUN_LOG_PATH;
  const hfFloorWad = options?.hfFloorWad ?? BigInt(process.env.AUTOPILOT_HF_FLOOR_WAD?.trim() || "1100000000000000000");
  const limit = options?.limit ?? 500;

  try {
    const raw = await readFile(runLogPath, "utf8");
    const runs = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map(parseRunLine)
      .filter((run): run is ParsedRun => Boolean(run));

    return toAggregate(runs, hfFloorWad);
  } catch {
    return toAggregate([], hfFloorWad);
  }
}
