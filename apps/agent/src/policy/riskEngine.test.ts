import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AaveWstEthRiskEngine,
  UnavailableRiskEngine,
  createRiskEngineFromEnv,
  type RiskSnapshot
} from "./riskEngine";

function toWad(value: number): bigint {
  return BigInt(Math.round(value * 1e9)) * 10n ** 9n;
}

function toRay(value: number): bigint {
  return BigInt(Math.round(value * 1e9)) * 10n ** 18n;
}

function makeSnapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    healthFactorWad: toWad(1.14),
    collateralBaseUsd: 1_200_000_000_000n,
    debtBaseUsd: 1_000_000_000_000n,
    borrowRateRay: toRay(0.03),
    wstEthAprWad: toWad(0.03),
    ...overrides
  };
}

test("AaveWstEthRiskEngine returns unavailable when wstETH APR is missing", async () => {
  const engine = new AaveWstEthRiskEngine({ nSimulations: 512, seed: 7 });
  const output = await engine.computeRisk(makeSnapshot({ wstEthAprWad: null }));

  assert.equal(output.status, "unavailable");
  assert.match(output.notes, /APR/i);
});

test("AaveWstEthRiskEngine returns zero liquidation probability when debt is zero", async () => {
  const engine = new AaveWstEthRiskEngine({ nSimulations: 512, seed: 7 });
  const output = await engine.computeRisk(
    makeSnapshot({
      debtBaseUsd: 0n,
      healthFactorWad: toWad(10)
    })
  );

  assert.equal(output.status, "available");
  assert.equal(output.pLiq7d, 0);
  assert.equal(output.pLiq30d, 0);
});

test("AaveWstEthRiskEngine produces higher liquidation risk for stressed positions", async () => {
  const engine = new AaveWstEthRiskEngine({
    nSimulations: 4_000,
    horizonDays: 30,
    shortHorizonDays: 7,
    seed: 42
  });

  const safe = await engine.computeRisk(
    makeSnapshot({
      healthFactorWad: toWad(1.25),
      collateralBaseUsd: 1_315_789_473_684n,
      debtBaseUsd: 1_000_000_000_000n,
      borrowRateRay: toRay(0.025),
      wstEthAprWad: toWad(0.035)
    })
  );

  const stressed = await engine.computeRisk(
    makeSnapshot({
      healthFactorWad: toWad(1.05),
      collateralBaseUsd: 1_105_263_157_895n,
      debtBaseUsd: 1_000_000_000_000n,
      borrowRateRay: toRay(0.22),
      wstEthAprWad: toWad(0.005)
    })
  );

  assert.equal(safe.status, "available");
  assert.equal(stressed.status, "available");
  assert.ok((stressed.pLiq7d ?? 0) >= (safe.pLiq7d ?? 0));
  assert.ok((stressed.pLiq30d ?? 0) > (safe.pLiq30d ?? 0));
});

test("AaveWstEthRiskEngine is deterministic with a fixed seed", async () => {
  const options = {
    nSimulations: 1_500,
    horizonDays: 30,
    shortHorizonDays: 7,
    seed: 123
  };
  const engineA = new AaveWstEthRiskEngine(options);
  const engineB = new AaveWstEthRiskEngine(options);
  const snapshot = makeSnapshot();

  const outA = await engineA.computeRisk(snapshot);
  const outB = await engineB.computeRisk(snapshot);

  assert.equal(outA.status, "available");
  assert.equal(outB.status, "available");
  assert.equal(outA.pLiq7d, outB.pLiq7d);
  assert.equal(outA.pLiq30d, outB.pLiq30d);
});

test("createRiskEngineFromEnv supports disabling via mode", () => {
  const previous = process.env.RISK_ENGINE_MODE;
  process.env.RISK_ENGINE_MODE = "off";

  try {
    const engine = createRiskEngineFromEnv();
    assert.equal(engine instanceof UnavailableRiskEngine, true);
  } finally {
    if (previous == null) delete process.env.RISK_ENGINE_MODE;
    else process.env.RISK_ENGINE_MODE = previous;
  }
});
