import type { AgentConfig } from "../config";
import { ConwayBillingProvider } from "./conwayProvider";
import type {
  BillingTransferKind,
  BillingTransferSpec,
  ComputeBillingProvider,
  ComputeBillingRunwayStatus,
  ComputeBillingSnapshot,
  ComputeBillingTopupResult
} from "./types";

function relabel(message: string): string {
  return message.replaceAll("Conway", "Alchemy").replaceAll("conway", "alchemy");
}

export class AlchemyBillingProvider implements ComputeBillingProvider {
  readonly mode = "alchemy" as const;
  private readonly delegate: ConwayBillingProvider;

  constructor(config: AgentConfig) {
    this.delegate = new ConwayBillingProvider(config);
  }

  transferSpec(kind: BillingTransferKind): BillingTransferSpec {
    if (kind === "harvest") {
      return {
        decision: "fund-escrow",
        recipientLabel: "Alchemy payer wallet"
      };
    }

    return {
      decision: "pay-escrow",
      recipientLabel: "Alchemy payer wallet"
    };
  }

  buildTopupTransferCall(config: AgentConfig, amountUsdc: bigint) {
    return this.delegate.buildTopupTransferCall(config, amountUsdc);
  }

  async readRunwayBalanceUsdc(snapshot: ComputeBillingSnapshot): Promise<ComputeBillingRunwayStatus> {
    const result = await this.delegate.readRunwayBalanceUsdc(snapshot);
    return {
      ...result,
      fundingSource: result.fundingSource === "conway-credits" ? "alchemy-credits" : result.fundingSource,
      fallbackWarning: result.fallbackWarning ? relabel(result.fallbackWarning) : result.fallbackWarning
    };
  }

  async topUpCredits(amountUsdc: bigint, reason: string): Promise<ComputeBillingTopupResult> {
    const result = await this.delegate.topUpCredits(amountUsdc, reason);
    return {
      ...result,
      summary: relabel(result.summary)
    };
  }
}
