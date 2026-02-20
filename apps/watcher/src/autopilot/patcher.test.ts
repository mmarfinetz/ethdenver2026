import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyProposalsToEnv, createProposalArtifact } from "./patcher";
import type { RunAggregate } from "./types";

test("applyProposalsToEnv updates only matching keys", () => {
  const input = [
    "HF_BUFFER=0.10",
    "RUN_INTERVAL_SECONDS=60",
    "ESCROW_ADDRESS=0x0000000000000000000000000000000000000000"
  ].join("\n");

  const output = applyProposalsToEnv(input, [
    {
      key: "HF_BUFFER",
      current: "0.10",
      proposed: "0.12",
      reason: "safety increase"
    },
    {
      key: "RUN_INTERVAL_SECONDS",
      current: "60",
      proposed: "45",
      reason: "faster cadence"
    }
  ]);

  assert.equal(output.includes("HF_BUFFER=0.12"), true);
  assert.equal(output.includes("RUN_INTERVAL_SECONDS=45"), true);
  assert.equal(output.includes("ESCROW_ADDRESS=0x0000000000000000000000000000000000000000"), true);
});

test("createProposalArtifact reuses deterministic proposal id for identical inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-patcher-"));
  const sourceEnvPath = join(dir, "agent.env.example");
  await writeFile(sourceEnvPath, "HF_BUFFER=0.10\nRUN_INTERVAL_SECONDS=60\n", "utf8");

  const metrics: RunAggregate = {
    totalRuns: 10,
    okRuns: 8,
    errorRuns: 1,
    skippedRuns: 1,
    dryRunCount: 10,
    liveRunCount: 0,
    successRate: 0.8,
    errorRate: 0.1,
    minHealthFactorWad: 1500000000000000000n,
    hfBreachCount: 0,
    runwayDeadCount: 0,
    netDeltaUsdSum: 100n,
    consecutiveFailures: 1,
    latestTimestamp: "2026-02-20T00:00:00.000Z"
  };
  const proposals = [
    {
      key: "HF_BUFFER",
      current: "0.10",
      proposed: "0.12",
      reason: "safety increase"
    }
  ];

  const first = await createProposalArtifact({
    phase: 1,
    metrics,
    proposals,
    summary: "test summary",
    proposalDir: dir,
    sourceEnvPath
  });
  const second = await createProposalArtifact({
    phase: 1,
    metrics,
    proposals,
    summary: "test summary",
    proposalDir: dir,
    sourceEnvPath
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.proposalId, second.proposalId);

  const stored = JSON.parse(await readFile(join(dir, `${first.proposalId}.json`), "utf8")) as {
    proposalId: string;
  };
  assert.equal(stored.proposalId, first.proposalId);
});
