import assert from "node:assert/strict";
import { test } from "node:test";
import { erc20Abi } from "@ssa/shared/abis";
import type { AgentConfig } from "../config";
import { decodeFunctionData } from "viem";
import { ConwayBillingProvider, extractBalanceUsdc } from "./conwayProvider";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    chainId: 8453,
    dryRun: true,
    allowTestnet: false,
    computeBillingMode: "conway",
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
    conwayApiBaseUrl: "https://api.conway.test",
    conwayApiKey: undefined,
    conwayCreditsBalancePath: "/v1/credits/balance",
    conwayCreditsTopupPath: "/v1/credits/topup",
    conwayPaymentRecipientAddress: "0x0000000000000000000000000000000000000007",
    conwayPayerAddress: "0x0000000000000000000000000000000000000008",
    conwayX402Enabled: true,
    conwayPayerPrivateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    conwayX402HeaderName: "x-payment",
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

test("extractBalanceUsdc supports nested payload shapes", () => {
  assert.equal(extractBalanceUsdc({ balanceUsdc: "1234" }), 1234n);
  assert.equal(extractBalanceUsdc({ credits: { balance: "55" } }), 55n);
  assert.equal(extractBalanceUsdc({ data: { balanceUsdc: 99 } }), 99n);
  assert.equal(extractBalanceUsdc({ credits_cents: "1234" }), 12_340_000n);
  assert.equal(extractBalanceUsdc({}), null);
});

test("ConwayBillingProvider builds transfer call to configured topup recipient", () => {
  const config = makeConfig();
  const provider = new ConwayBillingProvider(config);
  const transferCall = provider.buildTopupTransferCall(config, 77n);

  assert.equal(transferCall.to, config.usdcAddress);
  const decoded = decodeFunctionData({
    abi: erc20Abi,
    data: transferCall.data
  });
  assert.equal(decoded.functionName, "transfer");
  assert.deepEqual(decoded.args, [config.conwayPayerAddress, 77n]);
  assert.deepEqual(provider.transferSpec("routine"), {
    decision: "pay-escrow",
    recipientLabel: "Conway payer wallet"
  });
  assert.deepEqual(provider.transferSpec("harvest"), {
    decision: "fund-escrow",
    recipientLabel: "Conway payer wallet"
  });
});

test("ConwayBillingProvider falls back to escrow balance when API read fails and fallback is enabled", async () => {
  const provider = new ConwayBillingProvider(makeConfig({ conwayFallbackToEscrowOnError: true }));
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    throw new Error("network unavailable");
  }) as typeof fetch;

  try {
    const runway = await provider.readRunwayBalanceUsdc({ escrowUsdc: 42n });
    assert.equal(runway.creditBalanceUsdc, 42n);
    assert.equal(runway.fundingSource, "escrow-fallback");
    assert.equal(typeof runway.fallbackWarning, "string");
    assert.equal((runway.fallbackWarning ?? "").includes("network unavailable"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider retries topup with signed EIP-3009 payload after HTTP 402", async () => {
  const config = makeConfig({ conwayCreditsTopupPath: "/pay" });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; method: string | undefined }> = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, method: init?.method });

    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }, { amount: 100 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const expectedTopupUrl = `https://api.conway.test/pay/25/${config.conwayPayerAddress}`;
    if (url === expectedTopupUrl && requests.filter((request) => request.url === expectedTopupUrl).length === 1) {
      return new Response(
        JSON.stringify({
          paymentHeaderName: config.conwayX402HeaderName,
          requirementId: "req-402",
          transferWithAuthorization: {
            to: config.conwayPaymentRecipientAddress,
            value: "25000000",
            validAfter: "0",
            validBefore: "4102444800",
            nonce: `0x${"11".repeat(32)}`,
            token: config.usdcAddress,
            chainId: config.chainId
          }
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    assert.equal(url, expectedTopupUrl);
    assert.equal(init?.method, "GET");

    const paymentHeader = headers.get(config.conwayX402HeaderName);
    assert.equal(typeof paymentHeader, "string");
    assert.equal((paymentHeader ?? "").length > 0, true);
    const decoded = JSON.parse(Buffer.from(paymentHeader as string, "base64").toString("utf8")) as Record<string, unknown>;
    assert.equal(decoded.type, "eip3009");
    assert.equal(decoded.requirementId, "req-402");
    assert.equal(typeof decoded.signature, "string");

    return new Response(
      JSON.stringify({
        topup: {
          creditedUsdc: "25000000"
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(25_000_000n, "test topup");
    assert.equal(result.status, "ok");
    assert.equal(result.amountUsdc, 25_000_000n);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.url.endsWith("/v1/credits/pricing"), true);
    assert.equal(requests[1]?.headers.get(config.conwayX402HeaderName), null);
    assert.equal((requests[2]?.headers.get(config.conwayX402HeaderName) ?? "").length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider retries /pay topup for x402 v2 accepts challenge", async () => {
  const config = makeConfig({ conwayCreditsTopupPath: "/pay" });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; method: string | undefined }> = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, method: init?.method });

    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }, { amount: 100 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const expectedTopupUrl = `https://api.conway.test/pay/25/${config.conwayPayerAddress}`;
    if (url === expectedTopupUrl && requests.filter((request) => request.url === expectedTopupUrl).length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              maxAmountRequired: "25000000",
              payTo: config.conwayPaymentRecipientAddress,
              asset: config.usdcAddress,
              maxTimeoutSeconds: 30
            }
          ]
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            "x-payment-required": "true"
          }
        }
      );
    }

    assert.equal(url, expectedTopupUrl);
    assert.equal(init?.method, "GET");

    const paymentHeader = headers.get(config.conwayX402HeaderName);
    assert.equal(typeof paymentHeader, "string");
    assert.equal((paymentHeader ?? "").length > 0, true);
    const decoded = JSON.parse(Buffer.from(paymentHeader as string, "base64").toString("utf8")) as Record<string, unknown>;
    assert.equal(decoded.scheme, "exact");
    assert.equal(decoded.network, "eip155:8453");

    const payload = decoded.payload as Record<string, unknown>;
    const authorization = payload.authorization as Record<string, unknown>;
    assert.equal(String(authorization.to).toLowerCase(), String(config.conwayPaymentRecipientAddress).toLowerCase());
    assert.equal(String(authorization.value), "25000000");
    assert.equal(typeof payload.signature, "string");

    return new Response(
      JSON.stringify({
        topup: {
          creditedUsdc: "25000000"
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(25_000_000n, "x402 v2");
    assert.equal(result.status, "ok");
    assert.equal(result.amountUsdc, 25_000_000n);
    assert.equal(requests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider uses payment-signature header when PAYMENT-REQUIRED challenge is returned", async () => {
  const config = makeConfig({ conwayCreditsTopupPath: "/pay", conwayX402HeaderName: "x-payment" });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; method: string | undefined }> = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, method: init?.method });

    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const expectedTopupUrl = `https://api.conway.test/pay/25/${config.conwayPayerAddress}`;
    if (url === expectedTopupUrl && requests.filter((request) => request.url === expectedTopupUrl).length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              maxAmountRequired: "25000000",
              payTo: config.conwayPaymentRecipientAddress,
              asset: config.usdcAddress,
              maxTimeoutSeconds: 30
            }
          ]
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            "payment-required": "true"
          }
        }
      );
    }

    assert.equal(url, expectedTopupUrl);
    assert.equal(init?.method, "GET");
    const paymentHeader = headers.get("payment-signature");
    assert.equal(typeof paymentHeader, "string");
    assert.equal((paymentHeader ?? "").length > 0, true);

    return new Response(
      JSON.stringify({
        topup: {
          creditedUsdc: "25000000"
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(25_000_000n, "x402 standard header");
    assert.equal(result.status, "ok");
    assert.equal(result.amountUsdc, 25_000_000n);
    assert.equal(requests.length, 3);
    assert.equal((requests[2]?.headers.get("payment-signature") ?? "").length > 0, true);
    assert.equal(requests[2]?.headers.get("x-payment"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider resolves credits recipient from /v1/auth/me when API key is configured", async () => {
  const discoveredRecipient = "0x0000000000000000000000000000000000000009";
  const config = makeConfig({
    conwayCreditsTopupPath: "/pay",
    conwayApiKey: "test-key"
  });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });

    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/v1/auth/me")) {
      return new Response(
        JSON.stringify({
          user: {
            wallet_address: discoveredRecipient
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const expectedTopupUrl = `https://api.conway.test/pay/25/${discoveredRecipient}`;
    if (url === expectedTopupUrl && headers.get(config.conwayX402HeaderName) == null) {
      return new Response(
        JSON.stringify({
          paymentHeaderName: config.conwayX402HeaderName,
          requirementId: "req-discovered-recipient",
          transferWithAuthorization: {
            to: config.conwayPaymentRecipientAddress,
            value: "25000000",
            validAfter: "0",
            validBefore: "4102444800",
            nonce: `0x${"33".repeat(32)}`,
            token: config.usdcAddress,
            chainId: config.chainId
          }
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url === expectedTopupUrl && headers.get(config.conwayX402HeaderName) != null) {
      return new Response(
        JSON.stringify({
          topup: {
            creditedUsdc: "25000000"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(25_000_000n, "discover recipient");
    assert.equal(result.status, "ok");
    assert.equal(result.amountUsdc, 25_000_000n);
    assert.equal(requests.some((request) => request.url.endsWith("/v1/auth/me")), true);
    assert.equal(requests.some((request) => request.url.includes(`/pay/25/${discoveredRecipient}`)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider falls back to canonical /pay topup route when legacy path returns 404", async () => {
  const config = makeConfig({ conwayCreditsTopupPath: "/v1/credits/topup" });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });

    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }, { amount: 100 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/v1/credits/topup")) {
      return new Response("404 Not Found", { status: 404 });
    }

    const expectedTopupUrl = `https://api.conway.test/pay/25/${config.conwayPayerAddress}`;
    if (url === expectedTopupUrl && headers.get(config.conwayX402HeaderName) == null) {
      return new Response(
        JSON.stringify({
          paymentHeaderName: config.conwayX402HeaderName,
          requirementId: "req-legacy-fallback",
          transferWithAuthorization: {
            to: config.conwayPaymentRecipientAddress,
            value: "25000000",
            validAfter: "0",
            validBefore: "4102444800",
            nonce: `0x${"22".repeat(32)}`,
            token: config.usdcAddress,
            chainId: config.chainId
          }
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url === expectedTopupUrl && headers.get(config.conwayX402HeaderName) != null) {
      return new Response(
        JSON.stringify({
          topup: {
            creditedUsdc: "25000000"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(25_000_000n, "legacy fallback");
    assert.equal(result.status, "ok");
    assert.equal(result.amountUsdc, 25_000_000n);
    assert.equal(requests.some((request) => request.url.endsWith("/v1/credits/topup")), true);
    assert.equal(requests.some((request) => request.url.includes("/pay/25/")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConwayBillingProvider skips pay topup when requested amount is below minimum tier", async () => {
  const config = makeConfig({ conwayCreditsTopupPath: "/pay" });
  const provider = new ConwayBillingProvider(config);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v1/credits/pricing")) {
      return new Response(
        JSON.stringify({
          tiers: [{ amount: 5 }, { amount: 25 }]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await provider.topUpCredits(4_000_000n, "below minimum");
    assert.equal(result.status, "skipped");
    assert.equal(result.amountUsdc, 0n);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const hasConwayStagingTopupEnv = Boolean(
  process.env.CONWAY_STAGING_RUN_TOPUP === "true" &&
    process.env.CONWAY_STAGING_BASE_URL &&
    process.env.CONWAY_STAGING_PAYER_PRIVATE_KEY
);

test(
  "Conway staging topup payload compatibility (opt-in)",
  {
    skip: hasConwayStagingTopupEnv
      ? false
      : "set CONWAY_STAGING_RUN_TOPUP=true with CONWAY_STAGING_BASE_URL and CONWAY_STAGING_PAYER_PRIVATE_KEY"
  },
  async () => {
    const baseUrl = process.env.CONWAY_STAGING_BASE_URL;
    const apiKey = process.env.CONWAY_STAGING_API_KEY;
    const payerPrivateKey = process.env.CONWAY_STAGING_PAYER_PRIVATE_KEY;
    const topupPath = process.env.CONWAY_STAGING_TOPUP_PATH;
    const amountRaw = process.env.CONWAY_STAGING_TOPUP_AMOUNT_USDC ?? "1";

    if (!baseUrl || !payerPrivateKey) {
      throw new Error("missing Conway staging env vars");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(payerPrivateKey)) {
      throw new Error("CONWAY_STAGING_PAYER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    if (!/^\d+$/.test(amountRaw)) {
      throw new Error("CONWAY_STAGING_TOPUP_AMOUNT_USDC must be a non-negative integer string");
    }
    const amountUsdc = BigInt(amountRaw);

    const provider = new ConwayBillingProvider(
      makeConfig({
        conwayApiBaseUrl: baseUrl,
        conwayApiKey: apiKey,
        conwayCreditsTopupPath: topupPath ?? "/v1/credits/topup",
        conwayPayerPrivateKey: payerPrivateKey as `0x${string}`,
        conwayX402Enabled: true,
        conwayFallbackToEscrowOnError: false
      })
    );

    const result = await provider.topUpCredits(amountUsdc, "staging payload compatibility");
    assert.notEqual(result.status, "error");
    assert.equal(result.amountUsdc >= 0n, true);
  }
);
