import type { AgentRunRecord, BillingFundingSource, BillingTopupStatus } from "@ssa/shared/types";
import type { Call } from "../aa/bundler";
import type { AgentConfig, ComputeBillingMode } from "../config";

export type BillingTransferKind = "routine" | "harvest";

export type ComputeBillingSnapshot = {
  escrowUsdc: bigint;
};

export type ComputeBillingRunwayStatus = {
  creditBalanceUsdc: bigint;
  fundingSource: BillingFundingSource;
  fallbackWarning?: string;
};

export type BillingTransferSpec = {
  decision: AgentRunRecord["decision"];
  recipientLabel: string;
};

export type ComputeBillingTopupResult = {
  status: Exclude<BillingTopupStatus, "not-attempted">;
  amountUsdc: bigint;
  summary: string;
};

export interface ComputeBillingProvider {
  readonly mode: ComputeBillingMode;
  readRunwayBalanceUsdc(snapshot: ComputeBillingSnapshot): Promise<ComputeBillingRunwayStatus>;
  buildTopupTransferCall(config: AgentConfig, amountUsdc: bigint): Call;
  transferSpec(kind: BillingTransferKind): BillingTransferSpec;
  topUpCredits?(amountUsdc: bigint, reason: string): Promise<ComputeBillingTopupResult>;
}
