import type { AgentConfig } from "../config";
import { AlchemyBillingProvider } from "./alchemyProvider";
import { ConwayBillingProvider } from "./conwayProvider";
import { EscrowBillingProvider } from "./escrowProvider";
import type { ComputeBillingProvider } from "./types";

export function createComputeBillingProvider(config: AgentConfig): ComputeBillingProvider {
  if (config.computeBillingMode === "escrow") {
    return new EscrowBillingProvider();
  }
  if (config.computeBillingMode === "alchemy") {
    return new AlchemyBillingProvider(config);
  }
  return new ConwayBillingProvider(config);
}

export { EscrowBillingProvider } from "./escrowProvider";
export { ConwayBillingProvider } from "./conwayProvider";
export { AlchemyBillingProvider } from "./alchemyProvider";
export type {
  ComputeBillingProvider,
  BillingTransferKind,
  BillingTransferSpec,
  ComputeBillingSnapshot,
  ComputeBillingTopupResult
} from "./types";
