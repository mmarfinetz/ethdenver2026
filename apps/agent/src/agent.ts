import { erc20Abi } from "@ssa/shared/abis";
import type {
  AgentRunRecord,
  ComputeRunway,
  ConwayReconciliationSnapshot,
  WstEthRateSample
} from "@ssa/shared/types";
import { BPS_DENOMINATOR, WETH_DECIMALS, WSTETH_DECIMALS } from "@ssa/shared/constants";
import { formatToken, mulDiv, safeSub } from "@ssa/shared/utils";
import {
  callApprove,
  callBorrow,
  callRepay,
  callSupply,
  callWithdraw,
  readChainSnapshot,
  tokenToUsd,
  usdToToken,
  usdcToUsd
} from "./aave";
import { createBundlerContext, sendUserOperation, type Call } from "./aa/bundler";
import {
  buildCirclePaymasterApproval,
  createOptionalPaymasterClient,
  type CirclePaymasterConfig
} from "./aa/paymaster";
import { createSimpleSmartAccount } from "./aa/smartAccount";
import { applySuffix, buildDataSuffix, callDataHasSuffix } from "./builderCodes";
import { createChainContext, validateStartup } from "./chain";
import { loadConfig } from "./config";
import { getSwapQuote, type SwapQuote } from "./dex";
import { computeGasCostUsd, computeSwapCostUsd } from "./metrics";
import {
  additionalDebtCapacityForTarget,
  debtMaxForTargetHf,
  projectedHfAfterBorrow,
  projectedHfAfterRepay,
  withdrawableCollateralForTarget
} from "./policy/hfMath";
import {
  algorithmicComputeCostUsdc,
  computeEconomics,
  estimateWstEthAprFromSamples,
  trailingAvgGasCostUsd
} from "./policy/economics";
import {
  adaptiveIntervalMultiplier,
  computeRunway,
  effectiveMaxLoops,
  escrowDeficitUsdc
} from "./policy/runway";
import {
  createRiskEngineFromEnv,
  isRiskAccepted,
  type MonteCarloRiskEngine,
  type RiskSnapshot
} from "./policy/riskEngine";
import { startScheduler } from "./scheduler";
import { pushTelemetry } from "@ssa/shared/telemetry";
import {
  appendRateSample,
  appendRunRecord,
  readRunRecords,
  readStorageState
} from "./storage";
import { createComputeBillingProvider, type ComputeBillingProvider } from "./billing";
import type { Address, PublicClient } from "viem";

const TRAILING_GAS_WINDOW = 50;

type Snapshot = Awaited<ReturnType<typeof readChainSnapshot>>;
type Config = ReturnType<typeof loadConfig>;

type PlannedAction = {
  decision: AgentRunRecord["decision"];
  calls: Call[];
  swapCostUsd: bigint;
  escrowPaymentUsdc: bigint;
  topupAmountUsdc: bigint;
  topupReason: string;
  summary: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toWadPercentString(value: bigint): string {
  const n = Number(value) / 1e18;
  return `${(n * 100).toFixed(2)}%`;
}

function toHfString(value: bigint): string {
  if (value > 10n ** 30n) return "inf";
  return (Number(value) / 1e18).toFixed(3);
}

function toRunwayDaysString(runway: ComputeRunway): string {
  if (runway.runwayDaysWad > 10n ** 30n) return "inf";
  return (Number(runway.runwayDaysWad) / 1e18).toFixed(2);
}

function isSameAssetLoopMode(config: Config): boolean {
  return config.wstEthAddress.toLowerCase() === config.wethAddress.toLowerCase();
}

function buildRuntimeProvenance(): AgentRunRecord["provenance"] {
  return {
    agentVersion: process.env.AGENT_VERSION?.trim() || "0.1.0",
    autopilotVersion: process.env.AUTOPILOT_VERSION?.trim() || "manual",
    modelId: process.env.AUTOPILOT_MODEL_ID?.trim() || "unspecified",
    policyVersion: process.env.AUTOPILOT_POLICY_VERSION?.trim() || "1",
    commitSha: process.env.AUTOPILOT_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || "unknown"
  };
}

function computeConsecutiveLoopRuns(runs: AgentRunRecord[]): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.status !== "ok" || run.decision !== "loop") break;
    count += 1;
  }
  return count;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function parseTimestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inWindow(timestampMs: number | null, windowStartMs: number, windowEndMs: number): boolean {
  if (timestampMs === null) return false;
  return timestampMs >= windowStartMs && timestampMs <= windowEndMs;
}

function sumHistoricalPayerFundingUsdc(runs: AgentRunRecord[], windowStartMs: number, windowEndMs: number): bigint {
  let total = 0n;
  for (const run of runs) {
    if (!inWindow(parseTimestampMs(run.timestamp), windowStartMs, windowEndMs)) continue;
    if (run.status !== "ok") continue;
    total += run.payerFundingUsdc ?? 0n;
  }
  return total;
}

function sumHistoricalCreditTopupsUsdc(runs: AgentRunRecord[], windowStartMs: number, windowEndMs: number): bigint {
  let total = 0n;
  for (const run of runs) {
    if (!inWindow(parseTimestampMs(run.timestamp), windowStartMs, windowEndMs)) continue;
    if (run.topupStatus !== "ok") continue;
    total += run.topupAmountUsdc;
  }
  return total;
}

function earliestPayerBalanceInWindow(
  runs: AgentRunRecord[],
  windowStartMs: number,
  windowEndMs: number,
  fallback: bigint
): bigint {
  for (const run of runs) {
    if (!inWindow(parseTimestampMs(run.timestamp), windowStartMs, windowEndMs)) continue;
    if (run.payerBalanceUsdc == null) continue;
    return run.payerBalanceUsdc;
  }
  return fallback;
}

function findLastSuccessfulPayerFundingMs(runs: AgentRunRecord[]): number | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.status !== "ok") continue;
    if ((run.payerFundingUsdc ?? 0n) <= 0n) continue;
    const ts = parseTimestampMs(run.timestamp);
    if (ts !== null) return ts;
  }
  return null;
}

function findLastSuccessfulTopupMs(runs: AgentRunRecord[]): number | null {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.topupStatus !== "ok") continue;
    const ts = parseTimestampMs(run.timestamp);
    if (ts !== null) return ts;
  }
  return null;
}

function cooldownActive(nowMs: number, lastEventMs: number | null, cooldownSeconds: number): boolean {
  if (cooldownSeconds <= 0 || lastEventMs === null) return false;
  return nowMs - lastEventMs < cooldownSeconds * 1000;
}

function clampByBudget(targetUsdc: bigint, perTickCapUsdc: bigint, remainingDailyCapUsdc: bigint): bigint {
  if (targetUsdc <= 0n || perTickCapUsdc <= 0n || remainingDailyCapUsdc <= 0n) return 0n;
  return minBigInt(targetUsdc, minBigInt(perTickCapUsdc, remainingDailyCapUsdc));
}

function buildConwayReconciliationSnapshot(input: {
  runs: AgentRunRecord[];
  windowHours: number;
  nowIso: string;
  payerEndBalanceUsdc: bigint;
  currentTopupUsdc: bigint;
  currentFundingUsdc: bigint;
  bootstrapUsdc: bigint;
}): ConwayReconciliationSnapshot {
  const nowMs = parseTimestampMs(input.nowIso) ?? Date.now();
  const windowStartMs = nowMs - input.windowHours * 60 * 60 * 1000;

  const historicalTopups = sumHistoricalCreditTopupsUsdc(input.runs, windowStartMs, nowMs);
  const historicalFunding = sumHistoricalPayerFundingUsdc(input.runs, windowStartMs, nowMs);
  const payerStartBalanceUsdc = earliestPayerBalanceInWindow(
    input.runs,
    windowStartMs,
    nowMs,
    input.payerEndBalanceUsdc
  );

  const creditTopupsUsdc = historicalTopups + input.currentTopupUsdc;
  const smartAccountFundingUsdc = historicalFunding + input.currentFundingUsdc;
  const lhsUsdc = creditTopupsUsdc + input.payerEndBalanceUsdc - payerStartBalanceUsdc;
  const rhsUsdc = smartAccountFundingUsdc + input.bootstrapUsdc;

  return {
    windowHours: input.windowHours,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: input.nowIso,
    payerStartBalanceUsdc,
    payerEndBalanceUsdc: input.payerEndBalanceUsdc,
    creditTopupsUsdc,
    smartAccountFundingUsdc,
    lhsUsdc,
    rhsUsdc,
    withinInvariant: lhsUsdc <= rhsUsdc
  };
}

async function readUsdcBalanceForAddress(
  client: PublicClient,
  usdcAddress: Address,
  address: Address | undefined
): Promise<bigint | null> {
  if (!address) return null;
  return client.readContract({
    abi: erc20Abi,
    address: usdcAddress,
    functionName: "balanceOf",
    args: [address]
  });
}

function riskSnapshotFromChain(snapshot: Snapshot, apr: bigint | null): RiskSnapshot {
  return {
    healthFactorWad: snapshot.position.healthFactor,
    collateralBaseUsd: snapshot.position.totalCollateralBase,
    debtBaseUsd: snapshot.position.totalDebtBase,
    borrowRateRay: snapshot.reserve.currentVariableBorrowRateRay,
    wstEthAprWad: apr
  };
}

function buildRunway(config: Config, creditBalanceUsdc: bigint, perTickCostUsdc: bigint): ComputeRunway {
  return computeRunway({
    escrowBalanceUsdc: creditBalanceUsdc,
    perTickCostUsdc,
    baseIntervalSeconds: config.runIntervalSeconds,
    nominalDays: config.runwayNominalDays,
    elevatedDays: config.runwayElevatedDays,
    deadDays: config.runwayDeadDays
  });
}

function planPayEscrowAction(
  config: Config,
  billingProvider: ComputeBillingProvider,
  snapshot: Snapshot,
  amountUsdc: bigint,
  reason: string
): PlannedAction {
  const transferSpec = billingProvider.transferSpec("routine");
  const transferAmount = minBigInt(amountUsdc, snapshot.balances.usdc);

  if (transferAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: reason,
      summary: `No idle USDC available for ${transferSpec.recipientLabel} payment`
    };
  }

  return {
    decision: transferSpec.decision,
    calls: [billingProvider.buildTopupTransferCall(config, transferAmount)],
    swapCostUsd: 0n,
    escrowPaymentUsdc: transferAmount,
    topupAmountUsdc: 0n,
    topupReason: reason,
    summary: `${reason}: pay ${formatToken(transferAmount, config.expectedDecimals.usdc)} USDC to ${transferSpec.recipientLabel}`
  };
}

function planConwayTopupAction(config: Config, amountUsdc: bigint, reason: string): PlannedAction {
  if (amountUsdc <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: reason,
      summary: `${reason}: no Conway credit topup required`
    };
  }

  return {
    decision: "topup-credits",
    calls: [],
    swapCostUsd: 0n,
    escrowPaymentUsdc: 0n,
    topupAmountUsdc: amountUsdc,
    topupReason: reason,
    summary: `${reason}: top up Conway credits by ${formatToken(amountUsdc, config.expectedDecimals.usdc)} USDC`
  };
}

async function planDeleverAction(config: Config, snapshot: Snapshot, account: `0x${string}`): Promise<PlannedAction> {
  const targetHf = config.hfTargetWad + config.hfBufferWad;
  const maxDebt = debtMaxForTargetHf(
    snapshot.position.totalCollateralBase,
    snapshot.position.currentLiquidationThresholdBps,
    targetHf
  );

  if (snapshot.position.totalDebtBase <= maxDebt) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: "HF below target but debt already near target envelope",
      summary: "HF below target but debt already near target envelope"
    };
  }

  const repayDebtBase = snapshot.position.totalDebtBase - maxDebt;
  const repayWeth = usdToToken(repayDebtBase, WETH_DECIMALS, snapshot.prices.wethUsd);

  if (repayWeth <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: "Repay amount rounded to zero",
      summary: "Repay amount rounded to zero"
    };
  }

  const calls: Call[] = [];
  let swapCostUsd = 0n;
  const sameAssetLoopMode = isSameAssetLoopMode(config);

  if (snapshot.balances.weth < repayWeth) {
    const neededWeth = repayWeth - snapshot.balances.weth;

    if (sameAssetLoopMode) {
      calls.push(callWithdraw(config.aavePoolAddress, config.wethAddress, neededWeth, account));
    } else {
      const quote = await getSwapQuote(config, {
        sellToken: config.wstEthAddress,
        buyToken: config.wethAddress,
        buyAmount: neededWeth,
        slippageBps: config.slippageBps,
        taker: account
      });

      const withdrawNeeded = safeSub(quote.sellAmount, snapshot.balances.wstEth);

      if (withdrawNeeded > 0n) {
        calls.push(callWithdraw(config.aavePoolAddress, config.wstEthAddress, withdrawNeeded, account));
      }

      calls.push(callApprove(config.wstEthAddress, quote.allowanceTarget, quote.sellAmount));
      calls.push({
        to: quote.to,
        data: quote.data,
        value: quote.value
      });

      swapCostUsd = computeSwapCostUsd(
        quote.sellAmount,
        WSTETH_DECIMALS,
        snapshot.prices.wstEthUsd,
        quote.buyAmount,
        WETH_DECIMALS,
        snapshot.prices.wethUsd
      );
    }
  }

  calls.push(callApprove(config.wethAddress, config.aavePoolAddress, repayWeth));
  calls.push(callRepay(config.aavePoolAddress, config.wethAddress, repayWeth, account));

  const projected = projectedHfAfterRepay(
    snapshot.position.totalCollateralBase,
    snapshot.position.totalDebtBase,
    repayDebtBase,
    snapshot.position.currentLiquidationThresholdBps
  );

  if (projected < config.hfTargetWad) {
    throw new Error(
      `Delever plan rejected: projected HF ${toHfString(projected)} < target ${toHfString(config.hfTargetWad)}`
    );
  }

  return {
    decision: "delever",
    calls,
    swapCostUsd,
    escrowPaymentUsdc: 0n,
    topupAmountUsdc: 0n,
    topupReason: "delever",
    summary: `Delever: repay ${formatToken(repayWeth, WETH_DECIMALS)} WETH to restore HF>=target`
  };
}

async function planLoopAction(config: Config, snapshot: Snapshot, account: `0x${string}`): Promise<PlannedAction> {
  const hfGuard = config.hfTargetWad + config.hfBufferWad;

  const debtCapacityBase = additionalDebtCapacityForTarget(
    snapshot.position.totalCollateralBase,
    snapshot.position.totalDebtBase,
    snapshot.position.currentLiquidationThresholdBps,
    hfGuard
  );

  if (debtCapacityBase <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: "No debt capacity available under HF guard",
      summary: "No debt capacity available under HF guard"
    };
  }

  const borrowBase = mulDiv(debtCapacityBase, BigInt(config.loopBorrowBps), BPS_DENOMINATOR);
  const borrowWeth = usdToToken(borrowBase, WETH_DECIMALS, snapshot.prices.wethUsd);

  if (borrowWeth <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: "Borrow amount rounded to zero",
      summary: "Borrow amount rounded to zero"
    };
  }

  const borrowBaseProjected = tokenToUsd(borrowWeth, WETH_DECIMALS, snapshot.prices.wethUsd);
  const projectedBorrowHf = projectedHfAfterBorrow(
    snapshot.position.totalCollateralBase,
    snapshot.position.totalDebtBase,
    borrowBaseProjected,
    snapshot.position.currentLiquidationThresholdBps
  );

  if (projectedBorrowHf < hfGuard) {
    throw new Error(
      `Loop rejected: projected HF after borrow ${toHfString(projectedBorrowHf)} < guard ${toHfString(hfGuard)}`
    );
  }

  if (isSameAssetLoopMode(config)) {
    const calls: Call[] = [
      callBorrow(config.aavePoolAddress, config.wethAddress, borrowWeth, account),
      callApprove(config.wethAddress, config.aavePoolAddress, borrowWeth),
      callSupply(config.aavePoolAddress, config.wethAddress, borrowWeth, account)
    ];

    return {
      decision: "loop",
      calls,
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: "loop",
      summary: `Loop: borrow ${formatToken(borrowWeth, WETH_DECIMALS)} WETH and resupply WETH (same-asset mode)`
    };
  }

  const targetBuyWst = usdToToken(
    tokenToUsd(borrowWeth, WETH_DECIMALS, snapshot.prices.wethUsd),
    WSTETH_DECIMALS,
    snapshot.prices.wstEthUsd
  );

  const quote = await getSwapQuote(config, {
    sellToken: config.wethAddress,
    buyToken: config.wstEthAddress,
    buyAmount: targetBuyWst,
    slippageBps: config.slippageBps,
    taker: account
  });

  const calls: Call[] = [
    callBorrow(config.aavePoolAddress, config.wethAddress, quote.sellAmount, account),
    callApprove(config.wethAddress, quote.allowanceTarget, quote.sellAmount),
    {
      to: quote.to,
      data: quote.data,
      value: quote.value
    },
    callApprove(config.wstEthAddress, config.aavePoolAddress, quote.buyAmount),
    callSupply(config.aavePoolAddress, config.wstEthAddress, quote.buyAmount, account)
  ];

  const swapCostUsd = computeSwapCostUsd(
    quote.sellAmount,
    WETH_DECIMALS,
    snapshot.prices.wethUsd,
    quote.buyAmount,
    WSTETH_DECIMALS,
    snapshot.prices.wstEthUsd
  );

  return {
    decision: "loop",
    calls,
    swapCostUsd,
    escrowPaymentUsdc: 0n,
    topupAmountUsdc: 0n,
    topupReason: "loop",
    summary: `Loop: borrow ${formatToken(quote.sellAmount, WETH_DECIMALS)} WETH, swap to wstETH and resupply`
  };
}

type FundEscrowPlanInput = {
  targetUsdc: bigint;
  reason: string;
  capByEquityBps: boolean;
  harvestMaxSafe: boolean;
};

async function planFundEscrowAction(
  config: Config,
  billingProvider: ComputeBillingProvider,
  snapshot: Snapshot,
  account: `0x${string}`,
  input: FundEscrowPlanInput
): Promise<PlannedAction> {
  const quoteFailurePlan = (error: unknown): PlannedAction => {
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: swap quote unavailable (${detail})`
    };
  };

  const harvestTransferSpec = billingProvider.transferSpec("harvest");
  if (input.targetUsdc <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: no ${harvestTransferSpec.recipientLabel} deficit to fund`
    };
  }

  const hfGuard = config.hfTargetWad + config.hfBufferWad;
  const withdrawableBaseUsd = withdrawableCollateralForTarget(
    snapshot.position.totalCollateralBase,
    snapshot.position.totalDebtBase,
    snapshot.position.currentLiquidationThresholdBps,
    hfGuard
  );
  const withdrawableWstEth = usdToToken(withdrawableBaseUsd, WSTETH_DECIMALS, snapshot.prices.wstEthUsd);

  let maxSellWstEth = snapshot.balances.wstEth + withdrawableWstEth;

  if (input.capByEquityBps) {
    const equityUsd = safeSub(snapshot.position.totalCollateralBase, snapshot.position.totalDebtBase);
    const maxHarvestUsd = mulDiv(equityUsd, BigInt(config.maxHarvestEquityBps), BPS_DENOMINATOR);
    const maxHarvestWstEth = usdToToken(maxHarvestUsd, WSTETH_DECIMALS, snapshot.prices.wstEthUsd);
    maxSellWstEth = minBigInt(maxSellWstEth, maxHarvestWstEth);
  }

  const idleUsdc = snapshot.balances.usdc;
  const remainingUsdcNeeded = safeSub(input.targetUsdc, idleUsdc);

  if (!input.harvestMaxSafe && remainingUsdcNeeded <= 0n) {
    return planPayEscrowAction(config, billingProvider, snapshot, input.targetUsdc, input.reason);
  }

  if (maxSellWstEth <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: no safe harvest capacity without violating HF guard`
    };
  }

  let quote: SwapQuote;
  try {
    quote = input.harvestMaxSafe
      ? await getSwapQuote(config, {
          sellToken: config.wstEthAddress,
          buyToken: config.usdcAddress,
          sellAmount: maxSellWstEth,
          slippageBps: config.slippageBps,
          taker: account
        })
      : await getSwapQuote(config, {
          sellToken: config.wstEthAddress,
          buyToken: config.usdcAddress,
          buyAmount: remainingUsdcNeeded,
          slippageBps: config.slippageBps,
          taker: account
        });
  } catch (error) {
    return quoteFailurePlan(error);
  }

  if (quote.sellAmount > maxSellWstEth) {
    try {
      quote = await getSwapQuote(config, {
        sellToken: config.wstEthAddress,
        buyToken: config.usdcAddress,
        sellAmount: maxSellWstEth,
        slippageBps: config.slippageBps,
        taker: account
      });
    } catch (error) {
      return quoteFailurePlan(error);
    }
  }

  if (quote.sellAmount <= 0n || quote.buyAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: quote returned zero amount`
    };
  }

  const withdrawNeeded = safeSub(quote.sellAmount, snapshot.balances.wstEth);
  if (withdrawNeeded > withdrawableWstEth) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: required withdraw exceeds HF-safe collateral withdraw limit`
    };
  }

  const calls: Call[] = [];

  if (withdrawNeeded > 0n) {
    calls.push(callWithdraw(config.aavePoolAddress, config.wstEthAddress, withdrawNeeded, account));
  }

  calls.push(callApprove(config.wstEthAddress, quote.allowanceTarget, quote.sellAmount));
  calls.push({
    to: quote.to,
    data: quote.data,
    value: quote.value
  });

  // 0x quotes can include protocol/integrator fees, so `buyAmount` may be
  // optimistic relative to guaranteed settlement. Use minBuyAmount when present
  // to avoid over-transferring and reverting on insufficient USDC balance.
  const settledSwapUsdc = quote.minBuyAmount ?? quote.buyAmount;
  const availablePostSwapUsdc = idleUsdc + settledSwapUsdc;
  const transferAmount = input.harvestMaxSafe
    ? availablePostSwapUsdc
    : minBigInt(input.targetUsdc, availablePostSwapUsdc);

  if (transferAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      topupAmountUsdc: 0n,
      topupReason: input.reason,
      summary: `${input.reason}: no USDC available to transfer after harvest`
    };
  }

  calls.push(billingProvider.buildTopupTransferCall(config, transferAmount));

  const swapCostUsd = computeSwapCostUsd(
    quote.sellAmount,
    WSTETH_DECIMALS,
    snapshot.prices.wstEthUsd,
    quote.buyAmount,
    config.expectedDecimals.usdc,
    snapshot.prices.usdcUsd
  );

  return {
    decision: harvestTransferSpec.decision,
    calls,
    swapCostUsd,
    escrowPaymentUsdc: transferAmount,
    topupAmountUsdc: 0n,
    topupReason: input.reason,
    summary: `${input.reason}: harvest ${formatToken(quote.sellAmount, WSTETH_DECIMALS)} wstETH and fund ${harvestTransferSpec.recipientLabel} ${formatToken(transferAmount, config.expectedDecimals.usdc)} USDC`
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const billingProvider = createComputeBillingProvider(config);
  const chain = createChainContext(config);

  await validateStartup(config, chain);

  const smartAccount = await createSimpleSmartAccount({
    walletClient: chain.walletClient,
    owner: chain.owner.address,
    entryPointAddress: config.entryPointAddress,
    factoryAddress: config.factoryAddress,
    salt: config.smartAccountSalt
  });

  const bundler = createBundlerContext(chain.chain, config.bundlerRpcUrl, config.entryPointAddress);
  const paymaster = createOptionalPaymasterClient(config.paymasterRpcUrl, chain.chain);
  const circlePaymaster: CirclePaymasterConfig = {
    enabled: config.useCirclePaymaster,
    paymasterAddress: config.circlePaymasterAddress,
    usdcAddress: config.usdcAddress
  };
  const builderSuffix = buildDataSuffix(config.builderCode);

  const riskEngine: MonteCarloRiskEngine = createRiskEngineFromEnv();

  console.log(
    `[startup] chainId=${config.chainId} dryRun=${config.dryRun} billingMode=${billingProvider.mode}`
  );
  console.log(`[startup] smartAccount=${smartAccount.address}`);
  console.log(`[startup] entryPoint=${config.entryPointAddress}`);
  if (circlePaymaster.enabled) {
    console.log(`[startup] circlePaymaster=${circlePaymaster.paymasterAddress} (gas paid in USDC)`);
  }
  if (billingProvider.mode === "conway") {
    console.log(
      `[startup] conwayPayer=${config.conwayPayerAddress ?? "unconfigured"} creditsFloor=${formatToken(config.conwayCreditsMinBalanceUsdc, config.expectedDecimals.usdc)} payerFloor=${formatToken(config.conwayPayerMinBalanceUsdc, config.expectedDecimals.usdc)}`
    );
  }

  let nextIntervalMultiplier = 1;

  startScheduler(
    {
      getIntervalSeconds: () => config.runIntervalSeconds * Math.max(1, nextIntervalMultiplier)
    },
    async () => {
      const runTimestamp = nowIso();
      const runs = await readRunRecords(config.runLogPath, 500);
      const lastRun = runs[runs.length - 1];

      const initialSnapshot = await readChainSnapshot(chain.publicClient, config, smartAccount.address);
      const storageBefore = await readStorageState(config.snapshotPath);

      const newSample: WstEthRateSample = {
        timestamp: runTimestamp,
        chainId: config.chainId,
        blockNumber: initialSnapshot.blockNumber,
        wstEthPerToken: initialSnapshot.wstEthPerToken
      };

      const storageAfter = await appendRateSample(config.snapshotPath, newSample);
      const apr = estimateWstEthAprFromSamples(storageAfter.samples);

      const risk = await riskEngine.computeRisk(riskSnapshotFromChain(initialSnapshot, apr));
      const trailingGasUsd = trailingAvgGasCostUsd(runs, TRAILING_GAS_WINDOW);
      const perTickCostUsdc = algorithmicComputeCostUsdc({
        monthlyServerCostUsdc: config.monthlyServerCostUsdc,
        baseIntervalSeconds: config.runIntervalSeconds,
        trailingAvgGasCostUsd: trailingGasUsd,
        computeBufferBps: config.computeBufferBps,
        usdcDecimals: config.expectedDecimals.usdc
      });
      const perTickCostUsd = usdcToUsd(perTickCostUsdc, initialSnapshot.prices.usdcUsd, config.expectedDecimals.usdc);

      const initialRunwayStatus = await billingProvider.readRunwayBalanceUsdc(initialSnapshot);
      const initialRunway = buildRunway(config, initialRunwayStatus.creditBalanceUsdc, perTickCostUsdc);
      nextIntervalMultiplier = adaptiveIntervalMultiplier(initialRunway.urgency);
      const conwayMode = billingProvider.mode === "conway";
      const initialPayerBalanceUsdc = conwayMode
        ? await readUsdcBalanceForAddress(chain.publicClient, config.usdcAddress, config.conwayPayerAddress)
        : null;

      const baselineEconomics = computeEconomics({
        timestamp: runTimestamp,
        previousTimestamp: lastRun?.timestamp,
        collateralBaseUsd: initialSnapshot.position.totalCollateralBase,
        debtBaseUsd: initialSnapshot.position.totalDebtBase,
        borrowRateRay: initialSnapshot.reserve.currentVariableBorrowRateRay,
        wstEthAprWad: apr,
        gasCostUsd: trailingGasUsd,
        swapCostUsd: config.swapCostUsdEstimate,
        computeCostUsd: perTickCostUsd
      });

      const canRiskGate = isRiskAccepted(risk);
      const profitable = baselineEconomics.netDeltaUsd > 0n;
      const consecutiveLoops = computeConsecutiveLoopRuns(runs);
      const loopCap = effectiveMaxLoops(config.maxLoops, initialRunway.urgency);
      const nowMs = parseTimestampMs(runTimestamp) ?? Date.now();
      const payerFundingWindowStartMs = nowMs - 24 * 60 * 60 * 1000;
      const payerFundingUsedLast24hUsdc = conwayMode
        ? sumHistoricalPayerFundingUsdc(runs, payerFundingWindowStartMs, nowMs)
        : 0n;
      const payerFundingRemainingDailyUsdc = conwayMode
        ? safeSub(config.conwayPayerFundMaxUsdcPerDay, payerFundingUsedLast24hUsdc)
        : 0n;
      const payerFundingCooldownActive = conwayMode
        ? cooldownActive(nowMs, findLastSuccessfulPayerFundingMs(runs), config.conwayPayerFundCooldownSeconds)
        : false;
      const creditTopupCooldownActive = conwayMode
        ? cooldownActive(nowMs, findLastSuccessfulTopupMs(runs), config.conwayCreditsTopupCooldownSeconds)
        : false;

      const hfBelowTarget = initialSnapshot.position.healthFactor < config.hfTargetWad;
      const deficitToNominalUsdc = escrowDeficitUsdc(initialRunway, config.runwayNominalDays);
      const deficitToElevatedUsdc = escrowDeficitUsdc(initialRunway, config.runwayElevatedDays);
      const creditsTargetDeficitUsdc = conwayMode
        ? safeSub(config.conwayCreditsTargetBalanceUsdc, initialRunwayStatus.creditBalanceUsdc)
        : 0n;

      const equityUsd = safeSub(initialSnapshot.position.totalCollateralBase, initialSnapshot.position.totalDebtBase);
      const maxHarvestUsdcFromEquity = usdToToken(
        mulDiv(equityUsd, BigInt(config.maxHarvestEquityBps), BPS_DENOMINATOR),
        config.expectedDecimals.usdc,
        initialSnapshot.prices.usdcUsd
      );

      let planned: PlannedAction = {
        decision: "none",
        calls: [],
        swapCostUsd: 0n,
        escrowPaymentUsdc: 0n,
        topupAmountUsdc: 0n,
        topupReason: "No action",
        summary: "No action"
      };
      const routineTransferSpec = billingProvider.transferSpec("routine");

      if (hfBelowTarget) {
        planned = await planDeleverAction(config, initialSnapshot, smartAccount.address);
      } else if (conwayMode) {
        const payerBalanceUsdc = initialPayerBalanceUsdc ?? 0n;
        const payerLowFloor = payerBalanceUsdc < config.conwayPayerMinBalanceUsdc;
        const payerBelowTarget = payerBalanceUsdc < config.conwayPayerTargetBalanceUsdc;
        const creditsLowFloor = initialRunwayStatus.creditBalanceUsdc < config.conwayCreditsMinBalanceUsdc;

        const payerFundingTargetUsdc = clampByBudget(
          safeSub(config.conwayPayerTargetBalanceUsdc, payerBalanceUsdc),
          config.conwayPayerFundMaxUsdcPerTick,
          payerFundingRemainingDailyUsdc
        );

        const desiredCreditsTopupUsdc = maxBigInt(
          creditsTargetDeficitUsdc,
          initialRunway.urgency === "critical"
            ? deficitToElevatedUsdc
            : initialRunway.urgency === "dead" || initialRunway.urgency === "elevated"
              ? deficitToNominalUsdc
              : 0n
        );
        const maxTopupByPayerBalanceUsdc = safeSub(payerBalanceUsdc, config.conwayPayerMinBalanceUsdc);
        const cappedCreditsTopupUsdc = minBigInt(
          desiredCreditsTopupUsdc,
          minBigInt(config.conwayCreditsTopupMaxUsdcPerTick, maxTopupByPayerBalanceUsdc)
        );

        if ((initialRunway.urgency === "critical" || initialRunway.urgency === "dead") && payerLowFloor && creditsLowFloor) {
          if (payerFundingCooldownActive) {
            planned = {
              ...planned,
              summary: "Compute emergency: payer wallet low and credits low, but payer funding cooldown is active"
            };
          } else if (payerFundingTargetUsdc <= 0n) {
            planned = {
              ...planned,
              summary:
                "Compute emergency: payer wallet low and credits low, but payer funding budget cap is exhausted for this window"
            };
          } else {
            planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
              targetUsdc: payerFundingTargetUsdc,
              reason: "Compute emergency (credits + payer low)",
              capByEquityBps: true,
              harvestMaxSafe: initialRunway.urgency === "dead"
            });
          }
        } else if (payerLowFloor) {
          if (payerFundingCooldownActive) {
            planned = {
              ...planned,
              summary: "Payer wallet below floor, but payer funding cooldown is active"
            };
          } else if (payerFundingTargetUsdc <= 0n) {
            planned = {
              ...planned,
              summary: "Payer wallet below floor, but payer funding budget cap is exhausted"
            };
          } else if (
            initialRunway.urgency === "critical" ||
            initialRunway.urgency === "dead" ||
            initialSnapshot.balances.usdc < payerFundingTargetUsdc
          ) {
            planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
              targetUsdc: payerFundingTargetUsdc,
              reason: "Fund Conway payer runway",
              capByEquityBps: initialRunway.urgency !== "nominal",
              harvestMaxSafe: initialRunway.urgency === "dead"
            });
          } else {
            planned = planPayEscrowAction(
              config,
              billingProvider,
              initialSnapshot,
              payerFundingTargetUsdc,
              "Fund Conway payer runway"
            );
          }
        } else if (
          (creditsLowFloor || initialRunway.urgency === "critical" || initialRunway.urgency === "dead" || initialRunway.urgency === "elevated") &&
          desiredCreditsTopupUsdc > 0n
        ) {
          if (creditTopupCooldownActive) {
            planned = {
              ...planned,
              summary: "Conway credits below target runway, but topup cooldown is active"
            };
          } else if (cappedCreditsTopupUsdc > 0n) {
            planned = planConwayTopupAction(config, cappedCreditsTopupUsdc, "Top up Conway credits runway");
          } else if (!payerFundingCooldownActive && payerBelowTarget && payerFundingTargetUsdc > 0n) {
            planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
              targetUsdc: payerFundingTargetUsdc,
              reason: "Prepare Conway payer wallet for credit topups",
              capByEquityBps: initialRunway.urgency !== "nominal",
              harvestMaxSafe: initialRunway.urgency === "dead"
            });
          } else {
            planned = {
              ...planned,
              summary: "Conway credits below target runway, but payer wallet does not have topup budget above floor"
            };
          }
        } else if (initialRunway.urgency === "nominal" && profitable && consecutiveLoops < loopCap && canRiskGate) {
          planned = await planLoopAction(config, initialSnapshot, smartAccount.address);
        } else if (initialRunway.urgency === "elevated" && profitable && consecutiveLoops < loopCap && canRiskGate) {
          planned = await planLoopAction(config, initialSnapshot, smartAccount.address);
        } else if (
          initialRunway.urgency === "nominal" &&
          payerBelowTarget &&
          !payerFundingCooldownActive &&
          payerFundingTargetUsdc > 0n &&
          lastRun?.decision !== routineTransferSpec.decision
        ) {
          planned = planPayEscrowAction(
            config,
            billingProvider,
            initialSnapshot,
            payerFundingTargetUsdc,
            "Routine Conway payer refill from idle USDC"
          );
        }
      } else if (initialRunway.urgency === "critical" || initialRunway.urgency === "dead") {
        if (initialRunway.urgency === "critical") {
          const criticalTarget = minBigInt(deficitToElevatedUsdc, maxHarvestUsdcFromEquity);
          planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
            targetUsdc: criticalTarget,
            reason: "Compute emergency (critical runway)",
            capByEquityBps: true,
            harvestMaxSafe: false
          });
        } else {
          planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
            targetUsdc: maxHarvestUsdcFromEquity,
            reason: "Compute emergency (dead runway)",
            capByEquityBps: true,
            harvestMaxSafe: true
          });
        }
      } else if (initialRunway.urgency === "nominal" && profitable && consecutiveLoops < loopCap && canRiskGate) {
        planned = await planLoopAction(config, initialSnapshot, smartAccount.address);
      } else if (initialRunway.urgency === "elevated" && deficitToNominalUsdc > 0n) {
        planned = await planFundEscrowAction(config, billingProvider, initialSnapshot, smartAccount.address, {
          targetUsdc: deficitToNominalUsdc,
          reason: "Maintenance top-up (elevated runway)",
          capByEquityBps: false,
          harvestMaxSafe: false
        });
      } else if (initialRunway.urgency === "elevated" && profitable && consecutiveLoops < loopCap && canRiskGate) {
        planned = await planLoopAction(config, initialSnapshot, smartAccount.address);
      } else if (
        initialRunway.urgency === "nominal" &&
        initialSnapshot.balances.usdc > 0n &&
        lastRun?.decision !== routineTransferSpec.decision
      ) {
        planned = planPayEscrowAction(
          config,
          billingProvider,
          initialSnapshot,
          initialSnapshot.balances.usdc,
          "Routine payment from idle USDC"
        );
      }

      let runRecord: AgentRunRecord = {
        timestamp: runTimestamp,
        mode: config.dryRun ? "dry-run" : "live",
        chainId: config.chainId,
        account: smartAccount.address,
        decision: planned.decision,
        dryRun: config.dryRun,
        creditBalanceUsdc: initialRunwayStatus.creditBalanceUsdc,
        fundingSource: initialRunwayStatus.fundingSource,
        topupStatus: "not-attempted",
        topupAmountUsdc: 0n,
        payerAddress: config.conwayPayerAddress,
        payerBalanceUsdc: initialPayerBalanceUsdc ?? undefined,
        payerFundingUsdc: 0n,
        computeBurnUsdc: perTickCostUsdc,
        fallbackWarning: initialRunwayStatus.fallbackWarning,
        status: "skipped",
        position: initialSnapshot.position,
        balances: initialSnapshot.balances,
        rates: {
          wethVariableBorrowRateRay: initialSnapshot.reserve.currentVariableBorrowRateRay,
          wstEthPerToken: initialSnapshot.wstEthPerToken,
          wstEthAprWad: apr
        },
        economics: baselineEconomics,
        runway: initialRunway,
        risk,
        reason: planned.summary,
        provenance: buildRuntimeProvenance()
      };

      if (planned.decision === "none") {
        runRecord.status = "skipped";
        runRecord.reason = planned.summary;
        if (conwayMode && initialPayerBalanceUsdc !== null) {
          runRecord.reconciliation = buildConwayReconciliationSnapshot({
            runs,
            windowHours: config.conwayReconciliationWindowHours,
            nowIso: runTimestamp,
            payerEndBalanceUsdc: initialPayerBalanceUsdc,
            currentTopupUsdc: 0n,
            currentFundingUsdc: 0n,
            bootstrapUsdc: config.conwayReconciliationBootstrapUsdc
          });
          if (!runRecord.reconciliation.withinInvariant) {
            console.warn(
              `[billing] reconciliation invariant breached lhs=${formatToken(runRecord.reconciliation.lhsUsdc, config.expectedDecimals.usdc)} rhs=${formatToken(runRecord.reconciliation.rhsUsdc, config.expectedDecimals.usdc)}`
            );
          }
        }
        await appendRunRecord(config.runLogPath, runRecord);
        pushTelemetry("run", runRecord);
        console.log(
          `[run] skipped: ${planned.summary} runway=${toRunwayDaysString(initialRunway)}d urgency=${initialRunway.urgency} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s samples=${storageBefore.samples.length}->${storageAfter.samples.length}`
        );
        return;
      }

      if (planned.decision === "topup-credits") {
        let topupStatus: AgentRunRecord["topupStatus"] = "not-attempted";
        let topupAmountUsdc = planned.topupAmountUsdc;
        let runStatus: AgentRunRecord["status"] = "skipped";
        let runReason = planned.summary;

        if (config.dryRun) {
          topupStatus = "skipped";
          runStatus = "skipped";
          runReason = `Dry run: ${planned.summary}`;
        } else if (!billingProvider.topUpCredits) {
          topupStatus = "error";
          runStatus = "error";
          runReason = "Billing provider does not support Conway credit topups";
        } else {
          const topupResult = await billingProvider.topUpCredits(planned.topupAmountUsdc, planned.topupReason);
          topupStatus = topupResult.status;
          topupAmountUsdc = topupResult.amountUsdc;
          runStatus = topupResult.status === "ok" ? "ok" : topupResult.status === "skipped" ? "skipped" : "error";
          runReason = topupResult.summary;
        }

        const finalRunwayStatus = await billingProvider.readRunwayBalanceUsdc(initialSnapshot);
        const finalRunway = buildRunway(config, finalRunwayStatus.creditBalanceUsdc, perTickCostUsdc);
        nextIntervalMultiplier = adaptiveIntervalMultiplier(finalRunway.urgency);

        const finalEconomics = computeEconomics({
          timestamp: runTimestamp,
          previousTimestamp: lastRun?.timestamp,
          collateralBaseUsd: initialSnapshot.position.totalCollateralBase,
          debtBaseUsd: initialSnapshot.position.totalDebtBase,
          borrowRateRay: initialSnapshot.reserve.currentVariableBorrowRateRay,
          wstEthAprWad: apr,
          gasCostUsd: 0n,
          swapCostUsd: 0n,
          computeCostUsd: perTickCostUsd
        });
        const finalPayerBalanceUsdc = conwayMode
          ? await readUsdcBalanceForAddress(chain.publicClient, config.usdcAddress, config.conwayPayerAddress)
          : null;
        const currentTopupUsdc = topupStatus === "ok" ? topupAmountUsdc : 0n;

        runRecord = {
          ...runRecord,
          topupStatus,
          topupAmountUsdc,
          payerBalanceUsdc: finalPayerBalanceUsdc ?? runRecord.payerBalanceUsdc,
          payerFundingUsdc: 0n,
          computeBurnUsdc: perTickCostUsdc,
          status: runStatus,
          reason: runReason,
          runway: finalRunway,
          economics: finalEconomics,
          creditBalanceUsdc: finalRunwayStatus.creditBalanceUsdc,
          fundingSource: finalRunwayStatus.fundingSource,
          fallbackWarning: finalRunwayStatus.fallbackWarning
        };
        if (conwayMode && finalPayerBalanceUsdc !== null) {
          runRecord.reconciliation = buildConwayReconciliationSnapshot({
            runs,
            windowHours: config.conwayReconciliationWindowHours,
            nowIso: runTimestamp,
            payerEndBalanceUsdc: finalPayerBalanceUsdc,
            currentTopupUsdc,
            currentFundingUsdc: 0n,
            bootstrapUsdc: config.conwayReconciliationBootstrapUsdc
          });
          if (!runRecord.reconciliation.withinInvariant) {
            console.warn(
              `[billing] reconciliation invariant breached lhs=${formatToken(runRecord.reconciliation.lhsUsdc, config.expectedDecimals.usdc)} rhs=${formatToken(runRecord.reconciliation.rhsUsdc, config.expectedDecimals.usdc)}`
            );
          }
        }

        await appendRunRecord(config.runLogPath, runRecord);
        pushTelemetry("run", runRecord);
        console.log(
          `[run] ${runRecord.status} decision=${planned.decision} topupStatus=${runRecord.topupStatus} topupAmount=${formatToken(runRecord.topupAmountUsdc, config.expectedDecimals.usdc)} runway=${toRunwayDaysString(finalRunway)}d urgency=${finalRunway.urgency} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s`
        );
        return;
      }

      if (planned.calls.length === 0) {
        runRecord.status = "skipped";
        runRecord.reason = planned.summary;
        if (conwayMode && initialPayerBalanceUsdc !== null) {
          runRecord.reconciliation = buildConwayReconciliationSnapshot({
            runs,
            windowHours: config.conwayReconciliationWindowHours,
            nowIso: runTimestamp,
            payerEndBalanceUsdc: initialPayerBalanceUsdc,
            currentTopupUsdc: 0n,
            currentFundingUsdc: 0n,
            bootstrapUsdc: config.conwayReconciliationBootstrapUsdc
          });
          if (!runRecord.reconciliation.withinInvariant) {
            console.warn(
              `[billing] reconciliation invariant breached lhs=${formatToken(runRecord.reconciliation.lhsUsdc, config.expectedDecimals.usdc)} rhs=${formatToken(runRecord.reconciliation.rhsUsdc, config.expectedDecimals.usdc)}`
            );
          }
        }
        await appendRunRecord(config.runLogPath, runRecord);
        pushTelemetry("run", runRecord);
        console.log(
          `[run] skipped: ${planned.summary} runway=${toRunwayDaysString(initialRunway)}d urgency=${initialRunway.urgency} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s samples=${storageBefore.samples.length}->${storageAfter.samples.length}`
        );
        return;
      }

      // When Circle Paymaster is enabled, prepend a USDC approval so the
      // paymaster can pull USDC for gas. We use a generous approval amount
      // (1 USDC = 1e6) which covers typical L2 gas costs with margin.
      const CIRCLE_PAYMASTER_APPROVAL_USDC = 1_000_000n; // 1 USDC
      const executionCalls = circlePaymaster.enabled
        ? [buildCirclePaymasterApproval(circlePaymaster, CIRCLE_PAYMASTER_APPROVAL_USDC), ...planned.calls]
        : planned.calls;

      const rawCallData = await smartAccount.encodeCalls(executionCalls);
      const callDataWithSuffix = applySuffix(rawCallData, builderSuffix);

      if (!callDataHasSuffix(callDataWithSuffix, builderSuffix)) {
        throw new Error("Builder code suffix was not appended to userOp callData");
      }

      const usdcBalanceBefore = circlePaymaster.enabled ? initialSnapshot.balances.usdc : null;

      const result = await sendUserOperation(
        bundler,
        smartAccount,
        executionCalls,
        callDataWithSuffix,
        builderSuffix,
        config.dryRun,
        paymaster,
        circlePaymaster
      );

      let gasCostUsd = 0n;
      let gasPaymentUsdc: bigint | null = null;
      let liveSnapshot = initialSnapshot;

      if (!config.dryRun && result.txHash) {
        const receipt = await chain.publicClient.getTransactionReceipt({ hash: result.txHash });

        if (result.circlePaymasterUsed) {
          // Gas was paid in USDC — read the post-tx USDC balance to compute cost
          liveSnapshot = await readChainSnapshot(chain.publicClient, config, smartAccount.address);
          const usdcBalanceAfter = liveSnapshot.balances.usdc;
          // The difference in USDC balance attributable to gas (exclude escrow payments from planned calls)
          const totalUsdcDelta = (usdcBalanceBefore ?? 0n) - usdcBalanceAfter;
          gasPaymentUsdc = totalUsdcDelta > planned.escrowPaymentUsdc
            ? totalUsdcDelta - planned.escrowPaymentUsdc
            : 0n;
          // Convert USDC gas payment to USD (8-decimal) for economics tracking
          gasCostUsd = usdcToUsd(gasPaymentUsdc, initialSnapshot.prices.usdcUsd, config.expectedDecimals.usdc);
        } else {
          // Gas was paid in ETH — standard path
          const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
          gasCostUsd = computeGasCostUsd(gasCostWei, initialSnapshot.prices.wethUsd);
          liveSnapshot = await readChainSnapshot(chain.publicClient, config, smartAccount.address);
        }
      }

      const finalRunwayStatus = await billingProvider.readRunwayBalanceUsdc(liveSnapshot);
      const finalRunway = buildRunway(config, finalRunwayStatus.creditBalanceUsdc, perTickCostUsdc);
      nextIntervalMultiplier = adaptiveIntervalMultiplier(finalRunway.urgency);
      const finalPayerBalanceUsdc = conwayMode
        ? await readUsdcBalanceForAddress(chain.publicClient, config.usdcAddress, config.conwayPayerAddress)
        : null;
      const settledPayerFundingUsdc = conwayMode && !config.dryRun && result.success ? planned.escrowPaymentUsdc : 0n;

      const finalEconomics = computeEconomics({
        timestamp: runTimestamp,
        previousTimestamp: lastRun?.timestamp,
        collateralBaseUsd: liveSnapshot.position.totalCollateralBase,
        debtBaseUsd: liveSnapshot.position.totalDebtBase,
        borrowRateRay: liveSnapshot.reserve.currentVariableBorrowRateRay,
        wstEthAprWad: apr,
        gasCostUsd,
        swapCostUsd: planned.swapCostUsd,
        computeCostUsd: perTickCostUsd
      });

      // Record USDC gas payment in economics when Circle Paymaster was used
      if (gasPaymentUsdc !== null) {
        finalEconomics.gasPaymentUsdc = gasPaymentUsdc;
      }

      runRecord = {
        ...runRecord,
        position: liveSnapshot.position,
        balances: liveSnapshot.balances,
        rates: {
          wethVariableBorrowRateRay: liveSnapshot.reserve.currentVariableBorrowRateRay,
          wstEthPerToken: liveSnapshot.wstEthPerToken,
          wstEthAprWad: apr
        },
        economics: finalEconomics,
        runway: finalRunway,
        status: result.success ? "ok" : "error",
        reason: planned.summary,
        creditBalanceUsdc: finalRunwayStatus.creditBalanceUsdc,
        fundingSource: finalRunwayStatus.fundingSource,
        payerBalanceUsdc: finalPayerBalanceUsdc ?? runRecord.payerBalanceUsdc,
        payerFundingUsdc: settledPayerFundingUsdc,
        computeBurnUsdc: perTickCostUsdc,
        fallbackWarning: finalRunwayStatus.fallbackWarning
      };
      if (conwayMode && finalPayerBalanceUsdc !== null) {
        runRecord.reconciliation = buildConwayReconciliationSnapshot({
          runs,
          windowHours: config.conwayReconciliationWindowHours,
          nowIso: runTimestamp,
          payerEndBalanceUsdc: finalPayerBalanceUsdc,
          currentTopupUsdc: 0n,
          currentFundingUsdc: settledPayerFundingUsdc,
          bootstrapUsdc: config.conwayReconciliationBootstrapUsdc
        });
        if (!runRecord.reconciliation.withinInvariant) {
          console.warn(
            `[billing] reconciliation invariant breached lhs=${formatToken(runRecord.reconciliation.lhsUsdc, config.expectedDecimals.usdc)} rhs=${formatToken(runRecord.reconciliation.rhsUsdc, config.expectedDecimals.usdc)}`
          );
        }
      }

      if (result.userOpHash && result.txHash && result.blockNumber) {
        runRecord.userOp = {
          action: planned.decision,
          userOpHash: result.userOpHash,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          success: result.success,
          callData: rawCallData,
          callDataWithSuffix,
          builderSuffix,
          summary: planned.summary,
          timestamp: runTimestamp
        };
      }

      await appendRunRecord(config.runLogPath, runRecord);
      pushTelemetry("run", runRecord);

      const aprLabel = apr ? toWadPercentString(apr) : "n/a";
      const gasLabel = gasPaymentUsdc !== null
        ? `gasUsdc=${formatToken(gasPaymentUsdc, config.expectedDecimals.usdc)}`
        : `gasUsd=${formatToken(gasCostUsd, 8)}`;
      console.log(
        `[run] ${runRecord.status} decision=${planned.decision} hf=${toHfString(liveSnapshot.position.healthFactor)} apr=${aprLabel} net=${formatToken(finalEconomics.netDeltaUsd, 8)} usd ${gasLabel} runway=${toRunwayDaysString(finalRunway)}d urgency=${finalRunway.urgency} billingTransfer=${formatToken(planned.escrowPaymentUsdc, config.expectedDecimals.usdc)} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s`
      );

      if (runRecord.userOp) {
        console.log(`[run] userOp=${runRecord.userOp.userOpHash} tx=${runRecord.userOp.txHash}`);
      }
    }
  );
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[fatal]", message);

  try {
    const config = loadConfig();
    const fallbackRecord: AgentRunRecord = {
      timestamp: nowIso(),
      mode: config.dryRun ? "dry-run" : "live",
      chainId: config.chainId,
      account: "0x0000000000000000000000000000000000000000",
      decision: "none",
      dryRun: config.dryRun,
      creditBalanceUsdc: 0n,
      fundingSource: "escrow",
      topupStatus: "not-attempted",
      topupAmountUsdc: 0n,
      status: "error",
      reason: message,
      position: {
        totalCollateralBase: 0n,
        totalDebtBase: 0n,
        availableBorrowsBase: 0n,
        currentLiquidationThresholdBps: 0n,
        currentLtvBps: 0n,
        healthFactor: 0n
      },
      balances: {
        eth: 0n,
        weth: 0n,
        wstEth: 0n,
        usdc: 0n
      },
      rates: {
        wethVariableBorrowRateRay: 0n,
        wstEthPerToken: 0n,
        wstEthAprWad: null
      },
      economics: {
        intervalSeconds: 0n,
        yieldDeltaUsd: 0n,
        interestDeltaUsd: 0n,
        gasCostUsd: 0n,
        swapCostUsd: 0n,
        computeCostUsd: 0n,
        netDeltaUsd: 0n,
        breakEvenEquityUsdApprox: null,
        leverageWad: 0n,
        gasPaymentUsdc: null,
        notes: ["fatal startup/runtime error"]
      },
      risk: {
        status: "unavailable",
        notes: "risk engine unavailable; policy fallback uses HF-only guardrails"
      },
      provenance: buildRuntimeProvenance()
    };

    await appendRunRecord(config.runLogPath, fallbackRecord);
    pushTelemetry("run", fallbackRecord);
  } catch {
    // ignore fallback logging failures
  }

  process.exit(1);
});
