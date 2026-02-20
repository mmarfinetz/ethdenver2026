import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptiveIntervalMultiplier,
  computeRunway,
  effectiveMaxLoops,
  escrowDeficitUsdc
} from "./runway";

test("computeRunway maps urgency levels from escrow balance scenarios", () => {
  const base = {
    perTickCostUsdc: 1_000n,
    baseIntervalSeconds: 60,
    nominalDays: 14,
    elevatedDays: 7,
    deadDays: 2
  };

  const nominal = computeRunway({ ...base, escrowBalanceUsdc: 30_000_000n });
  const elevated = computeRunway({ ...base, escrowBalanceUsdc: 12_000_000n });
  const critical = computeRunway({ ...base, escrowBalanceUsdc: 8_000_000n });
  const dead = computeRunway({ ...base, escrowBalanceUsdc: 1_000_000n });

  assert.equal(nominal.urgency, "nominal");
  assert.equal(elevated.urgency, "elevated");
  assert.equal(critical.urgency, "critical");
  assert.equal(dead.urgency, "dead");
});

test("escrowDeficitUsdc computes top-up needed for target runway", () => {
  const runway = computeRunway({
    escrowBalanceUsdc: 10_000_000n,
    perTickCostUsdc: 1_000n,
    baseIntervalSeconds: 60,
    nominalDays: 14,
    elevatedDays: 7,
    deadDays: 2
  });

  const deficit = escrowDeficitUsdc(runway, 14);
  assert.equal(deficit, 10_160_000n);
});

test("effectiveMaxLoops throttles growth by urgency", () => {
  assert.equal(effectiveMaxLoops(5, "nominal"), 5);
  assert.equal(effectiveMaxLoops(5, "elevated"), 2);
  assert.equal(effectiveMaxLoops(5, "critical"), 0);
  assert.equal(effectiveMaxLoops(5, "dead"), 0);
});

test("adaptiveIntervalMultiplier slows cadence as urgency worsens", () => {
  assert.equal(adaptiveIntervalMultiplier("nominal"), 1);
  assert.equal(adaptiveIntervalMultiplier("elevated"), 2);
  assert.equal(adaptiveIntervalMultiplier("critical"), 4);
  assert.equal(adaptiveIntervalMultiplier("dead"), 8);
});
