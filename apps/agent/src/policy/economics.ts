import type { AgentRunRecord, EconomicsSnapshot, WstEthRateSample } from "@ssa/shared/types";
import {
  BPS_DENOMINATOR,
  RAY,
  SECONDS_PER_MONTH,
  USD_DECIMALS,
  WAD,
  YEAR_SECONDS
} from "@ssa/shared/constants";
import { annualizeDelta, elapsedSeconds, mulDiv, safeSub } from "@ssa/shared/utils";

export type EconomicsInput = {
  timestamp: string;
  previousTimestamp?: string;
  collateralBaseUsd: bigint;
  debtBaseUsd: bigint;
  borrowRateRay: bigint;
  wstEthAprWad: bigint | null;
  gasCostUsd: bigint;
  swapCostUsd: bigint;
  computeCostUsd: bigint;
};

export type AlgorithmicComputeCostInput = {
  monthlyServerCostUsdc: bigint;
  baseIntervalSeconds: number;
  trailingAvgGasCostUsd: bigint;
  computeBufferBps: number;
  usdcDecimals: number;
};

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("ceilDiv denominator is zero");
  return (numerator + denominator - 1n) / denominator;
}

function usdToUsdcUnits(usdValue: bigint, usdcDecimals: number): bigint {
  if (usdValue <= 0n) return 0n;

  const usdDecimals = Number(USD_DECIMALS);
  if (usdcDecimals <= 0 || usdcDecimals > 255) {
    throw new Error(`usdcDecimals must be between 1 and 255, got ${usdcDecimals}`);
  }
  if (usdDecimals < usdcDecimals) {
    const upScale = 10n ** BigInt(usdcDecimals - usdDecimals);
    return usdValue * upScale;
  }

  const downScale = 10n ** BigInt(usdDecimals - usdcDecimals);
  return ceilDiv(usdValue, downScale);
}

export function computePerTickServerCostUsdc(monthlyServerCostUsdc: bigint, baseIntervalSeconds: number): bigint {
  if (monthlyServerCostUsdc <= 0n) return 0n;
  if (baseIntervalSeconds <= 0) throw new Error(`baseIntervalSeconds must be > 0, got ${baseIntervalSeconds}`);
  return ceilDiv(monthlyServerCostUsdc * BigInt(baseIntervalSeconds), SECONDS_PER_MONTH);
}

export function trailingAvgGasCostUsd(runs: AgentRunRecord[], windowSize = 50): bigint {
  if (windowSize <= 0) throw new Error(`windowSize must be > 0, got ${windowSize}`);

  const onchainGasSamples = runs
    .filter((run) => run.economics.gasCostUsd > 0n)
    .slice(-windowSize)
    .map((run) => run.economics.gasCostUsd);

  if (onchainGasSamples.length === 0) return 0n;

  const sum = onchainGasSamples.reduce((acc, value) => acc + value, 0n);
  return sum / BigInt(onchainGasSamples.length);
}

export function algorithmicComputeCostUsdc(input: AlgorithmicComputeCostInput): bigint {
  const serverPerTick = computePerTickServerCostUsdc(input.monthlyServerCostUsdc, input.baseIntervalSeconds);
  const trailingGasUsdc = usdToUsdcUnits(input.trailingAvgGasCostUsd, input.usdcDecimals);
  const subtotal = serverPerTick + trailingGasUsdc;
  if (subtotal <= 0n) return 0n;

  const buffer = mulDiv(subtotal, BigInt(input.computeBufferBps), BPS_DENOMINATOR);
  return subtotal + buffer;
}

export function estimateWstEthAprFromSamples(samples: WstEthRateSample[]): bigint | null {
  if (samples.length < 2) return null;

  const sorted = [...samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const dt = elapsedSeconds(last.timestamp, first.timestamp);

  if (dt <= 0n || first.wstEthPerToken === 0n) return null;

  const growthWad = mulDiv(last.wstEthPerToken, WAD, first.wstEthPerToken);
  if (growthWad <= WAD) return 0n;

  const driftWad = growthWad - WAD;
  return mulDiv(driftWad, YEAR_SECONDS, dt);
}

function rayToWad(ray: bigint): bigint {
  return mulDiv(ray, WAD, RAY);
}

function breakEvenEquityApproxUsd(
  annualCostUsd: bigint,
  leverageWad: bigint,
  stakingAprWad: bigint,
  borrowAprWad: bigint
): bigint | null {
  if (annualCostUsd <= 0n) return 0n;

  const l = leverageWad;
  if (l < WAD) return null;

  const term1 = mulDiv(l, stakingAprWad, WAD);
  const term2 = mulDiv(safeSub(l, WAD), borrowAprWad, WAD);

  if (term1 <= term2) return null;

  const denominator = term1 - term2;
  return mulDiv(annualCostUsd, WAD, denominator);
}

export function computeEconomics(input: EconomicsInput): EconomicsSnapshot {
  const intervalSeconds = input.previousTimestamp
    ? elapsedSeconds(input.timestamp, input.previousTimestamp)
    : YEAR_SECONDS / 365n;

  const borrowAprWad = rayToWad(input.borrowRateRay);
  const stakingAprWad = input.wstEthAprWad ?? 0n;

  const yieldDeltaUsd = mulDiv(
    input.collateralBaseUsd * stakingAprWad,
    intervalSeconds,
    WAD * YEAR_SECONDS
  );
  const interestDeltaUsd = mulDiv(
    input.debtBaseUsd * borrowAprWad,
    intervalSeconds,
    WAD * YEAR_SECONDS
  );

  const netDeltaUsd =
    yieldDeltaUsd -
    interestDeltaUsd -
    input.gasCostUsd -
    input.swapCostUsd -
    input.computeCostUsd;

  const equityUsd = safeSub(input.collateralBaseUsd, input.debtBaseUsd);
  const leverageWad = equityUsd > 0n ? mulDiv(input.collateralBaseUsd, WAD, equityUsd) : 0n;

  const annualFixedCost = annualizeDelta(
    input.gasCostUsd + input.swapCostUsd + input.computeCostUsd,
    intervalSeconds > 0n ? intervalSeconds : 1n
  );

  const breakEvenEquityUsdApprox = breakEvenEquityApproxUsd(
    annualFixedCost,
    leverageWad,
    stakingAprWad,
    borrowAprWad
  );

  const notes: string[] = [];
  if (input.wstEthAprWad === null) {
    notes.push("wstETH APR drift unavailable: waiting for >=2 onchain snapshots");
  }
  if (breakEvenEquityUsdApprox === null) {
    notes.push("break-even denominator <= 0 under current leverage/rates");
  }

  return {
    intervalSeconds,
    yieldDeltaUsd,
    interestDeltaUsd,
    gasCostUsd: input.gasCostUsd,
    swapCostUsd: input.swapCostUsd,
    computeCostUsd: input.computeCostUsd,
    netDeltaUsd,
    breakEvenEquityUsdApprox,
    leverageWad,
    gasPaymentUsdc: null,
    notes
  };
}
