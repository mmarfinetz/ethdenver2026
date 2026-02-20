import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { collectRunMetrics } from "./collector";
import { nowIso, repoPath, toShellTuple, writeJson } from "./common";
import { loadPolicy } from "./policy";
import type {
  DeploymentDecision,
  DeploymentExecution,
  DeploymentStage,
  RunAggregate
} from "./types";

const execFileAsync = promisify(execFile);

function parseStage(raw: string | undefined): DeploymentStage {
  const normalized = raw?.trim();
  if (normalized === "shadow_canary") return normalized;
  if (normalized === "live_canary") return normalized;
  if (normalized === "promoted") return normalized;
  if (normalized === "rolled_back") return normalized;
  return "shadow_canary";
}

function errorRegressionPct(candidate: RunAggregate, baseline: RunAggregate): number {
  if (baseline.errorRate === 0) {
    return candidate.errorRate > 0 ? 100 : 0;
  }
  return ((candidate.errorRate - baseline.errorRate) / baseline.errorRate) * 100;
}

export async function evaluateDeployment(): Promise<DeploymentDecision> {
  const policy = await loadPolicy();
  const stage = parseStage(process.env.AUTOPILOT_DEPLOY_STAGE);

  const baselinePath =
    process.env.AUTOPILOT_BASELINE_RUN_LOG_PATH?.trim() ||
    process.env.RUN_LOG_PATH?.trim() ||
    repoPath("apps/agent/data/runs.ndjson");
  const candidatePath =
    process.env.AUTOPILOT_CANDIDATE_RUN_LOG_PATH?.trim() ||
    process.env.AUTOPILOT_CANDIDATE_REPLAY_OUTPUT_PATH?.trim() ||
    repoPath("autonomy/reports/replay-candidate.ndjson");

  const hfFloorWad = BigInt(policy.deployment.hf_floor_wad);
  const [baseline, metrics] = await Promise.all([
    collectRunMetrics({ runLogPath: baselinePath, hfFloorWad }),
    collectRunMetrics({ runLogPath: candidatePath, hfFloorWad })
  ]);

  const reasons: string[] = [];
  const rollbackReasons: string[] = [];
  const regression = errorRegressionPct(metrics, baseline);

  if (metrics.hfBreachCount > 0) {
    rollbackReasons.push(`HF floor breach count=${metrics.hfBreachCount}`);
  }
  if (metrics.consecutiveFailures > policy.deployment.max_consecutive_failures) {
    rollbackReasons.push(
      `Consecutive failures ${metrics.consecutiveFailures} > ${policy.deployment.max_consecutive_failures}`
    );
  }
  if (metrics.runwayDeadCount > baseline.runwayDeadCount) {
    rollbackReasons.push(
      `Runway dead incidents increased ${baseline.runwayDeadCount} -> ${metrics.runwayDeadCount}`
    );
  }
  if (regression > policy.deployment.max_error_rate_regression_pct) {
    rollbackReasons.push(
      `Error rate regression ${regression.toFixed(2)}% > ${policy.deployment.max_error_rate_regression_pct}%`
    );
  }

  if (rollbackReasons.length > 0) {
    return {
      stage: "rolled_back",
      action: "rollback",
      reasons: rollbackReasons,
      metrics,
      baseline,
      executions: [],
      generatedAt: nowIso()
    };
  }

  let action: DeploymentDecision["action"] = "hold";
  let nextStage: DeploymentStage = stage;

  if (stage === "shadow_canary" && metrics.dryRunCount >= policy.deployment.shadow_canary_cycles) {
    action = "promote";
    nextStage = "live_canary";
    reasons.push(
      `Shadow canary complete (${metrics.dryRunCount}/${policy.deployment.shadow_canary_cycles} dry-run cycles)`
    );
  } else if (stage === "live_canary" && metrics.liveRunCount >= policy.deployment.live_canary_min_runs) {
    action = "promote";
    nextStage = "promoted";
    reasons.push(
      `Live canary complete (${metrics.liveRunCount}/${policy.deployment.live_canary_min_runs} live runs)`
    );
  } else if (stage === "promoted") {
    reasons.push("Already promoted; continuing steady-state monitoring");
  } else {
    reasons.push("Canary stage still collecting evidence");
  }

  const decision: DeploymentDecision = {
    stage: nextStage,
    action,
    reasons,
    metrics,
    baseline,
    executions: [],
    generatedAt: nowIso()
  };
  return decision;
}

function resolvePromoteCommand(stage: DeploymentStage): string | undefined {
  if (stage === "live_canary") {
    return (
      process.env.AUTOPILOT_DEPLOY_PROMOTE_TO_LIVE_COMMAND?.trim() ||
      process.env.AUTOPILOT_DEPLOY_PROMOTE_COMMAND?.trim() ||
      undefined
    );
  }
  if (stage === "promoted") {
    return (
      process.env.AUTOPILOT_DEPLOY_PROMOTE_TO_PROD_COMMAND?.trim() ||
      process.env.AUTOPILOT_DEPLOY_PROMOTE_COMMAND?.trim() ||
      undefined
    );
  }
  return process.env.AUTOPILOT_DEPLOY_PROMOTE_COMMAND?.trim() || undefined;
}

function resolveRollbackCommand(): string | undefined {
  return process.env.AUTOPILOT_DEPLOY_ROLLBACK_COMMAND?.trim() || undefined;
}

async function runDeploymentCommand(name: string, command: string): Promise<DeploymentExecution> {
  const [shell, args] = toShellTuple(command);
  const nodeBinDir = dirname(process.execPath);
  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd: repoPath("."),
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        AUTOPILOT_DEPLOY_ACTION_NAME: name,
        PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`
      }
    });
    return {
      name,
      command,
      ok: true,
      output: `${stdout}${stderr}`.trim()
    };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const stdout = String((error as { stdout?: string }).stdout ?? "");
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      return {
        name,
        command,
        ok: false,
        output: `${stdout}${stderr}`.trim()
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      command,
      ok: false,
      output: message
    };
  }
}

export async function executeDeploymentDecision(
  decision: DeploymentDecision
): Promise<DeploymentDecision> {
  const executions: DeploymentExecution[] = [...decision.executions];

  if (decision.action === "hold") {
    return {
      ...decision,
      executions
    };
  }

  if (decision.action === "rollback") {
    const rollbackCommand = resolveRollbackCommand();
    if (!rollbackCommand) {
      throw new Error("Rollback requested but AUTOPILOT_DEPLOY_ROLLBACK_COMMAND is not configured");
    }
    const rollbackExecution = await runDeploymentCommand("rollback", rollbackCommand);
    executions.push(rollbackExecution);
    if (!rollbackExecution.ok) {
      throw new Error(`Rollback command failed: ${rollbackExecution.output}`);
    }
    return {
      ...decision,
      executions
    };
  }

  const promoteCommand = resolvePromoteCommand(decision.stage);
  if (!promoteCommand) {
    throw new Error(
      `Promotion to ${decision.stage} requested but no promote command is configured`
    );
  }
  const promoteExecution = await runDeploymentCommand("promote", promoteCommand);
  executions.push(promoteExecution);
  if (promoteExecution.ok) {
    return {
      ...decision,
      executions
    };
  }

  const rollbackCommand = resolveRollbackCommand();
  if (!rollbackCommand) {
    throw new Error(
      `Promotion command failed and AUTOPILOT_DEPLOY_ROLLBACK_COMMAND is not configured: ${promoteExecution.output}`
    );
  }
  const rollbackExecution = await runDeploymentCommand("rollback", rollbackCommand);
  executions.push(rollbackExecution);
  if (!rollbackExecution.ok) {
    throw new Error(
      `Promotion failed and rollback command also failed. promote=${promoteExecution.output}; rollback=${rollbackExecution.output}`
    );
  }

  return {
    ...decision,
    stage: "rolled_back",
    action: "rollback",
    reasons: [...decision.reasons, "Promotion command failed; auto-rollback executed"],
    executions
  };
}

async function writeDeploymentDecisionReport(decision: DeploymentDecision): Promise<void> {
  await writeJson(
    process.env.AUTOPILOT_DEPLOY_REPORT_PATH?.trim() || repoPath("autonomy/reports/deploy-decision.json"),
    decision
  );
}

export async function runDeploymentController(): Promise<DeploymentDecision> {
  const evaluated = await evaluateDeployment();
  const executed = await executeDeploymentDecision(evaluated);
  await writeDeploymentDecisionReport(executed);
  return executed;
}

async function main(): Promise<void> {
  const decision = await runDeploymentController();
  console.log(`[autopilot:deploy] stage=${decision.stage} action=${decision.action}`);
  for (const reason of decision.reasons) {
    console.log(`- ${reason}`);
  }
  for (const execution of decision.executions) {
    console.log(`- command ${execution.name} ok=${execution.ok}: ${execution.command}`);
  }
  if (decision.action === "rollback") process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
