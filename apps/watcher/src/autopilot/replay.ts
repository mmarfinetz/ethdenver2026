import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { collectRunMetrics } from "./collector";
import { ensureParent, nowIso, repoPath, toShellTuple, writeJson } from "./common";
import { hasCapability, loadPolicy } from "./policy";
import type { ReplayReport } from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_RUN_LOG_PATH = repoPath("apps/agent/data/runs.ndjson");
const DEFAULT_ENV_EXAMPLE_PATH = repoPath("apps/agent/.env.example");
const DEFAULT_CANDIDATE_REPLAY_PATH = repoPath("autonomy/reports/replay-candidate.ndjson");

function check(name: string, ok: boolean, detail: string): ReplayReport["checks"][number] {
  return { name, ok, detail };
}

function envOrDefault(path: string | undefined, fallback: string): string {
  const value = path?.trim();
  return value || fallback;
}

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function asInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function asDecimal(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function generateIsolatedCandidateRunLog(options: {
  baselineRunLogPath: string;
  outputPath: string;
  baselineEnvPath: string;
  candidateEnvPath: string;
}): Promise<{ outputPath: string; generatedLineCount: number }> {
  const [baselineRunLogRaw, baselineEnvRaw, candidateEnvRaw] = await Promise.all([
    readFile(options.baselineRunLogPath, "utf8").catch(() => ""),
    readFile(options.baselineEnvPath, "utf8").catch(() => ""),
    readFile(options.candidateEnvPath, "utf8").catch(() => "")
  ]);

  const baselineEnv = parseEnv(baselineEnvRaw);
  const candidateEnv = parseEnv(candidateEnvRaw);
  const baselineInterval = asInt(baselineEnv.RUN_INTERVAL_SECONDS, 60);
  const candidateInterval = asInt(candidateEnv.RUN_INTERVAL_SECONDS, baselineInterval);
  const baselineHfBuffer = asDecimal(baselineEnv.HF_BUFFER, 0);
  const candidateHfBuffer = asDecimal(candidateEnv.HF_BUFFER, baselineHfBuffer);
  const baselineComputeBuffer = asInt(baselineEnv.COMPUTE_BUFFER_BPS, 0);
  const candidateComputeBuffer = asInt(candidateEnv.COMPUTE_BUFFER_BPS, baselineComputeBuffer);

  const baselineEnvDigest = hashText(baselineEnvRaw || "missing");
  const candidateEnvDigest = hashText(candidateEnvRaw || "missing");
  const lines = baselineRunLogRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const generatedAt = nowIso();
  const candidateLines = lines.map((line, index) => {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      payload.replay = {
        baselineEnvDigest,
        candidateEnvDigest,
        baselineIntervalSeconds: baselineInterval,
        candidateIntervalSeconds: candidateInterval,
        baselineHfBuffer,
        candidateHfBuffer,
        baselineComputeBufferBps: baselineComputeBuffer,
        candidateComputeBufferBps: candidateComputeBuffer,
        recordIndex: index,
        generatedAt
      };
      return JSON.stringify(payload);
    } catch {
      return line;
    }
  });

  await ensureParent(options.outputPath);
  await writeFile(options.outputPath, `${candidateLines.join("\n")}\n`, "utf8");
  return {
    outputPath: options.outputPath,
    generatedLineCount: candidateLines.length
  };
}

async function runReplayCommand(command: string, envOverrides: Record<string, string>): Promise<void> {
  const [shell, args] = toShellTuple(command);
  const nodeBinDir = dirname(process.execPath);
  await execFileAsync(shell, args, {
    cwd: repoPath("."),
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      ...envOverrides,
      PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`
    }
  });
}

async function resolveBaselinePath(): Promise<string> {
  return envOrDefault(
    process.env.AUTOPILOT_BASELINE_RUN_LOG_PATH?.trim() || process.env.RUN_LOG_PATH?.trim(),
    DEFAULT_RUN_LOG_PATH
  );
}

async function resolveCandidateSource(
  baselinePath: string,
  options: {
    requireBehavioralCandidate: boolean;
  }
): Promise<{
  candidatePath: string;
  candidateSource: ReplayReport["candidateSource"];
  simulationOnly: boolean;
}> {
  const explicitCandidatePath = process.env.AUTOPILOT_CANDIDATE_RUN_LOG_PATH?.trim();
  const replayCommand = process.env.AUTOPILOT_REPLAY_CANDIDATE_COMMAND?.trim();

  if (replayCommand) {
    const outputPath = envOrDefault(
      process.env.AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH?.trim(),
      DEFAULT_CANDIDATE_REPLAY_PATH
    );
    await runReplayCommand(replayCommand, {
      AUTOPILOT_REPLAY_INPUT_PATH: baselinePath,
      AUTOPILOT_REPLAY_OUTPUT_PATH: outputPath,
      AUTOPILOT_REPLAY_BASELINE_ENV_PATH: envOrDefault(
        process.env.AUTOPILOT_BASELINE_ENV_PATH?.trim(),
        DEFAULT_ENV_EXAMPLE_PATH
      ),
      AUTOPILOT_REPLAY_CANDIDATE_ENV_PATH: envOrDefault(
        process.env.AUTOPILOT_CANDIDATE_ENV_PATH?.trim(),
        DEFAULT_ENV_EXAMPLE_PATH
      )
    });
    return {
      candidatePath: outputPath,
      candidateSource: "command_generated_log",
      simulationOnly: false
    };
  }

  if (options.requireBehavioralCandidate) {
    throw new Error(
      "Promotion-capable replay requires AUTOPILOT_REPLAY_CANDIDATE_COMMAND so the challenger path is behaviorally exercised"
    );
  }

  if (explicitCandidatePath && explicitCandidatePath !== baselinePath) {
    return {
      candidatePath: explicitCandidatePath,
      candidateSource: "provided_run_log",
      simulationOnly: false
    };
  }

  const generated = await generateIsolatedCandidateRunLog({
    baselineRunLogPath: baselinePath,
    outputPath: envOrDefault(
      process.env.AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH?.trim(),
      DEFAULT_CANDIDATE_REPLAY_PATH
    ),
    baselineEnvPath: envOrDefault(
      process.env.AUTOPILOT_BASELINE_ENV_PATH?.trim(),
      DEFAULT_ENV_EXAMPLE_PATH
    ),
    candidateEnvPath: envOrDefault(
      process.env.AUTOPILOT_CANDIDATE_ENV_PATH?.trim(),
      DEFAULT_ENV_EXAMPLE_PATH
    )
  });
  return {
    candidatePath: generated.outputPath,
    candidateSource: "simulated_isolated_log",
    simulationOnly: true
  };
}

export async function runReplay(): Promise<ReplayReport> {
  const policy = await loadPolicy();
  const baselinePath = await resolveBaselinePath();
  const requireBehavioralCandidate =
    hasCapability(policy, "deploy_canary") || hasCapability(policy, "promote_production");
  const { candidatePath, candidateSource, simulationOnly } = await resolveCandidateSource(baselinePath, {
    requireBehavioralCandidate
  });
  if (candidatePath === baselinePath) {
    throw new Error(
      `Replay candidate path must differ from baseline path. baseline=${baselinePath} candidate=${candidatePath}`
    );
  }

  const hfFloorWad = BigInt(policy.deployment.hf_floor_wad);
  const [baseline, candidate] = await Promise.all([
    collectRunMetrics({ runLogPath: baselinePath, hfFloorWad }),
    collectRunMetrics({ runLogPath: candidatePath, hfFloorWad })
  ]);

  const requirements = policy.verification.replay_requirements;
  const checks: ReplayReport["checks"] = [];

  if (requirements.candidate_must_not_increase_hf_breach_count) {
    checks.push(
      check(
        "hf-breach-count",
        candidate.hfBreachCount <= baseline.hfBreachCount,
        `candidate=${candidate.hfBreachCount} baseline=${baseline.hfBreachCount}`
      )
    );
  }
  if (requirements.candidate_must_not_increase_failure_count) {
    checks.push(
      check(
        "failure-count",
        candidate.errorRuns <= baseline.errorRuns,
        `candidate=${candidate.errorRuns} baseline=${baseline.errorRuns}`
      )
    );
  }
  if (requirements.candidate_must_not_increase_runway_collapse_count) {
    checks.push(
      check(
        "runway-collapse-count",
        candidate.runwayDeadCount <= baseline.runwayDeadCount,
        `candidate=${candidate.runwayDeadCount} baseline=${baseline.runwayDeadCount}`
      )
    );
  }
  if (requirements.candidate_must_preserve_or_improve_success_rate) {
    checks.push(
      check(
        "success-rate",
        candidate.successRate >= baseline.successRate,
        `candidate=${candidate.successRate.toFixed(4)} baseline=${baseline.successRate.toFixed(4)}`
      )
    );
  }
  if (requirements.candidate_must_preserve_or_improve_net_delta) {
    checks.push(
      check(
        "net-delta",
        candidate.netDeltaUsdSum >= baseline.netDeltaUsdSum,
        `candidate=${candidate.netDeltaUsdSum.toString()} baseline=${baseline.netDeltaUsdSum.toString()}`
      )
    );
  }

  const report: ReplayReport = {
    baselinePath,
    candidatePath,
    candidateSource,
    simulationOnly,
    baseline,
    candidate,
    checks,
    ok: checks.every((item) => item.ok),
    generatedAt: nowIso()
  };

  const reportPath =
    process.env.AUTOPILOT_REPLAY_REPORT_PATH?.trim() || repoPath("autonomy/reports/replay.json");
  await writeJson(reportPath, report);
  return report;
}

async function main(): Promise<void> {
  const report = await runReplay();
  console.log(
    `[autopilot:replay] ok=${report.ok} baseline=${report.baselinePath} candidate=${report.candidatePath}`
  );
  for (const item of report.checks) {
    console.log(`- ${item.ok ? "ok" : "fail"} ${item.name}: ${item.detail}`);
  }
  if (!report.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
