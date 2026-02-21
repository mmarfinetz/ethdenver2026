import { parseAddress } from "@ssa/shared/utils";
import type { Address, Hex } from "viem";
import type { AgentConfig } from "./config";

export type SwapQuote = {
  to: Address;
  data: Hex;
  value: bigint;
  allowanceTarget: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  minBuyAmount?: bigint;
  estimatedGas?: bigint;
  source: "0x";
};

export type QuoteParams = {
  sellToken: Address;
  buyToken: Address;
  taker: Address;
  slippageBps: number;
  buyAmount?: bigint;
  sellAmount?: bigint;
};

function pickAllowanceTarget(payload: Record<string, unknown>): string {
  if (typeof payload.allowanceTarget === "string") return payload.allowanceTarget;

  const issues = payload.issues as Record<string, unknown> | undefined;
  const allowance = issues?.allowance as Record<string, unknown> | undefined;
  const spender = allowance?.spender;

  if (typeof spender === "string") return spender;

  throw new Error("0x quote missing allowance target");
}

function pickTransactionField(payload: Record<string, unknown>, field: "to" | "data" | "value"): unknown {
  if (payload[field] != null) return payload[field];

  const tx = payload.transaction as Record<string, unknown> | undefined;
  return tx?.[field];
}

export async function getSwapQuote(config: AgentConfig, params: QuoteParams): Promise<SwapQuote> {
  const url = new URL(config.zrxApiUrl);
  url.searchParams.set("chainId", String(config.chainId));
  url.searchParams.set("sellToken", params.sellToken);
  url.searchParams.set("buyToken", params.buyToken);
  url.searchParams.set("taker", params.taker);
  url.searchParams.set("slippageBps", String(params.slippageBps));

  if (params.buyAmount && params.sellAmount) {
    throw new Error("Provide either buyAmount or sellAmount, not both");
  }
  if (!params.buyAmount && !params.sellAmount) {
    throw new Error("buyAmount or sellAmount is required for quote");
  }

  if (params.buyAmount) url.searchParams.set("buyAmount", params.buyAmount.toString());
  if (params.sellAmount) url.searchParams.set("sellAmount", params.sellAmount.toString());

  const headers: Record<string, string> = {
    accept: "application/json",
    "0x-version": "v2"
  };

  if (config.zrxApiKey) headers["0x-api-key"] = config.zrxApiKey;

  const response = await fetch(url, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`0x quote error (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  if (payload.liquidityAvailable === false) {
    throw new Error("0x quote reports no liquidity");
  }

  const to = parseAddress(String(pickTransactionField(payload, "to")), "0x.to");
  const allowanceTarget = parseAddress(pickAllowanceTarget(payload), "0x.allowanceTarget");
  const data = pickTransactionField(payload, "data");
  const value = pickTransactionField(payload, "value");

  return {
    to,
    allowanceTarget,
    data: String(data) as Hex,
    value: BigInt(String(value ?? "0")),
    sellAmount: BigInt(String(payload.sellAmount ?? "0")),
    buyAmount: BigInt(String(payload.buyAmount ?? "0")),
    minBuyAmount: payload.minBuyAmount ? BigInt(String(payload.minBuyAmount)) : undefined,
    estimatedGas: payload.gas ? BigInt(String(payload.gas)) : undefined,
    source: "0x"
  };
}

export function quoteSwapCostUsd(
  sellAmountUsd: bigint,
  buyAmountUsd: bigint
): bigint {
  if (sellAmountUsd <= buyAmountUsd) return 0n;
  return sellAmountUsd - buyAmountUsd;
}
