import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReplay } from "./replay";

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

function runEntry() {
  return {
    timestamp: "2026-02-20T00:00:00.000Z",
    status: "ok",
    mode: "dry-run",
    position: { healthFactor: "1200000000000000000" },
    runway: { urgency: "nominal" },
    economics: { netDeltaUsd: "10" }
  };
}

test("runReplay uses simulation-only isolated candidate log for non-promotable phases", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-replay-"));
  const baselinePath = join(dir, "baseline.ndjson");
  const candidatePath = join(dir, "candidate.ndjson");
  const baselineEnvPath = join(dir, "baseline.env");
  const candidateEnvPath = join(dir, "candidate.env");
  const replayReportPath = join(dir, "replay.json");

  await writeFile(baselinePath, `${JSON.stringify(runEntry())}\n`, "utf8");
  await writeFile(baselineEnvPath, "RUN_INTERVAL_SECONDS=60\nHF_BUFFER=0.10\n", "utf8");
  await writeFile(candidateEnvPath, "RUN_INTERVAL_SECONDS=45\nHF_BUFFER=0.12\n", "utf8");

  await withEnv(
    {
      AUTOPILOT_PHASE: "1",
      AUTOPILOT_BASELINE_RUN_LOG_PATH: baselinePath,
      AUTOPILOT_CANDIDATE_RUN_LOG_PATH: undefined,
      AUTOPILOT_REPLAY_CANDIDATE_COMMAND: undefined,
      AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH: candidatePath,
      AUTOPILOT_BASELINE_ENV_PATH: baselineEnvPath,
      AUTOPILOT_CANDIDATE_ENV_PATH: candidateEnvPath,
      AUTOPILOT_REPLAY_REPORT_PATH: replayReportPath
    },
    async () => {
      const report = await runReplay();
      assert.equal(report.baselinePath, baselinePath);
      assert.equal(report.candidatePath, candidatePath);
      assert.equal(report.candidateSource, "simulated_isolated_log");
      assert.equal(report.simulationOnly, true);
      assert.notEqual(report.baselinePath, report.candidatePath);

      const generatedCandidate = await readFile(candidatePath, "utf8");
      assert.equal(generatedCandidate.includes("\"replay\""), true);
    }
  );
});

test("runReplay requires challenger command for promotion-capable phases", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-replay-"));
  const baselinePath = join(dir, "baseline.ndjson");
  await writeFile(baselinePath, `${JSON.stringify(runEntry())}\n`, "utf8");

  await withEnv(
    {
      AUTOPILOT_PHASE: "3",
      AUTOPILOT_BASELINE_RUN_LOG_PATH: baselinePath,
      AUTOPILOT_CANDIDATE_RUN_LOG_PATH: undefined,
      AUTOPILOT_REPLAY_CANDIDATE_COMMAND: undefined,
      AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH: join(dir, "candidate.ndjson")
    },
    async () => {
      await assert.rejects(
        runReplay(),
        /AUTOPILOT_REPLAY_CANDIDATE_COMMAND/
      );
    }
  );
});

test("runReplay accepts command-generated challenger log for promotion-capable phases", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-replay-"));
  const baselinePath = join(dir, "baseline.ndjson");
  const candidatePath = join(dir, "candidate.ndjson");

  await writeFile(baselinePath, `${JSON.stringify(runEntry())}\n`, "utf8");

  await withEnv(
    {
      AUTOPILOT_PHASE: "3",
      AUTOPILOT_BASELINE_RUN_LOG_PATH: baselinePath,
      AUTOPILOT_CANDIDATE_RUN_LOG_PATH: undefined,
      AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH: candidatePath,
      AUTOPILOT_REPLAY_CANDIDATE_COMMAND: "cp \"$AUTOPILOT_REPLAY_INPUT_PATH\" \"$AUTOPILOT_REPLAY_OUTPUT_PATH\""
    },
    async () => {
      const report = await runReplay();
      assert.equal(report.candidateSource, "command_generated_log");
      assert.equal(report.simulationOnly, false);
      assert.equal(report.candidatePath, candidatePath);
      const generated = await readFile(candidatePath, "utf8");
      assert.equal(generated.length > 0, true);
    }
  );
});
