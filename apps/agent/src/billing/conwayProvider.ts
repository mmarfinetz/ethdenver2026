import { callTransfer } from "../aave";
import type { AgentConfig } from "../config";
import type { BillingTransferKind, BillingTransferSpec, ComputeBillingProvider, ComputeBillingTopupResult } from "./types";
import type { Address, Hex } from "viem";
import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type JsonRecord = Record<string, unknown>;

type Eip3009TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

type TransferWithAuthorizationRequirement = {
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  token?: Address;
  chainId?: number;
  from?: Address;
};

type X402Challenge = {
  paymentHeaderName: string;
  requirementId?: string;
  typedData?: Eip3009TypedData;
  transferWithAuthorization?: TransferWithAuthorizationRequirement;
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function centsToUsdcUnits(value: unknown): bigint | null {
  const cents = asBigInt(value);
  if (cents === null) return null;
  // Conway may return credit balances in USD cents.
  // Convert cents -> USDC base units (6 decimals).
  return cents * 10_000n;
}

function coalesceBigInt(values: unknown[]): bigint | null {
  for (const value of values) {
    const parsed = asBigInt(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function asAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  return isAddress(value) ? (value as Address) : null;
}

function isBytes32Hex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function transferSpec(_kind: BillingTransferKind): BillingTransferSpec {
  if (_kind === "harvest") {
    return {
      decision: "fund-escrow",
      recipientLabel: "Conway payer wallet"
    };
  }

  return {
    decision: "pay-escrow",
    recipientLabel: "Conway payer wallet"
  };
}

function makeTopupResult(status: ComputeBillingTopupResult["status"], amountUsdc: bigint, summary: string): ComputeBillingTopupResult {
  return { status, amountUsdc, summary };
}

function authHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function extractBalanceUsdc(payload: unknown): bigint | null {
  const root = asRecord(payload);
  if (!root) return null;

  const credits = asRecord(root.credits);
  const data = asRecord(root.data);

  return coalesceBigInt([
    root.balanceUsdc,
    root.balance,
    credits?.balanceUsdc,
    credits?.balance,
    data?.balanceUsdc,
    data?.balance
  ]) ?? coalesceBigInt([
    centsToUsdcUnits(root.credits_cents),
    centsToUsdcUnits(root.balance_cents),
    centsToUsdcUnits(credits?.cents),
    centsToUsdcUnits(data?.credits_cents),
    centsToUsdcUnits(data?.balance_cents)
  ]);
}

function extractTopupUsdc(payload: unknown): bigint | null {
  const root = asRecord(payload);
  if (!root) return null;

  const topup = asRecord(root.topup);
  const data = asRecord(root.data);

  return coalesceBigInt([
    root.amountUsdc,
    root.creditedUsdc,
    topup?.amountUsdc,
    topup?.creditedUsdc,
    data?.amountUsdc,
    data?.creditedUsdc
  ]) ?? coalesceBigInt([
    centsToUsdcUnits(root.credited_cents),
    centsToUsdcUnits(root.amount_cents),
    centsToUsdcUnits(topup?.credited_cents),
    centsToUsdcUnits(data?.credited_cents)
  ]);
}

function extractTransferRequirement(value: unknown): TransferWithAuthorizationRequirement | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const to = asAddress(payload.to);
  const amount = asBigInt(payload.value);
  const validAfter = asBigInt(payload.validAfter);
  const validBefore = asBigInt(payload.validBefore);
  const nonce = isBytes32Hex(payload.nonce) ? payload.nonce : null;

  if (!to || amount === null || validAfter === null || validBefore === null || !nonce) {
    return null;
  }

  return {
    to,
    value: amount,
    validAfter,
    validBefore,
    nonce,
    token: asAddress(payload.token) ?? undefined,
    chainId: typeof payload.chainId === "number" ? payload.chainId : undefined,
    from: asAddress(payload.from) ?? undefined
  };
}

function extractTypedData(value: unknown): Eip3009TypedData | null {
  const payload = asRecord(value);
  if (!payload) return null;

  const domain = asRecord(payload.domain);
  const rawTypes = asRecord(payload.types);
  const message = asRecord(payload.message);
  const primaryType = typeof payload.primaryType === "string" ? payload.primaryType : "";

  if (!domain || !rawTypes || !message || primaryType.length === 0) return null;

  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, value] of Object.entries(rawTypes)) {
    if (!Array.isArray(value)) continue;
    const entries = value
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry))
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        type: typeof entry.type === "string" ? entry.type : ""
      }))
      .filter((entry) => entry.name.length > 0 && entry.type.length > 0);
    if (entries.length > 0) {
      types[key] = entries;
    }
  }

  if (Object.keys(types).length === 0) return null;

  return {
    domain,
    types,
    primaryType,
    message
  };
}

function extractX402Payload(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  if (!root) return null;

  const x402 = asRecord(root.x402);
  if (x402) return x402;

  const paymentRequirements = root.paymentRequirements;
  if (Array.isArray(paymentRequirements) && paymentRequirements.length > 0) {
    const first = asRecord(paymentRequirements[0]);
    if (first) return first;
  }

  const single = asRecord(paymentRequirements);
  if (single) return single;

  return root;
}

function buildTransferWithAuthorizationTypedData(
  config: AgentConfig,
  payerAddress: Address,
  requirement: TransferWithAuthorizationRequirement
): Eip3009TypedData {
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: requirement.chainId ?? config.chainId,
      verifyingContract: requirement.token ?? config.usdcAddress
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }
      ]
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: requirement.from ?? payerAddress,
      to: requirement.to,
      value: requirement.value,
      validAfter: requirement.validAfter,
      validBefore: requirement.validBefore,
      nonce: requirement.nonce
    }
  };
}

async function parseChallenge(response: Response, defaultHeaderName: string): Promise<X402Challenge | null> {
  let payload: unknown = null;
  const header = response.headers.get("x-payment-requirements");
  if (header) {
    try {
      payload = JSON.parse(header) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!payload) {
    payload = await readJson(response.clone());
  }

  const normalized = extractX402Payload(payload);
  if (!normalized) return null;

  const typedData = extractTypedData(normalized.typedData);
  const transferRequirement = extractTransferRequirement(
    asRecord(normalized.transferWithAuthorization) ??
      asRecord(normalized.transfer_with_authorization) ??
      asRecord(normalized.transfer)
  );

  if (!typedData && !transferRequirement) {
    return null;
  }

  const paymentHeaderName =
    (typeof normalized.paymentHeaderName === "string" && normalized.paymentHeaderName) ||
    (typeof normalized.paymentHeader === "string" && normalized.paymentHeader) ||
    defaultHeaderName;

  return {
    paymentHeaderName,
    requirementId: typeof normalized.requirementId === "string" ? normalized.requirementId : undefined,
    typedData: typedData ?? undefined,
    transferWithAuthorization: transferRequirement ?? undefined
  };
}

function createPaymentHeaderValue(
  challenge: X402Challenge,
  from: Address,
  signature: Hex,
  typedData: Eip3009TypedData
): string {
  const payload = {
    type: "eip3009",
    requirementId: challenge.requirementId,
    from,
    signature,
    typedData
  };
  return Buffer.from(
    JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    "utf8"
  ).toString("base64");
}

async function fetchWithX402Retry(config: AgentConfig, url: string, init: RequestInit): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;

  if (!config.conwayX402Enabled || !config.conwayPayerPrivateKey) {
    return first;
  }

  const challenge = await parseChallenge(first, config.conwayX402HeaderName);
  if (!challenge) return first;

  const account = privateKeyToAccount(config.conwayPayerPrivateKey);
  const typedData = challenge.typedData ?? (
    challenge.transferWithAuthorization
      ? buildTransferWithAuthorizationTypedData(config, account.address, challenge.transferWithAuthorization)
      : null
  );
  if (!typedData) return first;

  const signature = await account.signTypedData(typedData as never);
  const paymentHeaderValue = createPaymentHeaderValue(challenge, account.address, signature, typedData);

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set(challenge.paymentHeaderName, paymentHeaderValue);

  return fetch(url, {
    ...init,
    headers: retryHeaders
  });
}

export class ConwayBillingProvider implements ComputeBillingProvider {
  readonly mode = "conway" as const;

  constructor(private readonly config: AgentConfig) {
    if (!config.conwayApiBaseUrl) {
      throw new Error("CONWAY_API_BASE_URL is required when COMPUTE_BILLING_MODE=conway");
    }
  }

  transferSpec(kind: BillingTransferKind): BillingTransferSpec {
    return transferSpec(kind);
  }

  buildTopupTransferCall(config: AgentConfig, amountUsdc: bigint) {
    const recipient = config.conwayPayerAddress ?? config.conwayPaymentRecipientAddress ?? config.escrowAddress;
    return callTransfer(config.usdcAddress, recipient, amountUsdc);
  }

  async readRunwayBalanceUsdc(snapshot: { escrowUsdc: bigint }) {
    const balanceUrl = new URL(this.config.conwayCreditsBalancePath, this.config.conwayApiBaseUrl).toString();

    try {
      const response = await fetch(balanceUrl, {
        method: "GET",
        headers: authHeaders(this.config.conwayApiKey)
      });
      if (!response.ok) {
        const body = await readText(response);
        throw new Error(`Conway balance API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = await readJson(response);
      const balanceUsdc = extractBalanceUsdc(payload);
      if (balanceUsdc === null) {
        throw new Error("Conway balance payload missing recognized balance field");
      }

      return {
        creditBalanceUsdc: balanceUsdc,
        fundingSource: "conway-credits" as const
      };
    } catch (error) {
      if (!this.config.conwayFallbackToEscrowOnError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[billing] Conway balance unavailable (${message}); falling back to escrow balance for runway`);
      return {
        creditBalanceUsdc: snapshot.escrowUsdc,
        fundingSource: "escrow-fallback" as const,
        fallbackWarning: `Conway balance unavailable (${message}); using escrow balance`
      };
    }
  }

  async topUpCredits(amountUsdc: bigint, reason: string): Promise<ComputeBillingTopupResult> {
    if (amountUsdc <= 0n) {
      return makeTopupResult("skipped", amountUsdc, "Requested topup amount is zero");
    }
    if (!this.config.conwayApiBaseUrl) {
      return makeTopupResult("error", amountUsdc, "CONWAY_API_BASE_URL is not configured");
    }

    const headers = authHeaders(this.config.conwayApiKey);
    headers.set("content-type", "application/json");

    const topupUrl = new URL(this.config.conwayCreditsTopupPath, this.config.conwayApiBaseUrl).toString();
    try {
      const response = await fetchWithX402Retry(this.config, topupUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amountUsdc: amountUsdc.toString(),
          reason
        })
      });

      if (!response.ok) {
        const body = await readText(response);
        return makeTopupResult("error", amountUsdc, `Conway topup API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = await readJson(response);
      const creditedUsdc = extractTopupUsdc(payload) ?? amountUsdc;
      return makeTopupResult("ok", creditedUsdc, `Conway x402 topup succeeded for ${creditedUsdc.toString()} usdc units`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeTopupResult("error", amountUsdc, `Conway topup failed: ${message}`);
    }
  }
}

export const __test = {
  asBigInt,
  extractTransferRequirement,
  extractTypedData,
  extractX402Payload,
  buildTransferWithAuthorizationTypedData
};
