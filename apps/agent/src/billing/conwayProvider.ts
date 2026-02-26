import { callTransfer } from "../aave";
import type { AgentConfig } from "../config";
import type { BillingTransferKind, BillingTransferSpec, ComputeBillingProvider, ComputeBillingTopupResult } from "./types";
import type { Address, Hex } from "viem";
import { isAddress, parseUnits } from "viem";
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
  x402V2Requirement?: X402V2Requirement;
};

type X402V2Requirement = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payToAddress: Address;
  usdcAddress: Address;
  requiredDeadlineSeconds: number;
  x402Version: number;
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

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function chainIdFromNetwork(network: string): number | null {
  const normalized = network.trim().toLowerCase();
  const match = /^eip155:(\d+)$/.exec(normalized);
  if (match) return Number(match[1]);
  if (normalized === "base") return 8453;
  if (normalized === "base-sepolia") return 84532;
  return null;
}

function parseX402AmountBaseUnits(maxAmountRequired: string, x402Version: number): bigint | null {
  const amount = maxAmountRequired.trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  try {
    if (amount.includes(".")) {
      return parseUnits(amount, 6);
    }
    if (x402Version >= 2 || amount.length > 6) {
      return BigInt(amount);
    }
    return parseUnits(amount, 6);
  } catch {
    return null;
  }
}

function randomBytes32Hex(): Hex {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

function extractX402V2Requirement(value: unknown): X402V2Requirement | null {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.accepts)) return null;

  const x402Version = asPositiveInteger(root.x402Version) ?? 1;
  for (const candidate of root.accepts) {
    const requirement = asRecord(candidate);
    if (!requirement) continue;

    const scheme = typeof requirement.scheme === "string" ? requirement.scheme : null;
    const networkRaw = typeof requirement.network === "string" ? requirement.network : null;
    const payToAddress = asAddress(requirement.payToAddress) ?? asAddress(requirement.payTo);
    const usdcAddress = asAddress(requirement.usdcAddress) ?? asAddress(requirement.asset);
    const maxAmountRequiredRaw = requirement.maxAmountRequired;
    const maxAmountRequired =
      typeof maxAmountRequiredRaw === "string"
        ? maxAmountRequiredRaw
        : typeof maxAmountRequiredRaw === "number" && Number.isFinite(maxAmountRequiredRaw)
          ? String(maxAmountRequiredRaw)
          : null;
    const requiredDeadlineSeconds =
      asPositiveInteger(requirement.requiredDeadlineSeconds) ?? asPositiveInteger(requirement.maxTimeoutSeconds) ?? 300;

    if (!scheme || !networkRaw || !payToAddress || !usdcAddress || !maxAmountRequired) {
      continue;
    }

    return {
      scheme,
      network: networkRaw,
      maxAmountRequired,
      payToAddress,
      usdcAddress,
      requiredDeadlineSeconds,
      x402Version
    };
  }

  return null;
}

function buildTransferRequirementFromX402V2(
  config: AgentConfig,
  payerAddress: Address,
  requirement: X402V2Requirement
): TransferWithAuthorizationRequirement | null {
  const value = parseX402AmountBaseUnits(requirement.maxAmountRequired, requirement.x402Version);
  if (value === null) return null;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now > 60n ? now - 60n : 0n;
  const validBefore = now + BigInt(requirement.requiredDeadlineSeconds);
  const chainId = chainIdFromNetwork(requirement.network) ?? config.chainId;

  return {
    to: requirement.payToAddress,
    value,
    validAfter,
    validBefore,
    nonce: randomBytes32Hex(),
    token: requirement.usdcAddress,
    chainId,
    from: payerAddress
  };
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

const USDC_UNITS_PER_USD = 1_000_000n;
const DEFAULT_TOPUP_TIERS_USD = [5n, 25n, 100n, 500n, 1000n, 2500n] as const;

function uniqueSortedBigInts(values: bigint[]): bigint[] {
  const unique = Array.from(new Set(values.map((value) => value.toString()))).map((value) => BigInt(value));
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return unique;
}

function extractTopupTiersUsd(payload: unknown): bigint[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.tiers)) return [];

  const tiers: bigint[] = [];
  for (const entry of root.tiers) {
    const tier = asRecord(entry);
    if (!tier) continue;

    const amount = asBigInt(tier.amount);
    if (amount !== null && amount > 0n) {
      tiers.push(amount);
      continue;
    }

    const usdc = asBigInt(tier.usdc);
    if (usdc !== null && usdc >= USDC_UNITS_PER_USD) {
      tiers.push(usdc / USDC_UNITS_PER_USD);
      continue;
    }

    const cents = asBigInt(tier.cents);
    if (cents !== null && cents >= 100n) {
      tiers.push(cents / 100n);
    }
  }

  return uniqueSortedBigInts(tiers);
}

function chooseTopupTierUsd(amountUsdc: bigint, tiersUsd: readonly bigint[]): bigint | null {
  if (amountUsdc < USDC_UNITS_PER_USD) return null;
  const requestedUsd = amountUsdc / USDC_UNITS_PER_USD;
  let chosen: bigint | null = null;
  for (const tier of tiersUsd) {
    if (tier <= 0n || tier > requestedUsd) continue;
    if (chosen === null || tier > chosen) {
      chosen = tier;
    }
  }
  return chosen;
}

function isPayTopupPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("{amount") || normalized.includes("{recipient") || normalized.includes("{address")) return true;
  return normalized === "/pay" || normalized.endsWith("/pay") || normalized.includes("/pay/");
}

function buildPayTopupPath(path: string, amountUsd: bigint, recipientAddress: Address): string {
  const normalizedInput = path.trim();
  const template = normalizedInput.length > 0 ? normalizedInput : "/pay";
  const withPlaceholders = template
    .replace(/\{amount(?:usd)?\}/gi, amountUsd.toString())
    .replace(/\{recipient(?:address)?\}/gi, recipientAddress)
    .replace(/\{address\}/gi, recipientAddress);

  if (withPlaceholders !== template) {
    return withPlaceholders;
  }

  const basePath =
    withPlaceholders.length > 1 && withPlaceholders.endsWith("/")
      ? withPlaceholders.slice(0, -1)
      : withPlaceholders;
  if (basePath.length === 0 || basePath === "/") {
    return `/pay/${amountUsd.toString()}/${recipientAddress}`;
  }
  if (/\/pay$/i.test(basePath)) {
    return `${basePath}/${amountUsd.toString()}/${recipientAddress}`;
  }
  return basePath;
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

function extractConwayWalletAddress(payload: unknown): Address | null {
  const root = asRecord(payload);
  if (!root) return null;

  const user = asRecord(root.user);
  return (
    asAddress(user?.wallet_address) ??
    asAddress(user?.walletAddress) ??
    asAddress(root.wallet_address) ??
    asAddress(root.walletAddress)
  );
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
  const header =
    response.headers.get("x-payment-requirements") ??
    response.headers.get("x-payment-required") ??
    response.headers.get("X-Payment-Required");
  if (header && header !== "true") {
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
  const x402V2Requirement = extractX402V2Requirement(payload) ?? extractX402V2Requirement(normalized);

  if (!typedData && !transferRequirement && !x402V2Requirement) {
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
    transferWithAuthorization: transferRequirement ?? undefined,
    x402V2Requirement: x402V2Requirement ?? undefined
  };
}

function createLegacyPaymentHeaderValue(
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

function createV2PaymentHeaderValue(
  requirement: X402V2Requirement,
  from: Address,
  signature: Hex,
  transferWithAuthorization: TransferWithAuthorizationRequirement
): string {
  const payload = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from,
        to: transferWithAuthorization.to,
        value: transferWithAuthorization.value.toString(),
        validAfter: transferWithAuthorization.validAfter.toString(),
        validBefore: transferWithAuthorization.validBefore.toString(),
        nonce: transferWithAuthorization.nonce
      }
    }
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
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
  const transferWithAuthorization =
    challenge.transferWithAuthorization ??
    (challenge.x402V2Requirement
      ? buildTransferRequirementFromX402V2(config, account.address, challenge.x402V2Requirement)
      : null);
  if (!transferWithAuthorization) return first;

  const typedData =
    challenge.typedData ?? buildTransferWithAuthorizationTypedData(config, account.address, transferWithAuthorization);
  if (!typedData) return first;

  const signature = await account.signTypedData(typedData as never);
  const paymentHeaderValue = challenge.x402V2Requirement
    ? createV2PaymentHeaderValue(challenge.x402V2Requirement, account.address, signature, transferWithAuthorization)
    : createLegacyPaymentHeaderValue(challenge, account.address, signature, typedData);

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set(challenge.paymentHeaderName, paymentHeaderValue);

  return fetch(url, {
    ...init,
    headers: retryHeaders
  });
}

export class ConwayBillingProvider implements ComputeBillingProvider {
  readonly mode = "conway" as const;
  private cachedTopupTiersUsd: bigint[] | null = null;
  private cachedCreditsRecipientAddress: Address | null = null;

  constructor(private readonly config: AgentConfig) {
    if (!config.conwayApiBaseUrl) {
      throw new Error("CONWAY_API_BASE_URL is required when COMPUTE_BILLING_MODE=conway");
    }
  }

  private async resolveCreditsRecipientAddress(): Promise<Address> {
    if (this.cachedCreditsRecipientAddress) {
      return this.cachedCreditsRecipientAddress;
    }

    const fallbackRecipient = this.config.conwayPayerAddress ?? this.config.conwayPaymentRecipientAddress ?? this.config.escrowAddress;
    if (!this.config.conwayApiKey) {
      this.cachedCreditsRecipientAddress = fallbackRecipient;
      return fallbackRecipient;
    }

    try {
      const whoamiUrl = new URL("/v1/auth/me", this.config.conwayApiBaseUrl).toString();
      const response = await fetch(whoamiUrl, {
        method: "GET",
        headers: authHeaders(this.config.conwayApiKey)
      });
      if (response.ok) {
        const payload = await readJson(response);
        const discoveredRecipient = extractConwayWalletAddress(payload);
        if (discoveredRecipient) {
          this.cachedCreditsRecipientAddress = discoveredRecipient;
          return discoveredRecipient;
        }
      }
    } catch {
      // Fall back to configured recipient.
    }

    this.cachedCreditsRecipientAddress = fallbackRecipient;
    return fallbackRecipient;
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
    const configuredTopupPath = this.config.conwayCreditsTopupPath.trim();
    const configuredIsPayPath = isPayTopupPath(configuredTopupPath);

    if (this.cachedTopupTiersUsd === null) {
      this.cachedTopupTiersUsd = [...DEFAULT_TOPUP_TIERS_USD];
      try {
        const pricingUrl = new URL("/v1/credits/pricing", this.config.conwayApiBaseUrl).toString();
        const response = await fetch(pricingUrl, {
          method: "GET",
          headers
        });
        if (response.ok) {
          const payload = await readJson(response);
          const extracted = extractTopupTiersUsd(payload);
          if (extracted.length > 0) {
            this.cachedTopupTiersUsd = extracted;
          }
        }
      } catch {
        // Keep fallback tiers.
      }
    }

    const topupTiersUsd = this.cachedTopupTiersUsd;
    const selectedTierUsd = chooseTopupTierUsd(amountUsdc, topupTiersUsd);
    const minimumTierUsd = topupTiersUsd[0] ?? DEFAULT_TOPUP_TIERS_USD[0];
    const recipientAddress = await this.resolveCreditsRecipientAddress();

    type TopupRequest = {
      url: string;
      init: RequestInit;
      expectedUsdc: bigint;
    };

    const requests: TopupRequest[] = [];

    const legacyHeaders = new Headers(headers);
    legacyHeaders.set("content-type", "application/json");
    const legacyTopupUrl = new URL(configuredTopupPath, this.config.conwayApiBaseUrl).toString();
    const legacyRequest: TopupRequest = {
      url: legacyTopupUrl,
      expectedUsdc: amountUsdc,
      init: {
        method: "POST",
        headers: legacyHeaders,
        body: JSON.stringify({
          amountUsdc: amountUsdc.toString(),
          reason
        })
      }
    };

    const canBuildPayRequest = selectedTierUsd !== null && selectedTierUsd >= minimumTierUsd;
    if (configuredIsPayPath) {
      if (!canBuildPayRequest) {
        return makeTopupResult(
          "skipped",
          0n,
          `Requested topup is below minimum Conway pay tier (${minimumTierUsd.toString()} USDC)`
        );
      }

      const payPath = buildPayTopupPath(configuredTopupPath, selectedTierUsd, recipientAddress);
      requests.push({
        url: new URL(payPath, this.config.conwayApiBaseUrl).toString(),
        expectedUsdc: selectedTierUsd * USDC_UNITS_PER_USD,
        init: {
          method: "GET",
          headers
        }
      });
    } else {
      requests.push(legacyRequest);
      if (canBuildPayRequest) {
        const payPath = buildPayTopupPath("/pay", selectedTierUsd, recipientAddress);
        requests.push({
          url: new URL(payPath, this.config.conwayApiBaseUrl).toString(),
          expectedUsdc: selectedTierUsd * USDC_UNITS_PER_USD,
          init: {
            method: "GET",
            headers
          }
        });
      }
    }

    let lastError = "Conway topup failed";
    try {
      for (let i = 0; i < requests.length; i += 1) {
        const request = requests[i];
        const response = await fetchWithX402Retry(this.config, request.url, request.init);
        if (!response.ok) {
          const body = await readText(response);
          lastError = `Conway topup API error ${response.status}: ${body.slice(0, 200)}`;
          const hasFallback = i < requests.length - 1;
          if (response.status === 404 && hasFallback) {
            continue;
          }
          return makeTopupResult("error", amountUsdc, lastError);
        }

        const payload = await readJson(response);
        const creditedUsdc = extractTopupUsdc(payload) ?? request.expectedUsdc;
        return makeTopupResult("ok", creditedUsdc, `Conway x402 topup succeeded for ${creditedUsdc.toString()} usdc units`);
      }
      return makeTopupResult("error", amountUsdc, lastError);
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
