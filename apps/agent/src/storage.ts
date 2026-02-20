import { jsonReplacer, valueToBigInt } from "@ssa/shared/utils";
import type { AgentRunRecord, ComputeUrgency, StorageState, WstEthRateSample } from "@ssa/shared/types";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DECISIONS: AgentRunRecord["decision"][] = ["none", "loop", "delever", "fund-escrow", "pay-escrow"];
const URGENCIES: ComputeUrgency[] = ["nominal", "elevated", "critical", "dead"];

function parseDecision(value: unknown): AgentRunRecord["decision"] {
  if (typeof value !== "string") return "none";
  return DECISIONS.includes(value as AgentRunRecord["decision"])
    ? (value as AgentRunRecord["decision"])
    : "none";
}

function parseUrgency(value: unknown): ComputeUrgency {
  if (typeof value !== "string") return "dead";
  return URGENCIES.includes(value as ComputeUrgency) ? (value as ComputeUrgency) : "dead";
}

function serializeRun(record: AgentRunRecord): string {
  return JSON.stringify(record, jsonReplacer);
}

function parseRun(line: string): AgentRunRecord {
  const payload = JSON.parse(line) as Record<string, unknown>;
  const position = payload.position as Record<string, unknown>;
  const balances = payload.balances as Record<string, unknown>;
  const rates = payload.rates as Record<string, unknown>;
  const economics = payload.economics as Record<string, unknown>;
  const risk = payload.risk as Record<string, unknown>;
  const runway = payload.runway as Record<string, unknown> | undefined;
  const userOpPayload = payload.userOp as Record<string, unknown> | undefined;
  const provenance = payload.provenance as Record<string, unknown> | undefined;

  return {
    timestamp: String(payload.timestamp),
    mode: payload.mode === "live" ? "live" : "dry-run",
    chainId: Number(payload.chainId),
    account: String(payload.account) as `0x${string}`,
    decision: parseDecision(payload.decision),
    dryRun: Boolean(payload.dryRun),
    position: {
      totalCollateralBase: valueToBigInt(position.totalCollateralBase),
      totalDebtBase: valueToBigInt(position.totalDebtBase),
      availableBorrowsBase: valueToBigInt(position.availableBorrowsBase),
      currentLiquidationThresholdBps: valueToBigInt(position.currentLiquidationThresholdBps),
      currentLtvBps: valueToBigInt(position.currentLtvBps),
      healthFactor: valueToBigInt(position.healthFactor)
    },
    balances: {
      eth: valueToBigInt(balances.eth),
      weth: valueToBigInt(balances.weth),
      wstEth: valueToBigInt(balances.wstEth),
      usdc: valueToBigInt(balances.usdc)
    },
    rates: {
      wethVariableBorrowRateRay: valueToBigInt(rates.wethVariableBorrowRateRay),
      wstEthPerToken: valueToBigInt(rates.wstEthPerToken),
      wstEthAprWad: rates.wstEthAprWad == null ? null : valueToBigInt(rates.wstEthAprWad)
    },
    economics: {
      intervalSeconds: valueToBigInt(economics.intervalSeconds),
      yieldDeltaUsd: valueToBigInt(economics.yieldDeltaUsd),
      interestDeltaUsd: valueToBigInt(economics.interestDeltaUsd),
      gasCostUsd: valueToBigInt(economics.gasCostUsd),
      swapCostUsd: valueToBigInt(economics.swapCostUsd),
      computeCostUsd: valueToBigInt(economics.computeCostUsd),
      netDeltaUsd: valueToBigInt(economics.netDeltaUsd),
      breakEvenEquityUsdApprox:
        economics.breakEvenEquityUsdApprox == null ? null : valueToBigInt(economics.breakEvenEquityUsdApprox),
      leverageWad: valueToBigInt(economics.leverageWad),
      notes: Array.isArray(economics.notes) ? economics.notes.map(String) : []
    },
    runway: runway
      ? {
          escrowBalanceUsdc: valueToBigInt(runway.escrowBalanceUsdc),
          perTickCostUsdc: valueToBigInt(runway.perTickCostUsdc),
          runwayDaysWad: valueToBigInt(runway.runwayDaysWad),
          urgency: parseUrgency(runway.urgency),
          baseIntervalSeconds: valueToBigInt(runway.baseIntervalSeconds),
          ticksPerDayWad: valueToBigInt(runway.ticksPerDayWad),
          nominalDays: valueToBigInt(runway.nominalDays),
          elevatedDays: valueToBigInt(runway.elevatedDays),
          deadDays: valueToBigInt(runway.deadDays)
        }
      : undefined,
    risk: {
      status: risk.status === "available" ? "available" : "unavailable",
      pLiq7d: typeof risk.pLiq7d === "number" ? risk.pLiq7d : undefined,
      pLiq30d: typeof risk.pLiq30d === "number" ? risk.pLiq30d : undefined,
      notes: String(risk.notes ?? "")
    },
    status: payload.status === "ok" || payload.status === "skipped" ? payload.status : "error",
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    userOp: userOpPayload
      ? {
          action: parseDecision(userOpPayload.action),
          userOpHash: String(userOpPayload.userOpHash) as `0x${string}`,
          txHash: String(userOpPayload.txHash) as `0x${string}`,
          blockNumber: valueToBigInt(userOpPayload.blockNumber),
          success: Boolean(userOpPayload.success),
          callData: String(userOpPayload.callData) as `0x${string}`,
          callDataWithSuffix: String(userOpPayload.callDataWithSuffix) as `0x${string}`,
          builderSuffix: String(userOpPayload.builderSuffix) as `0x${string}`,
          summary: String(userOpPayload.summary ?? ""),
          timestamp: String(userOpPayload.timestamp ?? payload.timestamp)
        }
      : undefined,
    provenance: provenance
      ? {
          agentVersion: String(provenance.agentVersion ?? "unknown"),
          autopilotVersion: String(provenance.autopilotVersion ?? "unknown"),
          modelId: String(provenance.modelId ?? "unspecified"),
          policyVersion: String(provenance.policyVersion ?? "unknown"),
          commitSha: String(provenance.commitSha ?? "unknown")
        }
      : undefined
  };
}

function parseSnapshot(raw: string): StorageState {
  const payload = JSON.parse(raw) as { samples?: Array<Record<string, unknown>> };
  const samples = Array.isArray(payload.samples)
    ? payload.samples.map((sample) => ({
        timestamp: String(sample.timestamp),
        chainId: Number(sample.chainId),
        blockNumber: valueToBigInt(sample.blockNumber),
        wstEthPerToken: valueToBigInt(sample.wstEthPerToken)
      }))
    : [];

  return { samples };
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function readStorageState(path: string): Promise<StorageState> {
  try {
    const raw = await readFile(path, "utf8");
    return parseSnapshot(raw);
  } catch {
    return { samples: [] };
  }
}

export async function appendRateSample(path: string, sample: WstEthRateSample, maxSamples = 2048): Promise<StorageState> {
  const current = await readStorageState(path);
  const samples = [...current.samples, sample].slice(-maxSamples);

  await ensureParent(path);
  await writeFile(path, JSON.stringify({ samples }, jsonReplacer, 2), "utf8");

  return { samples };
}

export async function appendRunRecord(path: string, record: AgentRunRecord): Promise<void> {
  await ensureParent(path);
  await appendFile(path, `${serializeRun(record)}\n`, "utf8");
}

export async function readRunRecords(path: string, limit = 200): Promise<AgentRunRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseRun)
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function readLastRunRecord(path: string): Promise<AgentRunRecord | undefined> {
  const runs = await readRunRecords(path, 1);
  return runs[0];
}
