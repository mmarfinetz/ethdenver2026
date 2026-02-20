import { formatUnits } from "viem";

export function fmt(value: bigint | null | undefined, decimals: number, suffix = ""): string {
  if (value == null) return "--";
  const text = Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 4
  });
  return suffix ? `${text} ${suffix}` : text;
}

export function fmtHf(value: bigint | null | undefined): string {
  if (value == null) return "--";
  if (value > 10n ** 30n) return "inf";
  return (Number(value) / 1e18).toFixed(3);
}

export function fmtShortHash(hash: string): string {
  if (hash.length < 12) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

export function fmtPercentWad(value: bigint | null | undefined): string {
  if (value == null) return "--";
  const pct = (Number(value) / 1e18) * 100;
  return `${pct.toFixed(2)}%`;
}
