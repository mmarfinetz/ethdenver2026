import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { nowIso, repoPath, toShellTuple, writeJson } from "./common";
import { loadPolicy } from "./policy";
import { runReplay } from "./replay";
import type { VerificationCheck, VerificationReport } from "./types";

const execFileAsync = promisify(execFile);

async function runCommand(command: string): Promise<VerificationCheck> {
  const normalizedCommand = command.startsWith("pnpm ") ? `corepack ${command}` : command;
  const [shell, args] = toShellTuple(normalizedCommand);
  const nodeBinDir = dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: `${nodeBinDir}:${process.env.PATH ?? ""}`
  };
  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      maxBuffer: 20 * 1024 * 1024,
      env,
      cwd: repoPath(".")
    });
    const output = `${stdout}${stderr}`.trim();
    return {
      command,
      ok: true,
      output
    };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const stdout = String((error as { stdout?: string }).stdout ?? "");
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      return {
        command,
        ok: false,
        output: `${stdout}${stderr}`.trim()
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      command,
      ok: false,
      output: message
    };
  }
}

async function runCommandWithFallback(
  command: string,
  fallbackCommand?: string
): Promise<VerificationCheck> {
  const primary = await runCommand(command);
  if (primary.ok || !fallbackCommand) return primary;

  const needsFallback =
    primary.output.includes("bad option: --import") ||
    primary.output.includes("command not found: pnpm") ||
    primary.output.includes("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL");
  if (!needsFallback) return primary;

  const fallback = await runCommand(fallbackCommand);
  if (fallback.ok) {
    return {
      command,
      ok: true,
      output: `${primary.output}\n[fallback] ${fallbackCommand}\n${fallback.output}`.trim()
    };
  }
  return {
    command,
    ok: false,
    output: `${primary.output}\n[fallback] ${fallbackCommand}\n${fallback.output}`.trim()
  };
}

export async function runVerification(): Promise<VerificationReport> {
  const policy = await loadPolicy();
  const replay = await runReplay();
  const checks: VerificationCheck[] = [];
  const nodeExec = JSON.stringify(process.execPath);

  for (const command of policy.verification.required_commands) {
    // Replay is already executed above for a dedicated report artifact.
    if (command === "pnpm --filter watcher autopilot:replay") {
      checks.push({
        command,
        ok: replay.ok,
        output: `replay report: ${process.env.AUTOPILOT_REPLAY_REPORT_PATH?.trim() || repoPath("autonomy/reports/replay.json")}`
      });
      continue;
    }
    if (command === "pnpm --filter agent test") {
      checks.push(
        await runCommandWithFallback(
          command,
          `cd apps/agent && ${nodeExec} --import tsx/esm --test src/**/*.test.ts`
        )
      );
      continue;
    }
    checks.push(await runCommand(command));
  }

  const report: VerificationReport = {
    replayOk: replay.ok,
    checks,
    ok: replay.ok && checks.every((item) => item.ok),
    generatedAt: nowIso()
  };

  const reportPath =
    process.env.AUTOPILOT_VERIFY_REPORT_PATH?.trim() || repoPath("autonomy/reports/verification.json");
  await writeJson(reportPath, report);

  return report;
}

async function main(): Promise<void> {
  const report = await runVerification();
  console.log(`[autopilot:verify] ok=${report.ok}`);
  for (const item of report.checks) {
    console.log(`- ${item.ok ? "ok" : "fail"} ${item.command}`);
  }
  if (!report.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
