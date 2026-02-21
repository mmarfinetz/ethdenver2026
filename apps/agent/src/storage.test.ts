import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRunRecord } from "@ssa/shared/types";
import { appendRunRecord, readRunRecords } from "./storage";

const DECISIONS: AgentRunRecord["decision"][] = [
  "none",
  "loop",
  "delever",
  "fund-escrow",
  "pay-escrow"
];

function makeRun(decision: AgentRunRecord["decision"], index: number): AgentRunRecord {
  return {
    timestamp: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
    mode: "live",
    chainId: 8453,
    account: "0x0000000000000000000000000000000000000000",
    decision,
    dryRun: false,
    position: {
      totalCollateralBase: 1_000_000_000n,
      totalDebtBase: 500_000_000n,
      availableBorrowsBase: 0n,
      currentLiquidationThresholdBps: 8_000n,
      currentLtvBps: 7_500n,
      healthFactor: 1_600_000_000_000_000_000n
    },
    balances: {
      eth: 0n,
      weth: 0n,
      wstEth: 0n,
      usdc: 1_000_000n
    },
    rates: {
      wethVariableBorrowRateRay: 0n,
      wstEthPerToken: 1_000_000_000_000_000_000n,
      wstEthAprWad: 30_000_000_000_000_000n
    },
    economics: {
      intervalSeconds: 60n,
      yieldDeltaUsd: 0n,
      interestDeltaUsd: 0n,
      gasCostUsd: 1_000n,
      swapCostUsd: 0n,
      computeCostUsd: 500n,
      netDeltaUsd: 0n,
      breakEvenEquityUsdApprox: null,
      leverageWad: 0n,
      gasPaymentUsdc: BigInt(index),
      notes: []
    },
    runway: {
      escrowBalanceUsdc: 1_000_000n,
      perTickCostUsdc: 100n,
      runwayDaysWad: 1_000_000_000_000_000_000n,
      urgency: "elevated",
      baseIntervalSeconds: 60n,
      ticksPerDayWad: 1_440_000_000_000_000_000_000n,
      nominalDays: 14n,
      elevatedDays: 7n,
      deadDays: 2n
    },
    risk: {
      status: "available",
      pLiq7d: 0.01,
      pLiq30d: 0.05,
      notes: "ok"
    },
    status: "ok",
    reason: "baseline"
  };
}

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-storage-test-"));
  const path = join(dir, "runs.ndjson");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readRunRecords preserves supported decisions and bigint fields", async () => {
  await withTempDir(async (path) => {
    for (let i = 0; i < DECISIONS.length; i += 1) {
      await appendRunRecord(path, makeRun(DECISIONS[i], i + 1));
    }

    const runs = await readRunRecords(path, 50);

    assert.equal(runs.length, DECISIONS.length);
    assert.deepEqual(
      runs.map((run) => run.decision),
      DECISIONS
    );
    assert.equal(runs[0]?.economics.gasPaymentUsdc, 1n);
    assert.equal(runs[4]?.economics.gasPaymentUsdc, 5n);
    assert.equal(runs[2]?.runway?.urgency, "elevated");
    assert.equal(runs[2]?.runway?.nominalDays, 14n);
  });
});

test("readRunRecords returns empty array when file is missing", async () => {
  await withTempDir(async (path) => {
    const missingPath = `${path}.missing`;
    const runs = await readRunRecords(missingPath, 10);
    assert.deepEqual(runs, []);
  });
});
