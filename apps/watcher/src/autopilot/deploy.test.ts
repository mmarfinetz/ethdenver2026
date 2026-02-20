import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDeploymentController } from "./deploy";

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

function runLine(status: "ok" | "error" | "skipped"): string {
  return JSON.stringify({
    timestamp: "2026-02-20T00:00:00.000Z",
    status,
    mode: "dry-run",
    position: { healthFactor: "1200000000000000000" },
    runway: { urgency: "nominal" },
    economics: { netDeltaUsd: "10" }
  });
}

async function writeRunLog(path: string, count: number, status: "ok" | "error" | "skipped"): Promise<void> {
  const lines = Array.from({ length: count }, () => runLine(status)).join("\n");
  await writeFile(path, `${lines}\n`, "utf8");
}

test("runDeploymentController executes promote hook for shadow canary promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-deploy-"));
  const baselinePath = join(dir, "baseline.ndjson");
  const candidatePath = join(dir, "candidate.ndjson");
  const hooksLogPath = join(dir, "hooks.log");
  const reportPath = join(dir, "deploy-report.json");

  await writeRunLog(baselinePath, 5, "ok");
  await writeRunLog(candidatePath, 55, "ok");

  await withEnv(
    {
      AUTOPILOT_BASELINE_RUN_LOG_PATH: baselinePath,
      AUTOPILOT_CANDIDATE_RUN_LOG_PATH: candidatePath,
      AUTOPILOT_DEPLOY_STAGE: "shadow_canary",
      AUTOPILOT_DEPLOY_PROMOTE_TO_LIVE_COMMAND: `echo promote-live >> ${JSON.stringify(hooksLogPath)}`,
      AUTOPILOT_DEPLOY_ROLLBACK_COMMAND: `echo rollback >> ${JSON.stringify(hooksLogPath)}`,
      AUTOPILOT_DEPLOY_REPORT_PATH: reportPath
    },
    async () => {
      const decision = await runDeploymentController();
      assert.equal(decision.action, "promote");
      assert.equal(decision.stage, "live_canary");
      assert.equal(decision.executions.length, 1);
      assert.equal(decision.executions[0]?.name, "promote");
      assert.equal(decision.executions[0]?.ok, true);

      const hooksLog = await readFile(hooksLogPath, "utf8");
      assert.equal(hooksLog.includes("promote-live"), true);
    }
  );
});

test("runDeploymentController auto-rolls back when promote hook fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-deploy-"));
  const baselinePath = join(dir, "baseline.ndjson");
  const candidatePath = join(dir, "candidate.ndjson");
  const hooksLogPath = join(dir, "hooks.log");

  await writeRunLog(baselinePath, 5, "ok");
  await writeRunLog(candidatePath, 55, "ok");

  await withEnv(
    {
      AUTOPILOT_BASELINE_RUN_LOG_PATH: baselinePath,
      AUTOPILOT_CANDIDATE_RUN_LOG_PATH: candidatePath,
      AUTOPILOT_DEPLOY_STAGE: "shadow_canary",
      AUTOPILOT_DEPLOY_PROMOTE_TO_LIVE_COMMAND: "false",
      AUTOPILOT_DEPLOY_ROLLBACK_COMMAND: `echo rollback >> ${JSON.stringify(hooksLogPath)}`
    },
    async () => {
      const decision = await runDeploymentController();
      assert.equal(decision.action, "rollback");
      assert.equal(decision.stage, "rolled_back");
      assert.equal(decision.executions.length, 2);
      assert.equal(decision.executions[0]?.name, "promote");
      assert.equal(decision.executions[0]?.ok, false);
      assert.equal(decision.executions[1]?.name, "rollback");
      assert.equal(decision.executions[1]?.ok, true);

      const hooksLog = await readFile(hooksLogPath, "utf8");
      assert.equal(hooksLog.includes("rollback"), true);
    }
  );
});
