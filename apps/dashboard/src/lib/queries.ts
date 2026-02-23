import {
  aaveAddressProviderAbi,
  aaveOracleAbi,
  aavePoolAbi,
  entryPointAbi,
  erc20Abi,
  wstEthAbi
} from "@ssa/shared/abis";
import { WAD } from "@ssa/shared/constants";
import type {
  AgentRunRecord,
  BillingFundingSource,
  BillingTopupStatus,
  ChampionGateStatus,
  ComputeUrgency
} from "@ssa/shared/types";
import { valueToBigInt } from "@ssa/shared/utils";
import { readFile } from "node:fs/promises";
import type { Hex, PublicClient } from "viem";
import { readBlobText } from "./blob";
import { isAddress, parseAbiItem } from "viem";
import { resolveBasenameWithReverseCheck } from "./basenames";
import { createDashboardPublicClient, getDashboardConfig } from "./viem";

type TrendFieldAvailability = {
  healthFactor: boolean;
  netCarryUsd: boolean;
  runwayDays: boolean;
};

type RunDecision = AgentRunRecord["decision"];
type FundingSource = BillingFundingSource;
type TopupStatus = BillingTopupStatus;

type ParsedUserOp = Omit<NonNullable<AgentRunRecord["userOp"]>, "action"> & {
  action: RunDecision;
};

type RuntimeTelemetry = {
  creditBalanceUsdc: bigint | null;
  fundingSource: FundingSource | null;
  topupStatus: TopupStatus | null;
  topupAmountUsdc: bigint | null;
  fallbackWarning: string | null;
};

type ParsedRun = Omit<AgentRunRecord, "decision" | "userOp"> & {
  decision: RunDecision;
  userOp?: ParsedUserOp;
  runtimeTelemetry: RuntimeTelemetry;
  trendAvailability: TrendFieldAvailability;
};

const DECISIONS: RunDecision[] = ["none", "loop", "delever", "fund-escrow", "pay-escrow", "topup-credits"];
const FUNDING_SOURCES: FundingSource[] = ["escrow", "conway-credits", "escrow-fallback"];
const TOPUP_STATUSES: TopupStatus[] = ["not-attempted", "ok", "skipped", "error"];
const URGENCIES: ComputeUrgency[] = ["nominal", "elevated", "critical", "dead"];

type UserOpView = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  action: string;
  summary: string;
  timestamp: string;
};

type EscrowPaymentView = {
  txHash: Hex;
  amount: bigint;
  recipient: Hex;
  blockNumber: bigint;
  timestamp: string;
};

type RuntimeProvenanceView = {
  agentVersion: string;
  autopilotVersion: string;
  modelId: string;
  policyVersion: string;
  commitSha: string;
};

type AutopilotStateView = {
  phase: number | null;
  stage: string | null;
  emergencyStop: boolean;
  requireHumanApproval: boolean;
  requiresTimelock: boolean;
  lastPolicyGateOk: boolean | null;
  lastReplayOk: boolean | null;
  lastVerificationOk: boolean | null;
  lastDeploymentAction: string | null;
  lastProposalId: string | null;
  trustModel: string[];
  timestamp: string | null;
};

type BasenameView = {
  address: Hex;
  reverseName: string | null;
  basename: string | null;
  reverseVerified: boolean;
};

type ChampionLineageView = {
  championId: number | null;
  parentChampionId: number | null;
  candidateId: string;
  proposalId: string | null;
  gateStatus: ChampionGateStatus;
  candidateHash: string;
  lineageHash: string;
  provenanceHash: string;
  gateHash: string;
  replaySource: string;
  simulationOnly: boolean;
  submitterAddress: Hex | null;
  createdAt: string | null;
  evaluatedAt: string | null;
  promoted: boolean;
};

type ChampionStateView = {
  registryAddress: Hex | null;
  currentChampionId: number | null;
  gateStatus: ChampionGateStatus;
  artifactDigest: string | null;
  provenanceDigest: string | null;
  currentChampion: ChampionLineageView | null;
  lineage: ChampionLineageView[];
  basenames: {
    smartAccount: BasenameView | null;
    escrow: BasenameView | null;
    currentChampionSubmitter: BasenameView | null;
  };
};

type DashboardFreshnessView = {
  dashboard: string;
  autopilot: string | null;
  latestRun: string | null;
  champion: string | null;
};

type DashboardTrendPoint = {
  timestamp: string;
  value: bigint | null;
};

type DashboardTrendSeries = {
  healthFactor: DashboardTrendPoint[];
  netCarryUsd: DashboardTrendPoint[];
  runwayDays: DashboardTrendPoint[];
};

export type DashboardState = {
  timestamp: string;
  freshness: DashboardFreshnessView;
  chainId: number;
  explorerTxUrl: string;
  smartAccountAddress: Hex;
  entryPointAddress: Hex;
  escrowAddress: Hex;
  balances: {
    eth: bigint;
    weth: bigint;
    wstEth: bigint;
    usdc: bigint;
  };
  usdcDecimals: number;
  escrowBalanceUsdc: bigint;
  position: {
    totalCollateralBase: bigint;
    totalDebtBase: bigint;
    availableBorrowsBase: bigint;
    healthFactor: bigint;
    currentLiquidationThresholdBps: bigint;
    ltvBps: bigint;
  };
  rates: {
    wethVariableBorrowRateRay: bigint;
    wstEthPerToken: bigint;
  };
  prices: {
    wethUsd: bigint;
    wstEthUsd: bigint;
    usdcUsd: bigint;
  };
  netCarryEstimateUsd: bigint | null;
  lastRunStatus: string | null;
  lastRunReason: string | null;
  fundingSource: FundingSource | null;
  creditBalanceUsdc: bigint | null;
  topupStatus: TopupStatus | null;
  topupAmountUsdc: bigint | null;
  fallbackWarning: string | null;
  riskNote: string | null;
  perTickCostUsdc: bigint | null;
  liveRunwayDaysWad: bigint | null;
  liveRunwayUrgency: ComputeUrgency | null;
  trends: DashboardTrendSeries;
  totalEscrowPaidUsdc: bigint;
  totalGasPaymentUsdc: bigint;
  latestGasPaymentUsdc: bigint | null;
  escrowPayments: EscrowPaymentView[];
  recentUserOps: UserOpView[];
  provenance: RuntimeProvenanceView | null;
  autopilot: AutopilotStateView;
  champion: ChampionStateView;
};

type RecentRunReceiptStatus = "success" | "reverted" | "unknown" | "offchain";

export type RecentRunView = {
  timestamp: string;
  status: ParsedRun["status"];
  decision: RunDecision;
  summary: string;
  userOpHash: Hex | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
  receiptStatus: RecentRunReceiptStatus;
  fundingSource: FundingSource | null;
  topupStatus: TopupStatus | null;
  topupAmountUsdc: bigint | null;
  fallbackWarning: string | null;
};

export type RecentRunsView = {
  hasRuns: boolean;
  runs: RecentRunView[];
};

function parseDecision(value: unknown): RunDecision {
  if (typeof value !== "string") return "none";
  return DECISIONS.includes(value as RunDecision) ? (value as RunDecision) : "none";
}

function parseUrgency(value: unknown): ComputeUrgency {
  if (typeof value !== "string") return "dead";
  return URGENCIES.includes(value as ComputeUrgency) ? (value as ComputeUrgency) : "dead";
}

function parseFundingSource(value: unknown): FundingSource | null {
  if (typeof value !== "string") return null;
  return FUNDING_SOURCES.includes(value as FundingSource) ? (value as FundingSource) : null;
}

function parseTopupStatus(value: unknown): TopupStatus | null {
  if (typeof value !== "string") return null;
  return TOPUP_STATUSES.includes(value as TopupStatus) ? (value as TopupStatus) : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function hasBigIntLikeValue(value: unknown): boolean {
  return typeof value === "bigint" || typeof value === "number" || (typeof value === "string" && /^-?\d+$/.test(value));
}

function parseOptionalBigInt(value: unknown): bigint | null {
  return hasBigIntLikeValue(value) ? valueToBigInt(value) : null;
}

function parseOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstDefined<T>(values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function urgencyFromDaysWad(
  runwayDaysWad: bigint,
  nominalDays: bigint,
  elevatedDays: bigint,
  deadDays: bigint
): ComputeUrgency {
  if (runwayDaysWad >= nominalDays * WAD) return "nominal";
  if (runwayDaysWad >= elevatedDays * WAD) return "elevated";
  if (runwayDaysWad >= deadDays * WAD) return "critical";
  return "dead";
}

function parseRunLine(line: string): ParsedRun {
  const payload = JSON.parse(line) as Record<string, unknown>;
  const position = asRecord(payload.position) ?? {};
  const balances = asRecord(payload.balances) ?? {};
  const rates = asRecord(payload.rates) ?? {};
  const economics = asRecord(payload.economics) ?? {};
  const risk = asRecord(payload.risk) ?? {};
  const runway = asRecord(payload.runway);
  const userOpPayload = asRecord(payload.userOp);
  const provenance = asRecord(payload.provenance);
  const topup = asRecord(payload.topup);
  const billing = asRecord(payload.billing);
  const telemetry = asRecord(payload.telemetry);
  const runtime = asRecord(payload.runtime);
  const trendAvailability: TrendFieldAvailability = {
    healthFactor: hasBigIntLikeValue(position.healthFactor),
    netCarryUsd: hasBigIntLikeValue(economics.netDeltaUsd),
    runwayDays: hasBigIntLikeValue(runway?.runwayDaysWad)
  };
  const runtimeTelemetry: RuntimeTelemetry = {
    creditBalanceUsdc: firstDefined([
      parseOptionalBigInt(payload.creditBalanceUsdc),
      parseOptionalBigInt(runway?.creditBalanceUsdc),
      parseOptionalBigInt(runtime?.creditBalanceUsdc),
      parseOptionalBigInt(telemetry?.creditBalanceUsdc),
      parseOptionalBigInt(billing?.creditBalanceUsdc),
      parseOptionalBigInt(topup?.creditBalanceUsdc),
      parseOptionalBigInt(topup?.balanceUsdc)
    ]),
    fundingSource: firstDefined([
      parseFundingSource(payload.fundingSource),
      parseFundingSource(runway?.fundingSource),
      parseFundingSource(runtime?.fundingSource),
      parseFundingSource(telemetry?.fundingSource),
      parseFundingSource(billing?.fundingSource),
      parseFundingSource(topup?.fundingSource)
    ]),
    topupStatus: firstDefined([
      parseTopupStatus(payload.topupStatus),
      parseTopupStatus(runway?.topupStatus),
      parseTopupStatus(runtime?.topupStatus),
      parseTopupStatus(telemetry?.topupStatus),
      parseTopupStatus(billing?.topupStatus),
      parseTopupStatus(topup?.status),
      parseTopupStatus(topup?.topupStatus)
    ]),
    topupAmountUsdc: firstDefined([
      parseOptionalBigInt(payload.topupAmountUsdc),
      parseOptionalBigInt(runway?.topupAmountUsdc),
      parseOptionalBigInt(runtime?.topupAmountUsdc),
      parseOptionalBigInt(telemetry?.topupAmountUsdc),
      parseOptionalBigInt(billing?.topupAmountUsdc),
      parseOptionalBigInt(topup?.amountUsdc),
      parseOptionalBigInt(topup?.creditedUsdc)
    ]),
    fallbackWarning: firstDefined([
      parseOptionalText(payload.fallbackWarning),
      parseOptionalText(runway?.fallbackWarning),
      parseOptionalText(runtime?.fallbackWarning),
      parseOptionalText(telemetry?.fallbackWarning),
      parseOptionalText(billing?.fallbackWarning),
      parseOptionalText(topup?.fallbackWarning)
    ])
  };
  const creditBalanceUsdc = runtimeTelemetry.creditBalanceUsdc ?? valueToBigInt(runway?.escrowBalanceUsdc);
  const fundingSource = runtimeTelemetry.fundingSource ?? "escrow";
  const topupStatus = runtimeTelemetry.topupStatus ?? "not-attempted";
  const topupAmountUsdc = runtimeTelemetry.topupAmountUsdc ?? 0n;
  const fallbackWarning = runtimeTelemetry.fallbackWarning ?? undefined;

  return {
    timestamp: String(payload.timestamp),
    mode: payload.mode === "live" ? "live" : "dry-run",
    chainId: Number(payload.chainId),
    account: String(payload.account) as Hex,
    decision: parseDecision(payload.decision),
    dryRun: Boolean(payload.dryRun),
    creditBalanceUsdc,
    fundingSource,
    topupStatus,
    topupAmountUsdc,
    fallbackWarning,
    status: payload.status === "ok" || payload.status === "skipped" ? payload.status : "error",
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
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
      gasPaymentUsdc: economics.gasPaymentUsdc == null ? null : valueToBigInt(economics.gasPaymentUsdc),
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
    userOp: userOpPayload
      ? {
          action: parseDecision(userOpPayload.action),
          userOpHash: String(userOpPayload.userOpHash) as Hex,
          txHash: String(userOpPayload.txHash) as Hex,
          blockNumber: valueToBigInt(userOpPayload.blockNumber),
          success: Boolean(userOpPayload.success),
          callData: String(userOpPayload.callData) as Hex,
          callDataWithSuffix: String(userOpPayload.callDataWithSuffix) as Hex,
          builderSuffix: String(userOpPayload.builderSuffix) as Hex,
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
      : undefined,
    runtimeTelemetry,
    trendAvailability
  };
}

function latestIsoTimestamp(timestamps: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > latestMs) {
      latestMs = parsed;
      latest = new Date(parsed).toISOString();
    }
  }

  return latest;
}

function championFreshnessTimestamp(champion: ChampionStateView): string | null {
  const lineageTimestamps = champion.lineage.flatMap((entry) => [entry.evaluatedAt, entry.createdAt]);
  return latestIsoTimestamp([champion.currentChampion?.evaluatedAt, champion.currentChampion?.createdAt, ...lineageTimestamps]);
}

function buildDashboardTrends(runs: ParsedRun[]): DashboardTrendSeries {
  const latestRuns = runs.slice(-30);
  return {
    healthFactor: latestRuns.map((run) => ({
      timestamp: run.timestamp,
      value: run.trendAvailability.healthFactor ? run.position.healthFactor : null
    })),
    netCarryUsd: latestRuns.map((run) => ({
      timestamp: run.timestamp,
      value: run.trendAvailability.netCarryUsd ? run.economics.netDeltaUsd : null
    })),
    runwayDays: latestRuns.map((run) => ({
      timestamp: run.timestamp,
      value: run.trendAvailability.runwayDays ? run.runway?.runwayDaysWad ?? null : null
    }))
  };
}

function computeLiveRunwayFromLatest(
  latestRun: ParsedRun | undefined,
  runwayBalanceUsdc: bigint
): Pick<DashboardState, "perTickCostUsdc" | "liveRunwayDaysWad" | "liveRunwayUrgency"> {
  const latestRunway = latestRun?.runway;
  if (!latestRunway || latestRunway.perTickCostUsdc <= 0n || latestRunway.ticksPerDayWad <= 0n) {
    return {
      perTickCostUsdc: null,
      liveRunwayDaysWad: null,
      liveRunwayUrgency: null
    };
  }

  const dailyCostUsdc = (latestRunway.perTickCostUsdc * latestRunway.ticksPerDayWad + WAD - 1n) / WAD;
  if (dailyCostUsdc <= 0n) {
    return {
      perTickCostUsdc: latestRunway.perTickCostUsdc,
      liveRunwayDaysWad: null,
      liveRunwayUrgency: null
    };
  }

  const liveRunwayDaysWad = (runwayBalanceUsdc * WAD) / dailyCostUsdc;
  const nominalDays = latestRunway.nominalDays > 0n ? latestRunway.nominalDays : 14n;
  const elevatedDays = latestRunway.elevatedDays > 0n ? latestRunway.elevatedDays : 7n;
  const deadDays = latestRunway.deadDays > 0n ? latestRunway.deadDays : 2n;

  return {
    perTickCostUsdc: latestRunway.perTickCostUsdc,
    liveRunwayDaysWad,
    liveRunwayUrgency: urgencyFromDaysWad(liveRunwayDaysWad, nominalDays, elevatedDays, deadDays)
  };
}

function resolveRunwayBalanceUsdc(latestRun: ParsedRun | undefined, escrowBalanceUsdc: bigint): bigint {
  if (!latestRun) return escrowBalanceUsdc;
  if (latestRun.fundingSource === "conway-credits") {
    return latestRun.creditBalanceUsdc;
  }
  return escrowBalanceUsdc;
}

async function readRuns(path: string): Promise<ParsedRun[]> {
  try {
    const raw = process.env.VERCEL
      ? await readBlobText("telemetry/runs.ndjson")
      : await readFile(path, "utf8");
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseRunLine);
  } catch {
    return [];
  }
}

async function readAutopilotState(statePath: string, policyPath: string): Promise<AutopilotStateView> {
  let trustModel: string[] = [];
  try {
    const rawPolicy = await readFile(policyPath, "utf8");
    const policy = JSON.parse(rawPolicy) as { rollout?: { trust_model?: unknown } };
    const trustModelRaw = policy.rollout?.trust_model;
    trustModel = Array.isArray(trustModelRaw) ? trustModelRaw.map(String) : [];
  } catch {
    trustModel = [];
  }

  try {
    const raw = process.env.VERCEL
      ? await readBlobText("telemetry/autopilot-state.json")
      : await readFile(statePath, "utf8");
    if (!raw) throw new Error("no data");
    const state = JSON.parse(raw) as Record<string, unknown>;
    const lastProposal = state.lastProposal as Record<string, unknown> | undefined;
    const lastPolicyGate = state.lastPolicyGate as Record<string, unknown> | undefined;
    const lastDeployment = state.lastDeployment as Record<string, unknown> | undefined;
    const lastVerification = state.lastVerification as Record<string, unknown> | undefined;
    const lastReplay = state.lastReplay as Record<string, unknown> | undefined;

    return {
      phase: typeof state.phase === "number" ? state.phase : null,
      stage: typeof state.stage === "string" ? state.stage : null,
      emergencyStop: Boolean(state.emergencyStop),
      requireHumanApproval: Boolean(state.requireHumanApproval),
      requiresTimelock: Boolean(state.requiresTimelock),
      lastPolicyGateOk: typeof lastPolicyGate?.ok === "boolean" ? lastPolicyGate.ok : null,
      lastReplayOk: typeof lastReplay?.ok === "boolean" ? lastReplay.ok : null,
      lastVerificationOk: typeof lastVerification?.ok === "boolean" ? lastVerification.ok : null,
      lastDeploymentAction: typeof lastDeployment?.action === "string" ? lastDeployment.action : null,
      lastProposalId: typeof lastProposal?.proposalId === "string" ? lastProposal.proposalId : null,
      trustModel,
      timestamp: typeof state.timestamp === "string" ? state.timestamp : null
    };
  } catch {
    return {
      phase: null,
      stage: null,
      emergencyStop: false,
      requireHumanApproval: true,
      requiresTimelock: false,
      lastPolicyGateOk: null,
      lastReplayOk: null,
      lastVerificationOk: null,
      lastDeploymentAction: null,
      lastProposalId: null,
      trustModel,
      timestamp: null
    };
  }
}

function parseChampionGateStatus(value: unknown): ChampionGateStatus {
  if (value === "pass" || value === "fail" || value === "pending" || value === "simulation-only") {
    return value;
  }
  return "pending";
}

function asOptionalHex(value: unknown): Hex | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return value as Hex;
}

function parseChampionLineageEntry(raw: Record<string, unknown>): ChampionLineageView {
  return {
    championId: typeof raw.championId === "number" ? raw.championId : null,
    parentChampionId: typeof raw.parentChampionId === "number" ? raw.parentChampionId : null,
    candidateId: typeof raw.candidateId === "string" ? raw.candidateId : "unknown",
    proposalId: typeof raw.proposalId === "string" ? raw.proposalId : null,
    gateStatus: parseChampionGateStatus(raw.gateStatus),
    candidateHash: typeof raw.candidateHash === "string" ? raw.candidateHash : "sha256:unknown",
    lineageHash: typeof raw.lineageHash === "string" ? raw.lineageHash : "sha256:unknown",
    provenanceHash: typeof raw.provenanceHash === "string" ? raw.provenanceHash : "sha256:unknown",
    gateHash: typeof raw.gateHash === "string" ? raw.gateHash : "sha256:unknown",
    replaySource: typeof raw.replaySource === "string" ? raw.replaySource : "unknown",
    simulationOnly: Boolean(raw.simulationOnly),
    submitterAddress: asOptionalHex(raw.submitterAddress),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    evaluatedAt: typeof raw.evaluatedAt === "string" ? raw.evaluatedAt : null,
    promoted: Boolean(raw.promoted)
  };
}

function emptyChampionState(registryAddress: Hex | null): ChampionStateView {
  return {
    registryAddress,
    currentChampionId: null,
    gateStatus: "pending",
    artifactDigest: null,
    provenanceDigest: null,
    currentChampion: null,
    lineage: [],
    basenames: {
      smartAccount: null,
      escrow: null,
      currentChampionSubmitter: null
    }
  };
}

async function readChampionState(
  championStatePath: string,
  registryAddressFallback: Hex | null
): Promise<ChampionStateView> {
  try {
    const raw = process.env.VERCEL
      ? await readBlobText("telemetry/champion-state.json")
      : await readFile(championStatePath, "utf8");
    if (!raw) throw new Error("no data");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lineageRaw = Array.isArray(parsed.lineage) ? parsed.lineage : [];
    const lineage = lineageRaw
      .map((item) => (item && typeof item === "object" ? parseChampionLineageEntry(item as Record<string, unknown>) : null))
      .filter((item): item is ChampionLineageView => Boolean(item));

    const currentChampionRaw =
      parsed.currentChampion && typeof parsed.currentChampion === "object"
        ? parseChampionLineageEntry(parsed.currentChampion as Record<string, unknown>)
        : null;

    const registryAddress = asOptionalHex(parsed.registryAddress) ?? registryAddressFallback;
    return {
      registryAddress,
      currentChampionId: typeof parsed.currentChampionId === "number" ? parsed.currentChampionId : null,
      gateStatus: parseChampionGateStatus(parsed.gateStatus),
      artifactDigest: typeof parsed.artifactDigest === "string" ? parsed.artifactDigest : null,
      provenanceDigest: typeof parsed.provenanceDigest === "string" ? parsed.provenanceDigest : null,
      currentChampion: currentChampionRaw,
      lineage,
      basenames: {
        smartAccount: null,
        escrow: null,
        currentChampionSubmitter: null
      }
    };
  } catch {
    return emptyChampionState(registryAddressFallback);
  }
}

async function verifyRunReceipts(client: PublicClient, runs: ParsedRun[]): Promise<UserOpView[]> {
  const withUserOp = runs.filter((run) => run.userOp);

  const verified = await Promise.all(
    withUserOp.map(async (run) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: run.userOp!.txHash });
        return {
          userOpHash: run.userOp!.userOpHash,
          txHash: run.userOp!.txHash,
          blockNumber: receipt.blockNumber,
          success: receipt.status === "success",
          action: run.userOp!.action,
          summary: run.userOp!.summary,
          timestamp: run.userOp!.timestamp
        } as UserOpView;
      } catch {
        return undefined;
      }
    })
  );

  return verified.filter((item): item is UserOpView => Boolean(item)).slice(-20).reverse();
}

async function queryEscrowPayments(
  client: PublicClient,
  account: Hex,
  escrowAddress: Hex,
  usdcAddress: Hex,
  fromBlock: bigint
): Promise<EscrowPaymentView[]> {
  try {
  const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

  const logs = await client.getLogs({
    address: usdcAddress,
    event: transferEvent,
    args: {
      from: account,
      to: escrowAddress
    },
    fromBlock,
    toBlock: "latest"
  });

  const blockCache = new Map<string, bigint>();

  const enriched = await Promise.all(
    logs.map(async (log) => {
      const key = log.blockNumber.toString();
      let ts = blockCache.get(key);

      if (!ts) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        ts = block.timestamp;
        blockCache.set(key, ts);
      }

      return {
        txHash: log.transactionHash,
        amount: log.args.value ?? 0n,
        recipient: escrowAddress,
        blockNumber: log.blockNumber,
        timestamp: new Date(Number(ts) * 1000).toISOString()
      } as EscrowPaymentView;
    })
  );

  return enriched.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 50);
  } catch {
    return [];
  }
}

async function queryEntryPointUserOps(
  client: PublicClient,
  entryPoint: Hex,
  sender: Hex,
  fromBlock: bigint
): Promise<UserOpView[]> {
  try {
  const logs = await client.getLogs({
    address: entryPoint,
    event: entryPointAbi[1],
    args: {
      sender
    },
    fromBlock,
    toBlock: "latest"
  });

  const blockCache = new Map<string, bigint>();

  const items = await Promise.all(
    logs.map(async (log) => {
      const key = log.blockNumber.toString();
      let ts = blockCache.get(key);

      if (!ts) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        ts = block.timestamp;
        blockCache.set(key, ts);
      }

      return {
        userOpHash: log.args.userOpHash as Hex,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        success: Boolean(log.args.success),
        action: "from-entrypoint",
        summary: "UserOperationEvent",
        timestamp: new Date(Number(ts) * 1000).toISOString()
      } as UserOpView;
    })
  );

  return items.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 20);
  } catch {
    return [];
  }
}

async function readWstEthPerToken(client: PublicClient, token: Hex): Promise<bigint> {
  try {
    return await client.readContract({
      abi: wstEthAbi,
      address: token,
      functionName: "stEthPerToken"
    });
  } catch {
    // Multichain wstETH deployments may not expose stEthPerToken; use neutral 1.0 ratio fallback.
    return WAD;
  }
}

export async function queryDashboardState(): Promise<DashboardState> {
  const config = getDashboardConfig();
  const client = createDashboardPublicClient(config);

  const [blockNumber, runs, autopilot, championStateFromFile] = await Promise.all([
    client.getBlockNumber(),
    readRuns(config.runLogPath),
    readAutopilotState(config.autopilotStatePath, config.autonomyPolicyPath),
    readChampionState(config.championStatePath, config.championRegistryAddress ?? null)
  ]);
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;

  const fromBlock =
    config.escrowPaymentsFromBlock ??
    (blockNumber > config.userOpsWindowBlocks ? blockNumber - config.userOpsWindowBlocks : 0n);

  const [
    eth,
    weth,
    wstEth,
    usdc,
    escrowUsdc,
    userData,
    reserveData,
    provider,
    wstEthPerToken,
    entrypointUserOps,
    verifiedRuns
  ] = await Promise.all([
    client.getBalance({ address: config.smartAccountAddress }),
    client.readContract({
      abi: erc20Abi,
      address: config.wethAddress,
      functionName: "balanceOf",
      args: [config.smartAccountAddress]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.wstEthAddress,
      functionName: "balanceOf",
      args: [config.smartAccountAddress]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.usdcAddress,
      functionName: "balanceOf",
      args: [config.smartAccountAddress]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.usdcAddress,
      functionName: "balanceOf",
      args: [config.escrowAddress]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "getUserAccountData",
      args: [config.smartAccountAddress]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "getReserveData",
      args: [config.wethAddress]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "ADDRESSES_PROVIDER"
    }),
    readWstEthPerToken(client, config.wstEthAddress),
    queryEntryPointUserOps(client, config.entryPointAddress, config.smartAccountAddress, fromBlock),
    verifyRunReceipts(client, runs)
  ]);

  const oracle = await client.readContract({
    abi: aaveAddressProviderAbi,
    address: provider,
    functionName: "getPriceOracle"
  });

  const [wethUsd, wstEthUsd, usdcUsd, escrowPayments] = await Promise.all([
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.wethAddress]
    }),
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.wstEthAddress]
    }),
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.usdcAddress]
    }),
    queryEscrowPayments(client, config.smartAccountAddress, config.escrowAddress, config.usdcAddress, fromBlock)
  ]);

  const totalEscrowPaidUsdc = escrowPayments.reduce((acc, item) => acc + item.amount, 0n);

  const totalGasPaymentUsdc = runs.reduce(
    (acc, run) => acc + (run.economics.gasPaymentUsdc ?? 0n),
    0n
  );
  const latestGasPaymentUsdc = latestRun?.economics.gasPaymentUsdc ?? null;

  const dedupedUserOpsMap = new Map<string, UserOpView>();
  for (const item of [...verifiedRuns, ...entrypointUserOps]) {
    const key = `${item.userOpHash}-${item.txHash}`;
    if (!dedupedUserOpsMap.has(key)) dedupedUserOpsMap.set(key, item);
  }

  const recentUserOps = [...dedupedUserOpsMap.values()]
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
    .slice(0, 20);

  const position = {
    totalCollateralBase: userData[0],
    totalDebtBase: userData[1],
    availableBorrowsBase: userData[2],
    currentLiquidationThresholdBps: userData[3],
    ltvBps: userData[4],
    healthFactor: userData[5]
  };

  const runwayBalanceUsdc = resolveRunwayBalanceUsdc(latestRun, escrowUsdc);
  const liveRunway = computeLiveRunwayFromLatest(latestRun, runwayBalanceUsdc);
  const [smartAccountBasename, escrowBasename, championSubmitterBasename] = await Promise.all([
    resolveBasenameWithReverseCheck(client, config.smartAccountAddress),
    resolveBasenameWithReverseCheck(client, config.escrowAddress),
    championStateFromFile.currentChampion?.submitterAddress
      ? resolveBasenameWithReverseCheck(client, championStateFromFile.currentChampion.submitterAddress)
      : Promise.resolve(null)
  ]);
  const champion: ChampionStateView = {
    ...championStateFromFile,
    basenames: {
      smartAccount: smartAccountBasename,
      escrow: escrowBasename,
      currentChampionSubmitter: championSubmitterBasename
    }
  };
  const dashboardTimestamp = new Date().toISOString();
  const freshness: DashboardFreshnessView = {
    dashboard: dashboardTimestamp,
    autopilot: autopilot.timestamp,
    latestRun: latestRun?.timestamp ?? null,
    champion: championFreshnessTimestamp(champion)
  };
  const trends = buildDashboardTrends(runs);

  return {
    timestamp: dashboardTimestamp,
    freshness,
    chainId: config.chainId,
    explorerTxUrl: config.explorerTxUrl,
    smartAccountAddress: config.smartAccountAddress,
    entryPointAddress: config.entryPointAddress,
    escrowAddress: config.escrowAddress,
    balances: {
      eth,
      weth,
      wstEth,
      usdc
    },
    usdcDecimals: config.usdcDecimals,
    escrowBalanceUsdc: escrowUsdc,
    position,
    rates: {
      wethVariableBorrowRateRay: reserveData.currentVariableBorrowRate,
      wstEthPerToken
    },
    prices: {
      wethUsd,
      wstEthUsd,
      usdcUsd
    },
    netCarryEstimateUsd: latestRun?.economics.netDeltaUsd ?? null,
    lastRunStatus: latestRun?.status ?? null,
    lastRunReason: latestRun?.reason ?? null,
    fundingSource: latestRun?.fundingSource ?? null,
    creditBalanceUsdc: latestRun?.creditBalanceUsdc ?? null,
    topupStatus: latestRun?.topupStatus ?? null,
    topupAmountUsdc: latestRun?.topupAmountUsdc ?? null,
    fallbackWarning: latestRun?.fallbackWarning ?? null,
    riskNote: latestRun?.risk.notes ?? null,
    perTickCostUsdc: liveRunway.perTickCostUsdc,
    liveRunwayDaysWad: liveRunway.liveRunwayDaysWad,
    liveRunwayUrgency: liveRunway.liveRunwayUrgency,
    trends,
    totalEscrowPaidUsdc,
    totalGasPaymentUsdc,
    latestGasPaymentUsdc,
    escrowPayments,
    recentUserOps,
    provenance: latestRun?.provenance
      ? {
          agentVersion: latestRun.provenance.agentVersion,
          autopilotVersion: latestRun.provenance.autopilotVersion,
          modelId: latestRun.provenance.modelId,
          policyVersion: latestRun.provenance.policyVersion,
          commitSha: latestRun.provenance.commitSha
        }
      : null,
    autopilot,
    champion
  };
}

function buildRecentRunSummary(run: ParsedRun): string {
  if (typeof run.reason === "string" && run.reason.trim().length > 0) {
    return run.reason;
  }
  if (run.userOp?.summary && run.userOp.summary.trim().length > 0) {
    return run.userOp.summary;
  }
  if (run.decision === "topup-credits") {
    const status = run.topupStatus;
    const amount = run.topupAmountUsdc;
    const amountLabel = amount == null ? "unknown amount" : `${amount.toString()} usdc units`;
    return `Credit topup ${status} (${amountLabel})`;
  }
  return "";
}

export async function queryRecentRuns(): Promise<RecentRunsView> {
  const config = getDashboardConfig();
  const client = createDashboardPublicClient(config);
  const runs = await readRuns(config.runLogPath);

  const result = await Promise.all(
    runs
      .slice(-50)
      .map(async (run) => {
        const base: Omit<RecentRunView, "receiptStatus" | "userOpHash" | "txHash" | "blockNumber"> = {
          timestamp: run.timestamp,
          status: run.status,
          decision: run.decision,
          summary: buildRecentRunSummary(run),
          fundingSource: run.fundingSource,
          topupStatus: run.topupStatus,
          topupAmountUsdc: run.topupAmountUsdc,
          fallbackWarning: run.fallbackWarning ?? null
        };

        if (!run.userOp) {
          return {
            ...base,
            userOpHash: null,
            txHash: null,
            blockNumber: null,
            receiptStatus: "offchain" as const
          };
        }

        const txHash = run.userOp.txHash;

        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash });
          return {
            ...base,
            userOpHash: run.userOp.userOpHash,
            txHash,
            blockNumber: receipt.blockNumber,
            receiptStatus: receipt.status as Extract<RecentRunReceiptStatus, "success" | "reverted">
          };
        } catch {
          return {
            ...base,
            userOpHash: run.userOp.userOpHash,
            txHash,
            blockNumber: run.userOp.blockNumber,
            receiptStatus: "unknown" as const
          };
        }
      })
  );

  return {
    hasRuns: runs.length > 0,
    runs: result.reverse()
  };
}
