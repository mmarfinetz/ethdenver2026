import type { Address, Hex } from "viem";

export type RunMode = "dry-run" | "live";

export type PositionSnapshot = {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThresholdBps: bigint;
  currentLtvBps: bigint;
  healthFactor: bigint;
};

export type Balances = {
  eth: bigint;
  weth: bigint;
  wstEth: bigint;
  usdc: bigint;
};

export type RateSnapshot = {
  wethVariableBorrowRateRay: bigint;
  wstEthPerToken: bigint;
  wstEthAprWad: bigint | null;
};

export type EconomicsSnapshot = {
  intervalSeconds: bigint;
  yieldDeltaUsd: bigint;
  interestDeltaUsd: bigint;
  gasCostUsd: bigint;
  swapCostUsd: bigint;
  computeCostUsd: bigint;
  netDeltaUsd: bigint;
  breakEvenEquityUsdApprox: bigint | null;
  leverageWad: bigint;
  /** USDC spent on gas via Circle Paymaster (null if using ETH for gas) */
  gasPaymentUsdc: bigint | null;
  notes: string[];
};

export type RiskOutput = {
  status: "available" | "unavailable";
  pLiq7d?: number;
  pLiq30d?: number;
  notes: string;
};

export type ActionDecision =
  | "none"
  | "loop"
  | "delever"
  | "fund-escrow"
  | "pay-escrow"
  | "topup-credits";

export type BillingFundingSource = "escrow" | "conway-credits" | "escrow-fallback";

export type BillingTopupStatus = "not-attempted" | "ok" | "skipped" | "error";

export type ComputeUrgency = "nominal" | "elevated" | "critical" | "dead";

export type ComputeRunway = {
  escrowBalanceUsdc: bigint;
  perTickCostUsdc: bigint;
  runwayDaysWad: bigint;
  urgency: ComputeUrgency;
  baseIntervalSeconds: bigint;
  ticksPerDayWad: bigint;
  nominalDays: bigint;
  elevatedDays: bigint;
  deadDays: bigint;
};

export type UserOpRecord = {
  action: ActionDecision;
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  callData: Hex;
  callDataWithSuffix: Hex;
  builderSuffix: Hex;
  summary: string;
  timestamp: string;
};

export type RuntimeProvenance = {
  agentVersion: string;
  autopilotVersion: string;
  modelId: string;
  policyVersion: string;
  commitSha: string;
};

export type ConwayReconciliationSnapshot = {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  payerStartBalanceUsdc: bigint;
  payerEndBalanceUsdc: bigint;
  creditTopupsUsdc: bigint;
  smartAccountFundingUsdc: bigint;
  lhsUsdc: bigint;
  rhsUsdc: bigint;
  withinInvariant: boolean;
};

export type AgentRunRecord = {
  timestamp: string;
  mode: RunMode;
  chainId: number;
  account: Address;
  decision: ActionDecision;
  dryRun: boolean;
  creditBalanceUsdc: bigint;
  fundingSource: BillingFundingSource;
  topupStatus: BillingTopupStatus;
  topupAmountUsdc: bigint;
  payerAddress?: Address;
  payerBalanceUsdc?: bigint;
  payerFundingUsdc?: bigint;
  computeBurnUsdc?: bigint;
  reconciliation?: ConwayReconciliationSnapshot;
  fallbackWarning?: string;
  position: PositionSnapshot;
  balances: Balances;
  rates: RateSnapshot;
  economics: EconomicsSnapshot;
  runway?: ComputeRunway;
  risk: RiskOutput;
  status: "ok" | "error" | "skipped";
  reason?: string;
  userOp?: UserOpRecord;
  provenance?: RuntimeProvenance;
};

export type WstEthRateSample = {
  timestamp: string;
  chainId: number;
  blockNumber: bigint;
  wstEthPerToken: bigint;
};

export type StorageState = {
  samples: WstEthRateSample[];
};

export type ChampionGateStatus = "pending" | "pass" | "fail" | "simulation-only";

export type ChampionRecord = {
  championId: bigint;
  parentChampionId: bigint;
  lineageHash: Hex;
  candidateHash: Hex;
  provenanceHash: Hex;
  gateHash: Hex;
  createdAt: bigint;
  submitter: Address;
};

export type ChampionRegistrySnapshot = {
  currentChampionId: bigint | null;
  championCount: bigint;
  lineageArchiveRoot: Hex;
  provenanceArchiveRoot: Hex;
};

export type ChampionDashboardView = {
  registryAddress: Address | null;
  currentChampion: ChampionRecord | null;
  lineage: ChampionRecord[];
  gateStatus: ChampionGateStatus;
  artifactDigest: string | null;
  provenanceDigest: string | null;
  submitterLabel: string | null;
};

export type ComputePayment = {
  txHash: Hex;
  amount: bigint;
  recipient: Address;
  blockNumber: bigint;
  timestamp: string;
};
