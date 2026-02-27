import "dotenv/config";

import { erc20Abi } from "@ssa/shared/abis";
import { BASE_MAINNET_CHAIN_ID, CHAIN_DEFAULTS, USDC_DECIMALS } from "@ssa/shared/constants";
import {
  assertBaseChain,
  formatToken,
  mustEnv,
  optionalEnv,
  parseAddress,
  parseDecimalToUnits,
  parseInteger
} from "@ssa/shared/utils";
import { exec as execWithCallback } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Address, Chain, PublicClient } from "viem";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

const exec = promisify(execWithCallback);

export type ComputeBillingMode = "escrow" | "conway" | "alchemy";

export type WatcherConfig = {
  chainId: number;
  allowTestnet: boolean;
  computeBillingMode: ComputeBillingMode;
  rpcUrl: string;
  usdcAddress: Address;
  usdcDecimals: number;
  escrowAddress: Address;
  watchIntervalSeconds: number;
  failureThreshold: number;
  lowBalanceGraceChecks: number;
  lowCreditsGraceChecks: number;
  lowPayerGraceChecks: number;
  minEscrowBalanceUsdc: bigint;
  minConwayCreditsBalanceUsdc: bigint;
  minConwayPayerBalanceUsdc: bigint;
  conwayApiBaseUrl?: string;
  conwayApiKey?: string;
  conwayCreditsBalancePath: string;
  conwayPayerAddress?: Address;
  conwayFallbackToEscrowOnError: boolean;
  shutdownCommand: string;
};

type JsonRecord = Record<string, unknown>;

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function firstSetOptionalEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalEnv(key);
    if (value) return value;
  }
  return undefined;
}

function resolveChain(chainId: number): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return {
    ...base,
    id: chainId,
    name: `Custom Base-like ${chainId}`,
    rpcUrls: {
      default: {
        http: [""]
      },
      public: {
        http: [""]
      }
    }
  } as Chain;
}

function optionalAddress(raw: string | undefined, label: string): Address | undefined {
  if (!raw?.trim()) return undefined;
  return parseAddress(raw.trim(), label);
}

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
  return cents * 10_000n;
}

function coalesceBigInt(values: unknown[]): bigint | null {
  for (const value of values) {
    const parsed = asBigInt(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractConwayBalanceUsdc(payload: unknown): bigint | null {
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

export function loadWatcherConfig(): WatcherConfig {
  const chainId = parseInteger(process.env.CHAIN_ID ?? String(BASE_MAINNET_CHAIN_ID), "CHAIN_ID");
  const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[BASE_MAINNET_CHAIN_ID];
  const computeBillingModeRaw = (process.env.COMPUTE_BILLING_MODE ?? "escrow").trim().toLowerCase();
  if (computeBillingModeRaw !== "escrow" && computeBillingModeRaw !== "conway" && computeBillingModeRaw !== "alchemy") {
    throw new Error(`COMPUTE_BILLING_MODE must be escrow|conway|alchemy, got ${computeBillingModeRaw}`);
  }
  const computeBillingMode = computeBillingModeRaw as ComputeBillingMode;
  const providerApiBaseUrlEnvLabel = computeBillingMode === "alchemy" ? "ALCHEMY_API_BASE_URL" : "CONWAY_API_BASE_URL";
  const providerPayerAddressEnvLabel = computeBillingMode === "alchemy" ? "ALCHEMY_PAYER_ADDRESS" : "CONWAY_PAYER_ADDRESS";
  const providerApiBaseUrlKeys =
    computeBillingMode === "alchemy" ? ["ALCHEMY_API_BASE_URL", "CONWAY_API_BASE_URL"] : ["CONWAY_API_BASE_URL"];
  const providerApiKeyKeys =
    computeBillingMode === "alchemy" ? ["ALCHEMY_API_KEY", "CONWAY_API_KEY"] : ["CONWAY_API_KEY"];
  const providerCreditsBalancePathKeys =
    computeBillingMode === "alchemy"
      ? ["ALCHEMY_CREDITS_BALANCE_PATH", "CONWAY_CREDITS_BALANCE_PATH"]
      : ["CONWAY_CREDITS_BALANCE_PATH"];
  const providerPayerAddressKeys =
    computeBillingMode === "alchemy" ? ["ALCHEMY_PAYER_ADDRESS", "CONWAY_PAYER_ADDRESS"] : ["CONWAY_PAYER_ADDRESS"];
  const providerFallbackToEscrowOnErrorKeys =
    computeBillingMode === "alchemy"
      ? ["ALCHEMY_FALLBACK_TO_ESCROW_ON_ERROR", "CONWAY_FALLBACK_TO_ESCROW_ON_ERROR"]
      : ["CONWAY_FALLBACK_TO_ESCROW_ON_ERROR"];

  const watchIntervalSeconds = parseInteger(process.env.WATCH_INTERVAL_SECONDS ?? "300", "WATCH_INTERVAL_SECONDS");
  const failureThreshold = parseInteger(process.env.WATCH_FAILURE_THRESHOLD ?? "3", "WATCH_FAILURE_THRESHOLD");
  const lowBalanceGraceChecks = parseInteger(
    process.env.WATCH_LOW_BALANCE_GRACE_CHECKS ?? "0",
    "WATCH_LOW_BALANCE_GRACE_CHECKS"
  );
  const lowCreditsGraceChecks = parseInteger(
    process.env.WATCH_LOW_CREDITS_GRACE_CHECKS ?? String(lowBalanceGraceChecks),
    "WATCH_LOW_CREDITS_GRACE_CHECKS"
  );
  const lowPayerGraceChecks = parseInteger(
    process.env.WATCH_LOW_PAYER_GRACE_CHECKS ?? String(lowBalanceGraceChecks),
    "WATCH_LOW_PAYER_GRACE_CHECKS"
  );
  const usdcDecimals = parseInteger(process.env.USDC_DECIMALS ?? String(USDC_DECIMALS), "USDC_DECIMALS");
  const conwayApiBaseUrl = firstSetOptionalEnv(providerApiBaseUrlKeys);
  if ((computeBillingMode === "conway" || computeBillingMode === "alchemy") && !conwayApiBaseUrl) {
    throw new Error(`${providerApiBaseUrlEnvLabel} is required when COMPUTE_BILLING_MODE=${computeBillingMode}`);
  }
  const conwayPayerAddress = optionalAddress(firstSetOptionalEnv(providerPayerAddressKeys), providerPayerAddressEnvLabel);

  if (watchIntervalSeconds <= 0) {
    throw new Error(`WATCH_INTERVAL_SECONDS must be > 0, got ${watchIntervalSeconds}`);
  }
  if (failureThreshold <= 0) {
    throw new Error(`WATCH_FAILURE_THRESHOLD must be > 0, got ${failureThreshold}`);
  }
  if (lowBalanceGraceChecks < 0) {
    throw new Error(`WATCH_LOW_BALANCE_GRACE_CHECKS must be >= 0, got ${lowBalanceGraceChecks}`);
  }
  if (lowCreditsGraceChecks < 0) {
    throw new Error(`WATCH_LOW_CREDITS_GRACE_CHECKS must be >= 0, got ${lowCreditsGraceChecks}`);
  }
  if (lowPayerGraceChecks < 0) {
    throw new Error(`WATCH_LOW_PAYER_GRACE_CHECKS must be >= 0, got ${lowPayerGraceChecks}`);
  }
  if (usdcDecimals <= 0 || usdcDecimals > 255) {
    throw new Error(`USDC_DECIMALS must be between 1 and 255, got ${usdcDecimals}`);
  }
  const minEscrowBalanceUsdc = parseDecimalToUnits(
    process.env.ESCROW_MIN_BALANCE_USDC ?? "0",
    usdcDecimals,
    "ESCROW_MIN_BALANCE_USDC"
  );
  const minConwayCreditsBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_MIN_CREDITS_BALANCE_USDC ?? process.env.ESCROW_MIN_BALANCE_USDC ?? "0",
    usdcDecimals,
    "CONWAY_MIN_CREDITS_BALANCE_USDC"
  );
  const minConwayPayerBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_MIN_PAYER_BALANCE_USDC ?? "0",
    usdcDecimals,
    "CONWAY_MIN_PAYER_BALANCE_USDC"
  );
  if ((computeBillingMode === "conway" || computeBillingMode === "alchemy") && minConwayPayerBalanceUsdc > 0n && !conwayPayerAddress) {
    throw new Error(`${providerPayerAddressEnvLabel} is required when CONWAY_MIN_PAYER_BALANCE_USDC > 0`);
  }

  return {
    chainId,
    allowTestnet: parseBoolean(process.env.ALLOW_TESTNET, false),
    computeBillingMode,
    rpcUrl: mustEnv("BASE_RPC_URL"),
    usdcAddress: optionalAddress(process.env.USDC_ADDRESS, "USDC_ADDRESS") ?? parseAddress(defaults.usdc, "USDC_ADDRESS"),
    usdcDecimals,
    escrowAddress: parseAddress(mustEnv("ESCROW_ADDRESS"), "ESCROW_ADDRESS"),
    watchIntervalSeconds,
    failureThreshold,
    lowBalanceGraceChecks,
    lowCreditsGraceChecks,
    lowPayerGraceChecks,
    minEscrowBalanceUsdc,
    minConwayCreditsBalanceUsdc,
    minConwayPayerBalanceUsdc,
    conwayApiBaseUrl,
    conwayApiKey: firstSetOptionalEnv(providerApiKeyKeys),
    conwayCreditsBalancePath: firstSetOptionalEnv(providerCreditsBalancePathKeys) || "/v1/credits/balance",
    conwayPayerAddress,
    conwayFallbackToEscrowOnError: parseBoolean(firstSetOptionalEnv(providerFallbackToEscrowOnErrorKeys), true),
    shutdownCommand: process.env.SHUTDOWN_COMMAND?.trim() || "systemctl stop ssa-agent"
  };
}

async function readEscrowBalanceUsdc(client: PublicClient, config: WatcherConfig): Promise<bigint> {
  return client.readContract({
    abi: erc20Abi,
    address: config.usdcAddress,
    functionName: "balanceOf",
    args: [config.escrowAddress]
  });
}

async function readConwayBalanceUsdc(config: WatcherConfig): Promise<bigint> {
  const providerLabel = config.computeBillingMode === "alchemy" ? "Alchemy" : "Conway";
  const providerEnvLabel = config.computeBillingMode === "alchemy" ? "ALCHEMY_API_BASE_URL" : "CONWAY_API_BASE_URL";
  if (!config.conwayApiBaseUrl) {
    throw new Error(`${providerEnvLabel} is required when COMPUTE_BILLING_MODE=${config.computeBillingMode}`);
  }

  const balanceUrl = new URL(config.conwayCreditsBalancePath, config.conwayApiBaseUrl).toString();
  const response = await fetch(balanceUrl, {
    method: "GET",
    headers: authHeaders(config.conwayApiKey)
  });
  if (!response.ok) {
    const body = await readText(response);
    throw new Error(`${providerLabel} balance API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = await readJson(response);
  const balanceUsdc = extractConwayBalanceUsdc(payload);
  if (balanceUsdc === null) {
    throw new Error(`${providerLabel} balance payload missing recognized balance field`);
  }
  return balanceUsdc;
}

export type FundingBalanceResult = {
  creditsBalanceUsdc: bigint;
  creditsSource: "escrow" | "conway" | "alchemy";
  payerBalanceUsdc: bigint | null;
  fallbackToEscrow: boolean;
};

export async function readFundingBalanceUsdc(
  client: PublicClient,
  config: WatcherConfig
): Promise<FundingBalanceResult> {
  if (config.computeBillingMode === "escrow") {
    const creditsBalanceUsdc = await readEscrowBalanceUsdc(client, config);
    return { creditsBalanceUsdc, creditsSource: "escrow", payerBalanceUsdc: null, fallbackToEscrow: false };
  }

  const payerBalanceUsdc = config.conwayPayerAddress
    ? await client.readContract({
        abi: erc20Abi,
        address: config.usdcAddress,
        functionName: "balanceOf",
        args: [config.conwayPayerAddress]
      })
    : null;

  try {
    const creditsBalanceUsdc = await readConwayBalanceUsdc(config);
    const creditsSource = config.computeBillingMode === "alchemy" ? "alchemy" : "conway";
    return { creditsBalanceUsdc, creditsSource, payerBalanceUsdc, fallbackToEscrow: false };
  } catch (error) {
    if (!config.conwayFallbackToEscrowOnError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const providerLabel = config.computeBillingMode === "alchemy" ? "Alchemy" : "Conway";
    console.warn(`[watcher] ${providerLabel} balance unavailable (${message}); falling back to escrow balance`);
    const creditsBalanceUsdc = await readEscrowBalanceUsdc(client, config);
    return { creditsBalanceUsdc, creditsSource: "escrow", payerBalanceUsdc, fallbackToEscrow: true };
  }
}

async function triggerShutdown(command: string): Promise<void> {
  console.error(`[watcher] triggering shutdown: ${command}`);
  try {
    const { stdout, stderr } = await exec(command);
    if (stdout.trim()) console.error(`[watcher] shutdown stdout: ${stdout.trim()}`);
    if (stderr.trim()) console.error(`[watcher] shutdown stderr: ${stderr.trim()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[watcher] shutdown command failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadWatcherConfig();
  assertBaseChain(config.chainId, config.allowTestnet);

  const client = createPublicClient({
    chain: resolveChain(config.chainId),
    transport: http(config.rpcUrl)
  });

  const rpcChainId = await client.getChainId();
  if (rpcChainId !== config.chainId) {
    throw new Error(`RPC chainId mismatch. expected=${config.chainId}, got=${rpcChainId}`);
  }

  let consecutiveLowCreditsReadings = 0;
  let remainingLowCreditsGraceChecks = config.lowCreditsGraceChecks;
  let consecutiveLowPayerReadings = 0;
  let remainingLowPayerGraceChecks = config.lowPayerGraceChecks;

  console.log(
    `[watcher] chainId=${config.chainId} mode=${config.computeBillingMode} escrow=${config.escrowAddress} interval=${config.watchIntervalSeconds}s threshold=${config.failureThreshold} creditsGrace=${config.lowCreditsGraceChecks} payerGrace=${config.lowPayerGraceChecks}`
  );

  const tick = async () => {
    try {
      const fundingBalance = await readFundingBalanceUsdc(client, config);
      const creditsMinUsdc =
        config.computeBillingMode === "escrow" ? config.minEscrowBalanceUsdc : config.minConwayCreditsBalanceUsdc;
      const creditsBelowThreshold = fundingBalance.creditsBalanceUsdc <= creditsMinUsdc;

      if (creditsBelowThreshold) {
        if (remainingLowCreditsGraceChecks > 0) {
          remainingLowCreditsGraceChecks -= 1;
        } else {
          consecutiveLowCreditsReadings += 1;
        }
      } else {
        consecutiveLowCreditsReadings = 0;
      }

      let payerBelowThreshold = false;
      if (config.computeBillingMode !== "escrow" && fundingBalance.payerBalanceUsdc !== null) {
        payerBelowThreshold = fundingBalance.payerBalanceUsdc <= config.minConwayPayerBalanceUsdc;
        if (payerBelowThreshold) {
          if (remainingLowPayerGraceChecks > 0) {
            remainingLowPayerGraceChecks -= 1;
          } else {
            consecutiveLowPayerReadings += 1;
          }
        } else {
          consecutiveLowPayerReadings = 0;
        }
      }

      console.log(
        `[watcher] creditsSource=${fundingBalance.creditsSource}${fundingBalance.fallbackToEscrow ? "(fallback)" : ""} credits=${formatToken(fundingBalance.creditsBalanceUsdc, config.usdcDecimals)} usdc minCredits=${formatToken(creditsMinUsdc, config.usdcDecimals)} usdc creditsGrace=${remainingLowCreditsGraceChecks}/${config.lowCreditsGraceChecks} creditsConsecutive=${consecutiveLowCreditsReadings}/${config.failureThreshold} payer=${fundingBalance.payerBalanceUsdc == null ? "n/a" : `${formatToken(fundingBalance.payerBalanceUsdc, config.usdcDecimals)} usdc`} minPayer=${formatToken(config.minConwayPayerBalanceUsdc, config.usdcDecimals)} usdc payerGrace=${remainingLowPayerGraceChecks}/${config.lowPayerGraceChecks} payerConsecutive=${consecutiveLowPayerReadings}/${config.failureThreshold}`
      );

      if (consecutiveLowCreditsReadings >= config.failureThreshold) {
        console.error(
          `[watcher] credits runway breach source=${fundingBalance.creditsSource} balance=${formatToken(fundingBalance.creditsBalanceUsdc, config.usdcDecimals)} min=${formatToken(creditsMinUsdc, config.usdcDecimals)}`
        );
        await triggerShutdown(config.shutdownCommand);
        process.exit(0);
      }

      if (
        config.computeBillingMode !== "escrow" &&
        config.minConwayPayerBalanceUsdc > 0n &&
        fundingBalance.payerBalanceUsdc !== null &&
        payerBelowThreshold &&
        consecutiveLowPayerReadings >= config.failureThreshold
      ) {
        console.error(
          `[watcher] payer runway breach address=${config.conwayPayerAddress} balance=${formatToken(fundingBalance.payerBalanceUsdc, config.usdcDecimals)} min=${formatToken(config.minConwayPayerBalanceUsdc, config.usdcDecimals)}`
        );
        await triggerShutdown(config.shutdownCommand);
        process.exit(0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[watcher] balance read failed: ${message}`);
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, config.watchIntervalSeconds * 1000);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[watcher:fatal]", message);
    process.exit(1);
  });
}
