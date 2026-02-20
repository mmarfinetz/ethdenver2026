import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordChampionScaffoldRun } from "./index";

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
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

function aggregate() {
  return {
    totalRuns: 1,
    okRuns: 1,
    errorRuns: 0,
    skippedRuns: 0,
    dryRunCount: 1,
    liveRunCount: 0,
    successRate: 1,
    errorRate: 0,
    minHealthFactorWad: 1200000000000000000n,
    hfBreachCount: 0,
    runwayDeadCount: 0,
    netDeltaUsdSum: 10n,
    consecutiveFailures: 0,
    latestTimestamp: "2026-02-20T00:00:00.000Z"
  };
}

test("recordChampionScaffoldRun marks simulation-only fallback as non-promotable", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "champion-scaffold-"));
  const statePath = join(dir, "state.json");
  const provenanceDir = join(dir, "provenance");

  await withEnv(
    {
      AUTOPILOT_CHAMPION_STATE_PATH: statePath,
      AUTOPILOT_CHAMPION_PROVENANCE_DIR: provenanceDir,
      AUTOPILOT_CHAMPION_SUBMITTER_ADDRESS: "0x0000000000000000000000000000000000000001"
    },
    async () => {
      const state = await recordChampionScaffoldRun({
        proposalId: "proposal-sim",
        replay: {
          baselinePath: "baseline",
          candidatePath: "candidate",
          candidateSource: "simulated_isolated_log",
          simulationOnly: true,
          baseline: aggregate(),
          candidate: aggregate(),
          checks: [],
          ok: true,
          generatedAt: "2026-02-20T00:00:00.000Z"
        },
        verification: undefined,
        provenance: undefined,
        commitSha: "commit",
        policyVersion: "1",
        modelId: "gpt-5"
      });

      assert.equal(state.gateStatus, "simulation-only");
      assert.equal(state.currentChampionId, null);
      assert.equal(state.lineage.length, 1);
      assert.equal(state.lineage[0]?.promoted, false);
    }
  );
});

test("recordChampionScaffoldRun promotes fully verified challengers", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "champion-scaffold-"));
  const statePath = join(dir, "state.json");
  const provenanceDir = join(dir, "provenance");

  await withEnv(
    {
      AUTOPILOT_CHAMPION_STATE_PATH: statePath,
      AUTOPILOT_CHAMPION_PROVENANCE_DIR: provenanceDir,
      AUTOPILOT_CHAMPION_SUBMITTER_ADDRESS: "0x0000000000000000000000000000000000000001"
    },
    async () => {
      const first = await recordChampionScaffoldRun({
        proposalId: "proposal-pass",
        replay: {
          baselinePath: "baseline",
          candidatePath: "candidate",
          candidateSource: "command_generated_log",
          simulationOnly: false,
          baseline: aggregate(),
          candidate: aggregate(),
          checks: [],
          ok: true,
          generatedAt: "2026-02-20T00:00:00.000Z"
        },
        verification: {
          replayOk: true,
          checks: [],
          ok: true,
          generatedAt: "2026-02-20T00:00:01.000Z"
        },
        provenance: { ok: true, reasons: [] },
        commitSha: "commit",
        policyVersion: "1",
        modelId: "gpt-5"
      });
      assert.equal(first.gateStatus, "pass");
      assert.equal(first.currentChampionId, 1);
      assert.equal(first.currentChampion?.promoted, true);

      const second = await recordChampionScaffoldRun({
        proposalId: "proposal-pass-2",
        replay: {
          baselinePath: "baseline",
          candidatePath: "candidate",
          candidateSource: "command_generated_log",
          simulationOnly: false,
          baseline: aggregate(),
          candidate: aggregate(),
          checks: [],
          ok: true,
          generatedAt: "2026-02-20T00:00:02.000Z"
        },
        verification: {
          replayOk: true,
          checks: [],
          ok: true,
          generatedAt: "2026-02-20T00:00:03.000Z"
        },
        provenance: { ok: true, reasons: [] },
        commitSha: "commit",
        policyVersion: "1",
        modelId: "gpt-5"
      });
      assert.equal(second.currentChampionId, 2);
      assert.equal(second.currentChampion?.parentChampionId, 1);
      assert.equal(second.lineage.length, 2);
    }
  );
});
