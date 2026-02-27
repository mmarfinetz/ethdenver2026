import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../config";
import { AlchemyBillingProvider } from "./alchemyProvider";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    chainId: 8453,
    dryRun: true,
    allowTestnet: false,
    computeBillingMode: "alchemy",
    baseRpcUrl: "https://mainnet.base.org",
    bundlerRpcUrl: "https://public.pimlico.io/v2/8453/rpc",
    paymasterRpcUrl: undefined,
    useCirclePaymaster: false,
    circlePaymasterAddress: "0x6C973eBe80dCD8660841D4356bf15c32460271C9",
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    entryPointVersion: "0.7",
    factoryAddress: "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985",
    ownerPrivateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    smartAccountSalt: 0n,
    builderCode: "bc_test",
    hfTargetWad: 1_600_000_000_000_000_000n,
    hfBufferWad: 100_000_000_000_000_000n,
    maxLoops: 5,
    loopBorrowBps: 3_500,
    runIntervalSeconds: 60,
    escrowAddress: "0x0000000000000000000000000000000000000001",
    monthlyServerCostUsdc: 7_500_000n,
    computeBufferBps: 2_000,
    runwayNominalDays: 14,
    runwayElevatedDays: 7,
    runwayDeadDays: 2,
    maxHarvestEquityBps: 500,
    slippageBps: 100,
    wstEthAddress: "0x0000000000000000000000000000000000000002",
    wethAddress: "0x0000000000000000000000000000000000000003",
    usdcAddress: "0x0000000000000000000000000000000000000004",
    aavePoolAddress: "0x0000000000000000000000000000000000000005",
    dexRouterAddress: "0x0000000000000000000000000000000000000006",
    zrxApiUrl: "https://base.api.0x.org/swap/allowance-holder/quote",
    zrxApiKey: undefined,
    conwayApiBaseUrl: "https://api.g.alchemy.com",
    conwayApiKey: "alchemy-key",
    conwayCreditsBalancePath: "/v1/credits/balance",
    conwayCreditsTopupPath: "/pay",
    conwayPaymentRecipientAddress: "0x0000000000000000000000000000000000000007",
    conwayPayerAddress: "0x0000000000000000000000000000000000000008",
    conwayX402Enabled: true,
    conwayPayerPrivateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    conwayX402HeaderName: "payment-signature",
    conwayFallbackToEscrowOnError: true,
    conwayCreditsMinBalanceUsdc: 10_000_000n,
    conwayCreditsTargetBalanceUsdc: 50_000_000n,
    conwayCreditsTopupMaxUsdcPerTick: 25_000_000n,
    conwayCreditsTopupCooldownSeconds: 900,
    conwayPayerMinBalanceUsdc: 5_000_000n,
    conwayPayerTargetBalanceUsdc: 25_000_000n,
    conwayPayerFundMaxUsdcPerTick: 25_000_000n,
    conwayPayerFundMaxUsdcPerDay: 100_000_000n,
    conwayPayerFundCooldownSeconds: 900,
    conwayReconciliationBootstrapUsdc: 0n,
    conwayReconciliationWindowHours: 24,
    runLogPath: "./data/runs.ndjson",
    snapshotPath: "./data/wsteth-snapshots.json",
    swapCostUsdEstimate: 0n,
    expectedDecimals: {
      usdc: 6,
      weth: 18,
      wstEth: 18
    },
    ...overrides
  };
}

test("AlchemyBillingProvider remaps credits funding source and labels", async () => {
  const provider = new AlchemyBillingProvider(makeConfig());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ credits: { balanceUsdc: "12340000" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  try {
    const runway = await provider.readRunwayBalanceUsdc({ escrowUsdc: 0n });
    assert.equal(runway.creditBalanceUsdc, 12_340_000n);
    assert.equal(runway.fundingSource, "alchemy-credits");
    assert.deepEqual(provider.transferSpec("routine"), {
      decision: "pay-escrow",
      recipientLabel: "Alchemy payer wallet"
    });
    assert.deepEqual(provider.transferSpec("harvest"), {
      decision: "fund-escrow",
      recipientLabel: "Alchemy payer wallet"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
