import { BPS_DENOMINATOR, MAX_UINT256, WAD } from "@ssa/shared/constants";
import { mulDiv, safeSub } from "@ssa/shared/utils";

export function computeHealthFactorWad(
  collateralBase: bigint,
  debtBase: bigint,
  liquidationThresholdBps: bigint
): bigint {
  if (debtBase === 0n) return MAX_UINT256;
  const numerator = collateralBase * liquidationThresholdBps * WAD;
  const denominator = debtBase * BPS_DENOMINATOR;
  return numerator / denominator;
}

export function debtMaxForTargetHf(
  collateralBase: bigint,
  liquidationThresholdBps: bigint,
  hfTargetWad: bigint
): bigint {
  if (hfTargetWad <= 0n) throw new Error("hfTargetWad must be > 0");
  return mulDiv(collateralBase * liquidationThresholdBps, WAD, hfTargetWad * BPS_DENOMINATOR);
}

export function additionalDebtCapacityForTarget(
  collateralBase: bigint,
  debtBase: bigint,
  liquidationThresholdBps: bigint,
  hfTargetWad: bigint
): bigint {
  const debtMax = debtMaxForTargetHf(collateralBase, liquidationThresholdBps, hfTargetWad);
  return safeSub(debtMax, debtBase);
}

export function withdrawableCollateralForTarget(
  collateralBase: bigint,
  debtBase: bigint,
  liquidationThresholdBps: bigint,
  hfTargetWad: bigint
): bigint {
  if (liquidationThresholdBps === 0n) return 0n;
  const requiredCollateral = mulDiv(
    debtBase * hfTargetWad * BPS_DENOMINATOR,
    1n,
    liquidationThresholdBps * WAD
  );
  return safeSub(collateralBase, requiredCollateral);
}

export function projectedHfAfterBorrow(
  collateralBase: bigint,
  debtBase: bigint,
  borrowDeltaBase: bigint,
  liquidationThresholdBps: bigint
): bigint {
  return computeHealthFactorWad(
    collateralBase,
    debtBase + borrowDeltaBase,
    liquidationThresholdBps
  );
}

export function projectedHfAfterRepay(
  collateralBase: bigint,
  debtBase: bigint,
  repayDeltaBase: bigint,
  liquidationThresholdBps: bigint
): bigint {
  return computeHealthFactorWad(
    collateralBase,
    safeSub(debtBase, repayDeltaBase),
    liquidationThresholdBps
  );
}
