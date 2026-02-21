import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type RunStatus = "ok" | "error" | "skipped";
type RunDecision = "none" | "loop" | "delever" | "fund-escrow" | "pay-escrow" | "topup-credits";
type RunUrgency = "nominal" | "elevated" | "critical" | "dead";

export interface EvolutionMetrics {
  generation?: number;
  populationSize?: number;
  mutationRate?: number;
  diversity?: number;
  eliteFitnessUsd?: number;
  fitnessHistoryUsd?: number[];
}

export interface RiskMetrics {
  status: "available" | "unavailable";
  pLiq7d?: number;
  pLiq30d?: number;
  nPaths?: number;
  horizonDays?: number;
  notes?: string;
}

export interface AgentRun {
  timestamp: string;
  status: RunStatus;
  decision: RunDecision;
  reason?: string;
  healthFactorWad?: bigint;
  collateralUsd?: number;
  debtUsd?: number;
  netDeltaUsd?: number;
  escrowBalanceUsdc?: bigint;
  runwayUrgency?: RunUrgency;
  runwayDaysWad?: bigint;
  wstEthAprWad?: bigint;
  borrowAprWad?: bigint;
  error?: string;
  evolution?: EvolutionMetrics;
  risk?: RiskMetrics;
}

export interface AgentState {
  lastRun: AgentRun | null;
  recentRuns: AgentRun[];
  totalRuns: number;
  errorCount: number;
}

const RUNS_PATH = resolve(
  import.meta.dirname ?? ".",
  "../../agent/data/runs.ndjson",
);

const USD_SCALE = 1e8;
const WAD_SCALE = 1e18;
const RAY_PER_WAD = 1_000_000_000n;
const DECISIONS = new Set<RunDecision>(["none", "loop", "delever", "fund-escrow", "pay-escrow", "topup-credits"]);
const STATUSES = new Set<RunStatus>(["ok", "error", "skipped"]);
const URGENCIES = new Set<RunUrgency>(["nominal", "elevated", "critical", "dead"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value);
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseScaledUsd(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) > 1_000_000 ? value / USD_SCALE : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed) / USD_SCALE;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "bigint") return Number(value) / USD_SCALE;
  return undefined;
}

function parseWadRatio(value: unknown): number | undefined {
  const n = parseNumber(value);
  if (n !== undefined) {
    if (Math.abs(n) > 1_000_000_000) return n / WAD_SCALE;
    if (Math.abs(n) > 1 && Math.abs(n) <= 100) return n / 100;
    return n;
  }
  const b = parseBigInt(value);
  if (b !== undefined) return Number(b) / WAD_SCALE;
  return undefined;
}

function rayToWad(ray: bigint | undefined): bigint | undefined {
  if (ray === undefined) return undefined;
  return ray / RAY_PER_WAD;
}

function parseStatus(value: unknown): RunStatus {
  if (typeof value !== "string") return "error";
  const v = value.toLowerCase();
  return STATUSES.has(v as RunStatus) ? (v as RunStatus) : "error";
}

function parseDecision(value: unknown): RunDecision {
  if (typeof value !== "string") return "none";
  return DECISIONS.has(value as RunDecision) ? (value as RunDecision) : "none";
}

function parseUrgency(value: unknown): RunUrgency | undefined {
  if (typeof value !== "string") return undefined;
  return URGENCIES.has(value as RunUrgency) ? (value as RunUrgency) : undefined;
}

function parseEvolution(raw: Record<string, unknown> | undefined): EvolutionMetrics | undefined {
  if (!raw) return undefined;

  const fitnessHistoryRaw = raw.fitnessHistory ?? raw.fitness_history ?? raw.fitnessSeries;
  const fitnessHistoryUsd = Array.isArray(fitnessHistoryRaw)
    ? fitnessHistoryRaw
        .map((v) => parseScaledUsd(v))
        .filter((v): v is number => v !== undefined)
    : undefined;

  const evolution: EvolutionMetrics = {
    generation: parseNumber(raw.generation ?? raw.gen),
    populationSize: parseNumber(raw.populationSize ?? raw.population),
    mutationRate: parseWadRatio(raw.mutationRate ?? raw.mutation_rate ?? raw.mutationWad),
    diversity: parseWadRatio(raw.diversity ?? raw.diversityRate ?? raw.diversityWad),
    eliteFitnessUsd: parseScaledUsd(raw.eliteFitnessUsd ?? raw.bestFitnessUsd ?? raw.bestFitness),
    fitnessHistoryUsd,
  };

  if (
    evolution.generation === undefined &&
    evolution.populationSize === undefined &&
    evolution.mutationRate === undefined &&
    evolution.diversity === undefined &&
    evolution.eliteFitnessUsd === undefined &&
    (!evolution.fitnessHistoryUsd || evolution.fitnessHistoryUsd.length === 0)
  ) {
    return undefined;
  }

  return evolution;
}

function parseRisk(raw: Record<string, unknown> | undefined): RiskMetrics | undefined {
  if (!raw) return undefined;
  const status = raw.status === "available" ? "available" : raw.status === "unavailable" ? "unavailable" : undefined;
  if (!status) return undefined;

  const pLiq7d = parseNumber(raw.pLiq7d);
  const pLiq30d = parseNumber(raw.pLiq30d);
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;

  // Try to extract nPaths and horizonDays from the notes string
  let nPaths: number | undefined;
  let horizonDays: number | undefined;
  if (notes) {
    const pathsMatch = notes.match(/(\d[\d,]*)\s*paths/);
    if (pathsMatch) nPaths = Number(pathsMatch[1].replace(/,/g, ""));
    const horizonMatch = notes.match(/horizon\s*(\d+)d/);
    if (horizonMatch) horizonDays = Number(horizonMatch[1]);
  }

  return { status, pLiq7d, pLiq30d, nPaths, horizonDays, notes };
}

function normalizeRun(raw: unknown): AgentRun | null {
  const payload = asRecord(raw);
  if (!payload) return null;

  const position = asRecord(payload.position);
  const rates = asRecord(payload.rates);
  const economics = asRecord(payload.economics);
  const runway = asRecord(payload.runway);

  const run: AgentRun = {
    timestamp: typeof payload.timestamp === "string" ? payload.timestamp : new Date(0).toISOString(),
    status: parseStatus(payload.status),
    decision: parseDecision(payload.decision),
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    error: typeof payload.error === "string" ? payload.error : undefined,
    healthFactorWad: parseBigInt(payload.healthFactorWad) ?? parseBigInt(position?.healthFactor),
    collateralUsd: parseScaledUsd(payload.collateralUsd) ?? parseScaledUsd(position?.totalCollateralBase),
    debtUsd: parseScaledUsd(payload.debtUsd) ?? parseScaledUsd(position?.totalDebtBase),
    netDeltaUsd: parseScaledUsd(payload.netDeltaUsd) ?? parseScaledUsd(economics?.netDeltaUsd),
    escrowBalanceUsdc: parseBigInt(payload.escrowBalanceUsdc) ?? parseBigInt(runway?.escrowBalanceUsdc),
    runwayUrgency: parseUrgency(payload.runwayUrgency) ?? parseUrgency(runway?.urgency),
    runwayDaysWad: parseBigInt(payload.runwayDaysWad) ?? parseBigInt(runway?.runwayDaysWad),
    wstEthAprWad: parseBigInt(payload.wstEthAprWad) ?? parseBigInt(rates?.wstEthAprWad),
    borrowAprWad: parseBigInt(payload.borrowAprWad) ?? rayToWad(parseBigInt(rates?.wethVariableBorrowRateRay)),
    evolution: parseEvolution(
      asRecord(payload.evolution) ?? asRecord(payload.ga) ?? asRecord(payload.genetics),
    ),
    risk: parseRisk(asRecord(payload.risk)),
  };

  return run;
}

export function readAgentState(): AgentState {
  const empty: AgentState = {
    lastRun: null,
    recentRuns: [],
    totalRuns: 0,
    errorCount: 0,
  };

  if (!existsSync(RUNS_PATH)) return empty;

  try {
    const raw = readFileSync(RUNS_PATH, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const runs: AgentRun[] = [];
    for (const line of lines) {
      try {
        const parsed = normalizeRun(JSON.parse(line));
        if (parsed) runs.push(parsed);
      } catch {
        continue;
      }
    }

    if (runs.length === 0) return empty;

    return {
      lastRun: runs[runs.length - 1] ?? null,
      recentRuns: runs.slice(-24).reverse(),
      totalRuns: runs.length,
      errorCount: runs.filter((run) => run.status === "error").length,
    };
  } catch {
    return empty;
  }
}
