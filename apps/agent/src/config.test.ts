import assert from "node:assert/strict";
import { test } from "node:test";
import { CIRCLE_PAYMASTER_ADDRESS } from "./aa/paymaster";
import { loadConfig } from "./config";
import { privateKeyToAccount } from "viem/accounts";

const BASE_ENV: Record<string, string> = {
  BASE_RPC_URL: "https://mainnet.base.org",
  BUNDLER_RPC_URL: "https://public.pimlico.io/v2/8453/rpc",
  BUILDER_CODE: "bc_test_builder_code",
  OWNER_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  USDC_DECIMALS: "6",
  DRY_RUN: "true",
  ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000",
  COMPUTE_BILLING_MODE: "escrow",
  CONWAY_API_BASE_URL: "",
  CONWAY_API_KEY: "",
  CONWAY_CREDITS_BALANCE_PATH: "",
  CONWAY_CREDITS_TOPUP_PATH: "",
  CONWAY_PAYMENT_RECIPIENT_ADDRESS: "",
  CONWAY_PAYER_ADDRESS: "",
  CONWAY_PAYER_PRIVATE_KEY: "",
  CONWAY_X402_ENABLED: "true",
  CONWAY_X402_HEADER_NAME: "x-payment",
  CONWAY_FALLBACK_TO_ESCROW_ON_ERROR: "true",
  CONWAY_CREDITS_MIN_BALANCE_USDC: "10",
  CONWAY_CREDITS_TARGET_BALANCE_USDC: "50",
  CONWAY_CREDITS_MAX_TOPUP_USDC_PER_TICK: "25",
  CONWAY_CREDITS_TOPUP_COOLDOWN_SECONDS: "900",
  CONWAY_PAYER_MIN_BALANCE_USDC: "5",
  CONWAY_PAYER_TARGET_BALANCE_USDC: "25",
  CONWAY_PAYER_MAX_FUND_USDC_PER_TICK: "25",
  CONWAY_PAYER_MAX_FUND_USDC_PER_DAY: "100",
  CONWAY_PAYER_FUND_COOLDOWN_SECONDS: "900",
  CONWAY_RECONCILIATION_BOOTSTRAP_USDC: "0",
  CONWAY_RECONCILIATION_WINDOW_HOURS: "24",
  ALCHEMY_API_BASE_URL: "",
  ALCHEMY_API_KEY: "",
  ALCHEMY_CREDITS_BALANCE_PATH: "",
  ALCHEMY_CREDITS_TOPUP_PATH: "",
  ALCHEMY_PAYMENT_RECIPIENT_ADDRESS: "",
  ALCHEMY_PAYER_ADDRESS: "",
  ALCHEMY_PAYER_PRIVATE_KEY: "",
  ALCHEMY_X402_ENABLED: "",
  ALCHEMY_X402_HEADER_NAME: "",
  ALCHEMY_FALLBACK_TO_ESCROW_ON_ERROR: ""
};

function withEnv(overrides: Record<string, string>, run: () => void): void {
  const keys = new Set<string>([...Object.keys(BASE_ENV), ...Object.keys(overrides)]);
  const previous = new Map<string, string | undefined>();

  for (const key of keys) {
    previous.set(key, process.env[key]);
  }

  Object.assign(process.env, BASE_ENV, overrides);

  try {
    run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadConfig keeps escrow mode defaults unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();

    assert.equal(config.computeBillingMode, "escrow");
    assert.equal(config.useCirclePaymaster, false);
    assert.equal(config.circlePaymasterAddress, CIRCLE_PAYMASTER_ADDRESS);
    assert.equal(config.computeBufferBps, 2_000);
    assert.equal(config.runwayNominalDays, 14);
    assert.equal(config.runwayElevatedDays, 7);
    assert.equal(config.runwayDeadDays, 2);
    assert.equal(config.maxHarvestEquityBps, 500);
  });
});

test("loadConfig rejects unknown compute billing mode", () => {
  withEnv(
    {
      COMPUTE_BILLING_MODE: "unknown"
    },
    () => {
      assert.throws(() => loadConfig(), /COMPUTE_BILLING_MODE must be escrow\|conway\|alchemy/);
    }
  );
});

test("loadConfig rejects invalid runway ordering", () => {
  withEnv(
    {
      RUNWAY_NOMINAL_DAYS: "7",
      RUNWAY_ELEVATED_DAYS: "7",
      RUNWAY_DEAD_DAYS: "2"
    },
    () => {
      assert.throws(() => loadConfig(), /nominal > elevated > dead/);
    }
  );
});

test("loadConfig requires CONWAY_API_BASE_URL in conway mode", () => {
  withEnv(
    {
      COMPUTE_BILLING_MODE: "conway"
    },
    () => {
      assert.throws(() => loadConfig(), /CONWAY_API_BASE_URL is required/);
    }
  );
});

test("loadConfig requires ALCHEMY_API_BASE_URL in alchemy mode", () => {
  withEnv(
    {
      COMPUTE_BILLING_MODE: "alchemy",
      ALCHEMY_API_BASE_URL: ""
    },
    () => {
      assert.throws(() => loadConfig(), /ALCHEMY_API_BASE_URL is required/);
    }
  );
});

test("loadConfig requires Conway payer wallet identity in conway mode", () => {
  withEnv(
    {
      COMPUTE_BILLING_MODE: "conway",
      CONWAY_API_BASE_URL: "https://api.conway.test",
      CONWAY_PAYER_PRIVATE_KEY: "",
      CONWAY_PAYER_ADDRESS: ""
    },
    () => {
      assert.throws(() => loadConfig(), /CONWAY_PAYER_ADDRESS or CONWAY_PAYER_PRIVATE_KEY is required/);
    }
  );
});

test("loadConfig accepts conway billing settings", () => {
  const payerKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  withEnv(
    {
      COMPUTE_BILLING_MODE: "conway",
      CONWAY_API_BASE_URL: "https://api.conway.test",
      CONWAY_PAYER_PRIVATE_KEY: payerKey,
      CONWAY_PAYMENT_RECIPIENT_ADDRESS: "0x0000000000000000000000000000000000000001"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.computeBillingMode, "conway");
      assert.equal(config.conwayApiBaseUrl, "https://api.conway.test");
      assert.equal(config.conwayPaymentRecipientAddress, "0x0000000000000000000000000000000000000001");
      assert.equal(config.conwayPayerPrivateKey, payerKey);
      assert.equal(config.conwayPayerAddress, privateKeyToAccount(payerKey as `0x${string}`).address);
      assert.equal(config.conwayX402Enabled, true);
      assert.equal(config.conwayPayerFundMaxUsdcPerDay, 100_000_000n);
      assert.equal(config.conwayCreditsTargetBalanceUsdc, 50_000_000n);
    }
  );
});

test("loadConfig accepts alchemy billing settings", () => {
  const payerKey = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  withEnv(
    {
      COMPUTE_BILLING_MODE: "alchemy",
      ALCHEMY_API_BASE_URL: "https://api.g.alchemy.com",
      ALCHEMY_API_KEY: "alchemy-token",
      ALCHEMY_CREDITS_BALANCE_PATH: "/v1/credits/balance",
      ALCHEMY_CREDITS_TOPUP_PATH: "/pay",
      ALCHEMY_PAYER_PRIVATE_KEY: payerKey
    },
    () => {
      const config = loadConfig();
      assert.equal(config.computeBillingMode, "alchemy");
      assert.equal(config.conwayApiBaseUrl, "https://api.g.alchemy.com");
      assert.equal(config.conwayApiKey, "alchemy-token");
      assert.equal(config.conwayCreditsBalancePath, "/v1/credits/balance");
      assert.equal(config.conwayCreditsTopupPath, "/pay");
      assert.equal(config.conwayPayerPrivateKey, payerKey);
      assert.equal(config.conwayPayerAddress, privateKeyToAccount(payerKey as `0x${string}`).address);
      assert.equal(config.conwayX402HeaderName, "payment-signature");
    }
  );
});

test("loadConfig rejects zero escrow address in live mode", () => {
  withEnv(
    {
      DRY_RUN: "false",
      ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000"
    },
    () => {
      assert.throws(() => loadConfig(), /ESCROW_ADDRESS must be a non-zero address in live mode/);
    }
  );
});

test("loadConfig rejects zero monthly server cost in live mode", () => {
  withEnv(
    {
      DRY_RUN: "false",
      ESCROW_ADDRESS: "0x0000000000000000000000000000000000000001",
      MONTHLY_SERVER_COST_USDC: "0"
    },
    () => {
      assert.throws(() => loadConfig(), /MONTHLY_SERVER_COST_USDC must be > 0 in live mode/);
    }
  );
});
