import { callTransfer } from "../aave";
import type { AgentConfig } from "../config";
import type { BillingTransferKind, BillingTransferSpec, ComputeBillingProvider, ComputeBillingTopupResult } from "./types";

function transferSpec(kind: BillingTransferKind): BillingTransferSpec {
  if (kind === "harvest") {
    return {
      decision: "fund-escrow",
      recipientLabel: "escrow"
    };
  }

  return {
    decision: "pay-escrow",
    recipientLabel: "escrow"
  };
}

export class EscrowBillingProvider implements ComputeBillingProvider {
  readonly mode = "escrow" as const;

  async readRunwayBalanceUsdc(snapshot: { escrowUsdc: bigint }) {
    return {
      creditBalanceUsdc: snapshot.escrowUsdc,
      fundingSource: "escrow" as const
    };
  }

  buildTopupTransferCall(config: AgentConfig, amountUsdc: bigint) {
    return callTransfer(config.usdcAddress, config.escrowAddress, amountUsdc);
  }

  transferSpec(kind: BillingTransferKind): BillingTransferSpec {
    return transferSpec(kind);
  }

  async topUpCredits(amountUsdc: bigint, _reason: string): Promise<ComputeBillingTopupResult> {
    return {
      status: "skipped",
      amountUsdc,
      summary: "Escrow billing mode does not support x402 credit topups"
    };
  }
}
