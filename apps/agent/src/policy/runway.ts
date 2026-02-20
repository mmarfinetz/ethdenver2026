import type { ComputeRunway, ComputeUrgency } from "@ssa/shared/types";
import { SECONDS_PER_DAY, WAD } from "@ssa/shared/constants";
import { safeSub } from "@ssa/shared/utils";

export type ComputeRunwayInput = {
  escrowBalanceUsdc: bigint;
  perTickCostUsdc: bigint;
  baseIntervalSeconds: number;
  nominalDays: number;
  elevatedDays: number;
  deadDays: number;
};

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("ceilDiv denominator is zero");
  return (numerator + denominator - 1n) / denominator;
}

function urgencyFromRunwayDays(runwayDaysWad: bigint, nominalDays: bigint, elevatedDays: bigint, deadDays: bigint): ComputeUrgency {
  if (runwayDaysWad >= nominalDays * WAD) return "nominal";
  if (runwayDaysWad >= elevatedDays * WAD) return "elevated";
  if (runwayDaysWad >= deadDays * WAD) return "critical";
  return "dead";
}

function dailyCostUsdc(perTickCostUsdc: bigint, ticksPerDayWad: bigint): bigint {
  if (perTickCostUsdc <= 0n || ticksPerDayWad <= 0n) return 0n;
  return ceilDiv(perTickCostUsdc * ticksPerDayWad, WAD);
}

export function computeRunway(input: ComputeRunwayInput): ComputeRunway {
  if (input.baseIntervalSeconds <= 0) {
    throw new Error(`baseIntervalSeconds must be > 0, got ${input.baseIntervalSeconds}`);
  }

  const nominalDays = BigInt(input.nominalDays);
  const elevatedDays = BigInt(input.elevatedDays);
  const deadDays = BigInt(input.deadDays);
  const ticksPerDayWad = (SECONDS_PER_DAY * WAD) / BigInt(input.baseIntervalSeconds);

  const runwayDaysWad = (() => {
    const daily = dailyCostUsdc(input.perTickCostUsdc, ticksPerDayWad);
    if (daily <= 0n) return (1n << 255n) - 1n;
    return (input.escrowBalanceUsdc * WAD) / daily;
  })();

  return {
    escrowBalanceUsdc: input.escrowBalanceUsdc,
    perTickCostUsdc: input.perTickCostUsdc,
    runwayDaysWad,
    urgency: urgencyFromRunwayDays(runwayDaysWad, nominalDays, elevatedDays, deadDays),
    baseIntervalSeconds: BigInt(input.baseIntervalSeconds),
    ticksPerDayWad,
    nominalDays,
    elevatedDays,
    deadDays
  };
}

export function effectiveMaxLoops(maxLoops: number, urgency: ComputeUrgency): number {
  if (urgency === "nominal") return maxLoops;
  if (urgency === "elevated") return Math.floor(maxLoops / 2);
  return 0;
}

export function escrowDeficitUsdc(runway: ComputeRunway, targetDays: number): bigint {
  if (targetDays <= 0 || runway.perTickCostUsdc <= 0n) return 0n;

  const targetDaysWad = BigInt(targetDays) * WAD;
  const daily = dailyCostUsdc(runway.perTickCostUsdc, runway.ticksPerDayWad);
  if (daily <= 0n) return 0n;

  const requiredEscrow = ceilDiv(daily * targetDaysWad, WAD);
  return safeSub(requiredEscrow, runway.escrowBalanceUsdc);
}

export function adaptiveIntervalMultiplier(urgency: ComputeUrgency): number {
  if (urgency === "nominal") return 1;
  if (urgency === "elevated") return 2;
  if (urgency === "critical") return 4;
  return 8;
}
