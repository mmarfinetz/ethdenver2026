import type { Address } from "viem";
import { formatUnits, isAddress, parseUnits } from "viem";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BPS_DENOMINATOR,
  USD_UNIT,
  WAD,
  YEAR_SECONDS
} from "./constants";

export function mustEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function parseAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid address for ${label}: ${value}`);
  }
  return value;
}

export function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${label}: ${value}`);
  }
  return parsed;
}

export function parseDecimalToUnits(value: string, decimals: number, label: string): bigint {
  try {
    return parseUnits(value, decimals);
  } catch {
    throw new Error(`Invalid decimal for ${label}: ${value}`);
  }
}

export function parsePercentToWad(value: string, label: string): bigint {
  const trimmed = value.trim();
  const maybePercent = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
  const decimal = Number.parseFloat(maybePercent);
  if (!Number.isFinite(decimal) || decimal < 0) {
    throw new Error(`Invalid percent for ${label}: ${value}`);
  }
  return parseUnits((decimal / 100).toString(), 18);
}

export function parseFloatToWad(value: string, label: string): bigint {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid decimal for ${label}: ${value}`);
  }
  return parseUnits(parsed.toString(), 18);
}

export function formatUsd(value: bigint, decimals = 8): string {
  return formatUnits(value, decimals);
}

export function formatToken(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

export function assertBaseChain(chainId: number, allowTestnet: boolean): void {
  if (chainId === BASE_MAINNET_CHAIN_ID) return;
  if (allowTestnet && chainId === BASE_SEPOLIA_CHAIN_ID) return;
  throw new Error(`Unsupported chainId ${chainId}. Expected 8453${allowTestnet ? " or 84532" : ""}.`);
}

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDiv denominator is zero");
  return (a * b) / denominator;
}

export function bpsToWad(bps: bigint): bigint {
  return mulDiv(bps, WAD, BPS_DENOMINATOR);
}

export function safeSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

export function annualizeDelta(delta: bigint, intervalSeconds: bigint): bigint {
  if (intervalSeconds <= 0n) return 0n;
  return mulDiv(delta, YEAR_SECONDS, intervalSeconds);
}

export function usdFromTokenAmount(
  tokenAmount: bigint,
  tokenDecimals: number,
  priceUsd: bigint,
  priceDecimals = 8
): bigint {
  const tokenUnit = 10n ** BigInt(tokenDecimals);
  const usdUnit = 10n ** BigInt(priceDecimals);
  return mulDiv(tokenAmount, priceUsd, tokenUnit * (usdUnit / USD_UNIT));
}

export function valueToBigInt(input: unknown): bigint {
  if (typeof input === "bigint") return input;
  if (typeof input === "number") return BigInt(Math.trunc(input));
  if (typeof input === "string" && /^-?\d+$/.test(input)) return BigInt(input);
  return 0n;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function parseSalt(raw: string): bigint {
  if (raw.startsWith("0x")) return BigInt(raw);
  return BigInt(parseInteger(raw, "SMART_ACCOUNT_SALT"));
}

export function elapsedSeconds(nowIso: string, beforeIso: string): bigint {
  const now = BigInt(Math.floor(Date.parse(nowIso) / 1000));
  const before = BigInt(Math.floor(Date.parse(beforeIso) / 1000));
  if (now <= before) return 0n;
  return now - before;
}
