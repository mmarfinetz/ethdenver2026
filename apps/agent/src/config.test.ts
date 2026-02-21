import assert from "node:assert/strict";
import { test } from "node:test";
import { CIRCLE_PAYMASTER_ADDRESS } from "./aa/paymaster";
import { loadConfig } from "./config";

const BASE_ENV: Record<string, string> = {
  BASE_RPC_URL: "https://mainnet.base.org",
  BUNDLER_RPC_URL: "https://public.pimlico.io/v2/8453/rpc",
  BUILDER_CODE: "bc_test_builder_code",
  OWNER_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000"
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

    assert.equal(config.useCirclePaymaster, false);
    assert.equal(config.circlePaymasterAddress, CIRCLE_PAYMASTER_ADDRESS);
    assert.equal(config.computeBufferBps, 2_000);
    assert.equal(config.runwayNominalDays, 14);
    assert.equal(config.runwayElevatedDays, 7);
    assert.equal(config.runwayDeadDays, 2);
    assert.equal(config.maxHarvestEquityBps, 500);
  });
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
