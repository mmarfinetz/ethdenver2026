import type { AgentConfig } from "../config";
import { ConwayBillingProvider } from "./conwayProvider";
import { EscrowBillingProvider } from "./escrowProvider";
import type { ComputeBillingProvider } from "./types";

export function createComputeBillingProvider(config: AgentConfig): ComputeBillingProvider {
  if (config.computeBillingMode === "escrow") {
    return new EscrowBillingProvider();
  }
  return new ConwayBillingProvider(config);
}

export { EscrowBillingProvider } from "./escrowProvider";
export { ConwayBillingProvider } from "./conwayProvider";
export type {
  ComputeBillingProvider,
  BillingTransferKind,
  BillingTransferSpec,
  ComputeBillingSnapshot,
  ComputeBillingTopupResult
} from "./types";
