import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRecord } from "@ssa/shared/types";
import {
  algorithmicComputeCostUsdc,
  computePerTickServerCostUsdc,
  trailingAvgGasCostUsd
} from "./economics";

function makeRun(gasCostUsd: bigint): AgentRunRecord {
  return {
    timestamp: new Date().toISOString(),
    mode: "live",
    chainId: 8453,
    account: "0x0000000000000000000000000000000000000000",
    decision: "none",
    dryRun: false,
    creditBalanceUsdc: 0n,
    fundingSource: "escrow",
    topupStatus: "not-attempted",
    topupAmountUsdc: 0n,
    status: "ok",
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
      intervalSeconds: 60n,
      yieldDeltaUsd: 0n,
      interestDeltaUsd: 0n,
      gasCostUsd,
      swapCostUsd: 0n,
      computeCostUsd: 0n,
      netDeltaUsd: 0n,
      breakEvenEquityUsdApprox: null,
      leverageWad: 0n,
      gasPaymentUsdc: null,
      notes: []
    },
    risk: {
      status: "unavailable",
      notes: "n/a"
    }
  };
}

test("computePerTickServerCostUsdc amortizes monthly fixed cost with base interval", () => {
  const monthlyServerCostUsdc = 7_500_000n; // 7.50 USDC
  const perTick = computePerTickServerCostUsdc(monthlyServerCostUsdc, 60);
  assert.equal(perTick, 174n);
});

test("trailingAvgGasCostUsd uses only onchain runs with gasCostUsd > 0", () => {
  const runs: AgentRunRecord[] = [
    makeRun(0n),
    makeRun(1_000n),
    makeRun(2_000n),
    makeRun(0n),
    makeRun(3_000n)
  ];

  const avg = trailingAvgGasCostUsd(runs, 50);
  assert.equal(avg, 2_000n);
});

test("algorithmicComputeCostUsdc adds server + trailing gas + buffer", () => {
  const perTickCost = algorithmicComputeCostUsdc({
    monthlyServerCostUsdc: 7_500_000n,
    baseIntervalSeconds: 60,
    trailingAvgGasCostUsd: 1_500n,
    computeBufferBps: 2_000,
    usdcDecimals: 6
  });

  // server 174 + gas 15 + 20% buffer => 226
  assert.equal(perTickCost, 226n);
});
