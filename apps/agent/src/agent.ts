import type { AgentRunRecord, ComputeRunway, WstEthRateSample } from "@ssa/shared/types";
import { BPS_DENOMINATOR, WETH_DECIMALS, WSTETH_DECIMALS } from "@ssa/shared/constants";
import { formatToken, mulDiv, safeSub } from "@ssa/shared/utils";
import {
  callApprove,
  callBorrow,
  callRepay,
  callSupply,
  callTransfer,
  callWithdraw,
  readChainSnapshot,
  tokenToUsd,
  usdToToken,
  usdcToUsd
} from "./aave";
import { createBundlerContext, sendUserOperation, type Call } from "./aa/bundler";
import { createOptionalPaymasterClient } from "./aa/paymaster";
import { createSimpleSmartAccount } from "./aa/smartAccount";
import { applySuffix, buildDataSuffix, callDataHasSuffix } from "./builderCodes";
import { createChainContext, validateStartup } from "./chain";
import { loadConfig } from "./config";
import { getSwapQuote } from "./dex";
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
import {
  appendRateSample,
  appendRunRecord,
  readRunRecords,
  readStorageState
} from "./storage";

const TRAILING_GAS_WINDOW = 50;

type Snapshot = Awaited<ReturnType<typeof readChainSnapshot>>;
type Config = ReturnType<typeof loadConfig>;

type PlannedAction = {
  decision: AgentRunRecord["decision"];
  calls: Call[];
  swapCostUsd: bigint;
  escrowPaymentUsdc: bigint;
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

function riskSnapshotFromChain(snapshot: Snapshot, apr: bigint | null): RiskSnapshot {
  return {
    healthFactorWad: snapshot.position.healthFactor,
    collateralBaseUsd: snapshot.position.totalCollateralBase,
    debtBaseUsd: snapshot.position.totalDebtBase,
    borrowRateRay: snapshot.reserve.currentVariableBorrowRateRay,
    wstEthAprWad: apr
  };
}

function buildRunway(config: Config, escrowBalanceUsdc: bigint, perTickCostUsdc: bigint): ComputeRunway {
  return computeRunway({
    escrowBalanceUsdc,
    perTickCostUsdc,
    baseIntervalSeconds: config.runIntervalSeconds,
    nominalDays: config.runwayNominalDays,
    elevatedDays: config.runwayElevatedDays,
    deadDays: config.runwayDeadDays
  });
}

function planPayEscrowAction(config: Config, snapshot: Snapshot, amountUsdc: bigint, reason: string): PlannedAction {
  const transferAmount = minBigInt(amountUsdc, snapshot.balances.usdc);

  if (transferAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      summary: "No idle USDC available for escrow payment"
    };
  }

  return {
    decision: "pay-escrow",
    calls: [callTransfer(config.usdcAddress, config.escrowAddress, transferAmount)],
    swapCostUsd: 0n,
    escrowPaymentUsdc: transferAmount,
    summary: `${reason}: pay ${formatToken(transferAmount, config.expectedDecimals.usdc)} USDC to escrow`
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
      summary: "Repay amount rounded to zero"
    };
  }

  const calls: Call[] = [];
  let swapCostUsd = 0n;

  if (snapshot.balances.weth < repayWeth) {
    const neededWeth = repayWeth - snapshot.balances.weth;

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
  snapshot: Snapshot,
  account: `0x${string}`,
  input: FundEscrowPlanInput
): Promise<PlannedAction> {
  if (input.targetUsdc <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      summary: `${input.reason}: no escrow deficit to fund`
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
    return planPayEscrowAction(config, snapshot, input.targetUsdc, input.reason);
  }

  if (maxSellWstEth <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      summary: `${input.reason}: no safe harvest capacity without violating HF guard`
    };
  }

  let quote = input.harvestMaxSafe
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

  if (quote.sellAmount > maxSellWstEth) {
    quote = await getSwapQuote(config, {
      sellToken: config.wstEthAddress,
      buyToken: config.usdcAddress,
      sellAmount: maxSellWstEth,
      slippageBps: config.slippageBps,
      taker: account
    });
  }

  if (quote.sellAmount <= 0n || quote.buyAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
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

  const availablePostSwapUsdc = idleUsdc + quote.buyAmount;
  const transferAmount = input.harvestMaxSafe
    ? availablePostSwapUsdc
    : minBigInt(input.targetUsdc, availablePostSwapUsdc);

  if (transferAmount <= 0n) {
    return {
      decision: "none",
      calls: [],
      swapCostUsd: 0n,
      escrowPaymentUsdc: 0n,
      summary: `${input.reason}: no USDC available to transfer after harvest`
    };
  }

  calls.push(callTransfer(config.usdcAddress, config.escrowAddress, transferAmount));

  const swapCostUsd = computeSwapCostUsd(
    quote.sellAmount,
    WSTETH_DECIMALS,
    snapshot.prices.wstEthUsd,
    quote.buyAmount,
    config.expectedDecimals.usdc,
    snapshot.prices.usdcUsd
  );

  return {
    decision: "fund-escrow",
    calls,
    swapCostUsd,
    escrowPaymentUsdc: transferAmount,
    summary: `${input.reason}: harvest ${formatToken(quote.sellAmount, WSTETH_DECIMALS)} wstETH and fund escrow ${formatToken(transferAmount, config.expectedDecimals.usdc)} USDC`
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
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
  const builderSuffix = buildDataSuffix(config.builderCode);

  const riskEngine: MonteCarloRiskEngine = createRiskEngineFromEnv();

  console.log(`[startup] chainId=${config.chainId} dryRun=${config.dryRun}`);
  console.log(`[startup] smartAccount=${smartAccount.address}`);
  console.log(`[startup] entryPoint=${config.entryPointAddress}`);

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

      const initialRunway = buildRunway(config, initialSnapshot.escrowUsdc, perTickCostUsdc);
      nextIntervalMultiplier = adaptiveIntervalMultiplier(initialRunway.urgency);

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

      const hfBelowTarget = initialSnapshot.position.healthFactor < config.hfTargetWad;
      const deficitToNominalUsdc = escrowDeficitUsdc(initialRunway, config.runwayNominalDays);
      const deficitToElevatedUsdc = escrowDeficitUsdc(initialRunway, config.runwayElevatedDays);

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
        summary: "No action"
      };

      if (hfBelowTarget) {
        planned = await planDeleverAction(config, initialSnapshot, smartAccount.address);
      } else if (initialRunway.urgency === "critical" || initialRunway.urgency === "dead") {
        if (initialRunway.urgency === "critical") {
          const criticalTarget = minBigInt(deficitToElevatedUsdc, maxHarvestUsdcFromEquity);
          planned = await planFundEscrowAction(config, initialSnapshot, smartAccount.address, {
            targetUsdc: criticalTarget,
            reason: "Compute emergency (critical runway)",
            capByEquityBps: true,
            harvestMaxSafe: false
          });
        } else {
          planned = await planFundEscrowAction(config, initialSnapshot, smartAccount.address, {
            targetUsdc: maxHarvestUsdcFromEquity,
            reason: "Compute emergency (dead runway)",
            capByEquityBps: true,
            harvestMaxSafe: true
          });
        }
      } else if (initialRunway.urgency === "nominal" && profitable && consecutiveLoops < loopCap && canRiskGate) {
        planned = await planLoopAction(config, initialSnapshot, smartAccount.address);
      } else if (initialRunway.urgency === "elevated" && deficitToNominalUsdc > 0n) {
        planned = await planFundEscrowAction(config, initialSnapshot, smartAccount.address, {
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
        lastRun?.decision !== "pay-escrow"
      ) {
        planned = planPayEscrowAction(
          config,
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

      if (planned.decision === "none" || planned.calls.length === 0) {
        runRecord.status = "skipped";
        runRecord.reason = planned.summary;
        await appendRunRecord(config.runLogPath, runRecord);
        console.log(
          `[run] skipped: ${planned.summary} runway=${toRunwayDaysString(initialRunway)}d urgency=${initialRunway.urgency} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s samples=${storageBefore.samples.length}->${storageAfter.samples.length}`
        );
        return;
      }

      const rawCallData = await smartAccount.encodeCalls(planned.calls);
      const callDataWithSuffix = applySuffix(rawCallData, builderSuffix);

      if (!callDataHasSuffix(callDataWithSuffix, builderSuffix)) {
        throw new Error("Builder code suffix was not appended to userOp callData");
      }

      const result = await sendUserOperation(
        bundler,
        smartAccount,
        planned.calls,
        callDataWithSuffix,
        builderSuffix,
        config.dryRun,
        paymaster
      );

      let gasCostUsd = 0n;
      let liveSnapshot = initialSnapshot;

      if (!config.dryRun && result.txHash) {
        const receipt = await chain.publicClient.getTransactionReceipt({ hash: result.txHash });
        const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
        gasCostUsd = computeGasCostUsd(gasCostWei, initialSnapshot.prices.wethUsd);
        liveSnapshot = await readChainSnapshot(chain.publicClient, config, smartAccount.address);
      }

      const finalRunway = buildRunway(config, liveSnapshot.escrowUsdc, perTickCostUsdc);
      nextIntervalMultiplier = adaptiveIntervalMultiplier(finalRunway.urgency);

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
        reason: planned.summary
      };

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

      const aprLabel = apr ? toWadPercentString(apr) : "n/a";
      console.log(
        `[run] ${runRecord.status} decision=${planned.decision} hf=${toHfString(liveSnapshot.position.healthFactor)} apr=${aprLabel} net=${formatToken(finalEconomics.netDeltaUsd, 8)} usd runway=${toRunwayDaysString(finalRunway)}d urgency=${finalRunway.urgency} escrowPaid=${formatToken(planned.escrowPaymentUsdc, config.expectedDecimals.usdc)} nextInterval=${config.runIntervalSeconds * nextIntervalMultiplier}s`
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
        notes: ["fatal startup/runtime error"]
      },
        risk: {
          status: "unavailable",
          notes: "risk engine unavailable; policy fallback uses HF-only guardrails"
        },
        provenance: buildRuntimeProvenance()
      };

    await appendRunRecord(config.runLogPath, fallbackRecord);
  } catch {
    // ignore fallback logging failures
  }

  process.exit(1);
});
