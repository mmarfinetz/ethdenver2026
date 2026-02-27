import { strict as assert } from "node:assert";
import test from "node:test";
import type { Address, PublicClient } from "viem";
import { loadWatcherConfig, readFundingBalanceUsdc, type WatcherConfig } from "./watcher";

const ESCROW_ADDRESS = "0x0000000000000000000000000000000000000011" as Address;
const USDC_ADDRESS = "0x0000000000000000000000000000000000000022" as Address;
const PAYER_ADDRESS = "0x0000000000000000000000000000000000000033" as Address;

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function conwayConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    chainId: 8453,
    allowTestnet: false,
    computeBillingMode: "conway",
    rpcUrl: "https://rpc.example",
    usdcAddress: USDC_ADDRESS,
    usdcDecimals: 6,
    escrowAddress: ESCROW_ADDRESS,
    watchIntervalSeconds: 300,
    failureThreshold: 3,
    lowBalanceGraceChecks: 0,
    lowCreditsGraceChecks: 0,
    lowPayerGraceChecks: 0,
    minEscrowBalanceUsdc: 0n,
    minConwayCreditsBalanceUsdc: 0n,
    minConwayPayerBalanceUsdc: 1n,
    conwayApiBaseUrl: "https://conway.example",
    conwayApiKey: undefined,
    conwayCreditsBalancePath: "/v1/credits/balance",
    conwayPayerAddress: PAYER_ADDRESS,
    conwayFallbackToEscrowOnError: true,
    shutdownCommand: "systemctl stop ssa-agent",
    ...overrides
  };
}

function alchemyConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    ...conwayConfig(),
    computeBillingMode: "alchemy",
    ...overrides
  };
}

test("loadWatcherConfig requires CONWAY_API_BASE_URL when Conway billing mode is enabled", async () => {
  await withEnv(
    {
      CHAIN_ID: "8453",
      BASE_RPC_URL: "https://rpc.example",
      ESCROW_ADDRESS: ESCROW_ADDRESS,
      USDC_ADDRESS: USDC_ADDRESS,
      COMPUTE_BILLING_MODE: "conway",
      CONWAY_API_BASE_URL: undefined
    },
    () => {
      assert.throws(loadWatcherConfig, /CONWAY_API_BASE_URL is required when COMPUTE_BILLING_MODE=conway/);
    }
  );
});

test("loadWatcherConfig requires ALCHEMY_API_BASE_URL when Alchemy billing mode is enabled", async () => {
  await withEnv(
    {
      CHAIN_ID: "8453",
      BASE_RPC_URL: "https://rpc.example",
      ESCROW_ADDRESS: ESCROW_ADDRESS,
      USDC_ADDRESS: USDC_ADDRESS,
      COMPUTE_BILLING_MODE: "alchemy",
      ALCHEMY_API_BASE_URL: undefined,
      CONWAY_API_BASE_URL: undefined
    },
    () => {
      assert.throws(loadWatcherConfig, /ALCHEMY_API_BASE_URL is required when COMPUTE_BILLING_MODE=alchemy/);
    }
  );
});

test("loadWatcherConfig parses Conway env defaults and fallback toggle", async () => {
  await withEnv(
    {
      CHAIN_ID: "8453",
      BASE_RPC_URL: "https://rpc.example",
      ESCROW_ADDRESS: ESCROW_ADDRESS,
      USDC_ADDRESS: USDC_ADDRESS,
      COMPUTE_BILLING_MODE: "conway",
      CONWAY_API_BASE_URL: " https://conway.example/api/ ",
      CONWAY_API_KEY: " secret-token ",
      CONWAY_CREDITS_BALANCE_PATH: undefined,
      CONWAY_PAYER_ADDRESS: PAYER_ADDRESS,
      CONWAY_FALLBACK_TO_ESCROW_ON_ERROR: "false"
    },
    () => {
      const config = loadWatcherConfig();
      assert.equal(config.computeBillingMode, "conway");
      assert.equal(config.conwayApiBaseUrl, "https://conway.example/api/");
      assert.equal(config.conwayApiKey, "secret-token");
      assert.equal(config.conwayCreditsBalancePath, "/v1/credits/balance");
      assert.equal(config.conwayPayerAddress, PAYER_ADDRESS);
      assert.equal(config.conwayFallbackToEscrowOnError, false);
    }
  );
});

test("loadWatcherConfig parses Alchemy env defaults and fallback toggle", async () => {
  await withEnv(
    {
      CHAIN_ID: "8453",
      BASE_RPC_URL: "https://rpc.example",
      ESCROW_ADDRESS: ESCROW_ADDRESS,
      USDC_ADDRESS: USDC_ADDRESS,
      COMPUTE_BILLING_MODE: "alchemy",
      ALCHEMY_API_BASE_URL: " https://alchemy.example/api/ ",
      ALCHEMY_API_KEY: " alchemy-token ",
      ALCHEMY_CREDITS_BALANCE_PATH: undefined,
      ALCHEMY_PAYER_ADDRESS: PAYER_ADDRESS,
      ALCHEMY_FALLBACK_TO_ESCROW_ON_ERROR: "false",
      CONWAY_API_BASE_URL: undefined,
      CONWAY_API_KEY: undefined,
      CONWAY_CREDITS_BALANCE_PATH: undefined,
      CONWAY_PAYER_ADDRESS: undefined,
      CONWAY_FALLBACK_TO_ESCROW_ON_ERROR: undefined
    },
    () => {
      const config = loadWatcherConfig();
      assert.equal(config.computeBillingMode, "alchemy");
      assert.equal(config.conwayApiBaseUrl, "https://alchemy.example/api/");
      assert.equal(config.conwayApiKey, "alchemy-token");
      assert.equal(config.conwayCreditsBalancePath, "/v1/credits/balance");
      assert.equal(config.conwayPayerAddress, PAYER_ADDRESS);
      assert.equal(config.conwayFallbackToEscrowOnError, false);
    }
  );
});

test("loadWatcherConfig requires payer address when Conway payer floor is set", async () => {
  await withEnv(
    {
      CHAIN_ID: "8453",
      BASE_RPC_URL: "https://rpc.example",
      ESCROW_ADDRESS: ESCROW_ADDRESS,
      USDC_ADDRESS: USDC_ADDRESS,
      COMPUTE_BILLING_MODE: "conway",
      CONWAY_API_BASE_URL: "https://conway.example",
      CONWAY_MIN_PAYER_BALANCE_USDC: "1",
      CONWAY_PAYER_ADDRESS: undefined
    },
    () => {
      assert.throws(loadWatcherConfig, /CONWAY_PAYER_ADDRESS is required/);
    }
  );
});

test("readFundingBalanceUsdc uses Conway balance when available", async () => {
  const readArgs: Address[] = [];
  const client = {
    readContract: async (input: { args?: Address[] }) => {
      const address = input.args?.[0];
      if (!address) throw new Error("missing balanceOf args");
      readArgs.push(address);
      if (address === PAYER_ADDRESS) return 7_654_321n;
      throw new Error("escrow read should not be used when Conway succeeds");
    }
  } as unknown as PublicClient;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ credits_cents: "12345" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  try {
    const result = await readFundingBalanceUsdc(client, conwayConfig());
    assert.equal(result.creditsBalanceUsdc, 123_450_000n);
    assert.equal(result.creditsSource, "conway");
    assert.equal(result.payerBalanceUsdc, 7_654_321n);
    assert.equal(result.fallbackToEscrow, false);
    assert.deepEqual(readArgs, [PAYER_ADDRESS]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readFundingBalanceUsdc uses Alchemy balance when available", async () => {
  const readArgs: Address[] = [];
  const client = {
    readContract: async (input: { args?: Address[] }) => {
      const address = input.args?.[0];
      if (!address) throw new Error("missing balanceOf args");
      readArgs.push(address);
      if (address === PAYER_ADDRESS) return 7_654_321n;
      throw new Error("escrow read should not be used when Alchemy succeeds");
    }
  } as unknown as PublicClient;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ credits_cents: "12345" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  try {
    const result = await readFundingBalanceUsdc(client, alchemyConfig());
    assert.equal(result.creditsBalanceUsdc, 123_450_000n);
    assert.equal(result.creditsSource, "alchemy");
    assert.equal(result.payerBalanceUsdc, 7_654_321n);
    assert.equal(result.fallbackToEscrow, false);
    assert.deepEqual(readArgs, [PAYER_ADDRESS]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readFundingBalanceUsdc falls back to escrow when Conway read fails and fallback is enabled", async () => {
  let escrowReads = 0;
  let payerReads = 0;
  const client = {
    readContract: async (input: { args?: Address[] }) => {
      const address = input.args?.[0];
      if (address === PAYER_ADDRESS) {
        payerReads += 1;
        return 77n;
      }
      if (address === ESCROW_ADDRESS) {
        escrowReads += 1;
        return 42n;
      }
      throw new Error("unexpected address");
    }
  } as unknown as PublicClient;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

  try {
    const result = await readFundingBalanceUsdc(client, conwayConfig({ conwayFallbackToEscrowOnError: true }));
    assert.equal(result.creditsBalanceUsdc, 42n);
    assert.equal(result.creditsSource, "escrow");
    assert.equal(result.payerBalanceUsdc, 77n);
    assert.equal(result.fallbackToEscrow, true);
    assert.equal(escrowReads, 1);
    assert.equal(payerReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readFundingBalanceUsdc does not fallback when Conway fallback is disabled", async () => {
  let escrowReads = 0;
  let payerReads = 0;
  const client = {
    readContract: async (input: { args?: Address[] }) => {
      const address = input.args?.[0];
      if (address === PAYER_ADDRESS) {
        payerReads += 1;
        return 77n;
      }
      if (address === ESCROW_ADDRESS) {
        escrowReads += 1;
        return 42n;
      }
      throw new Error("unexpected address");
    }
  } as unknown as PublicClient;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

  try {
    await assert.rejects(
      readFundingBalanceUsdc(client, conwayConfig({ conwayFallbackToEscrowOnError: false })),
      /Conway balance API error 503/
    );
    assert.equal(escrowReads, 0);
    assert.equal(payerReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
