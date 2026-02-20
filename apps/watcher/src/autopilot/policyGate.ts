import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { nowIso, parseBoolean, repoPath, writeJson } from "./common";
import { loadPolicy } from "./policy";
import type { AutonomyPolicy, DiffFileStats, DiffSummary, PolicyGateResult } from "./types";

const execFileAsync = promisify(execFile);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function escapeRegex(raw: string): string {
  return raw.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  let pattern = normalizePath(glob);
  pattern = escapeRegex(pattern);
  pattern = pattern.replace(/\*\*/g, "__DOUBLE_STAR__");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  const normalized = normalizePath(path);
  return globs.some((glob) => globToRegex(glob).test(normalized));
}

function splitArgs(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function getGitDiffSummary(baseRef?: string, headRef?: string): Promise<DiffSummary> {
  const refs = [baseRef, headRef].filter(Boolean) as string[];
  const numstatArgs = ["diff", "--numstat", ...refs];
  const patchArgs = ["diff", "-U0", "--no-color", ...refs];

  const [numstat, patch] = await Promise.all([
    execFileAsync("git", numstatArgs, { maxBuffer: 10 * 1024 * 1024 }),
    execFileAsync("git", patchArgs, { maxBuffer: 10 * 1024 * 1024 })
  ]);

  const patchByFile = parsePatchByFile(patch.stdout);
  const files: DiffFileStats[] = [];
  let added = 0;
  let deleted = 0;

  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, path] = line.split("\t");
    if (!path) continue;
    const parsedAdded = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10);
    const parsedDeleted = deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10);
    const safeAdded = Number.isFinite(parsedAdded) ? parsedAdded : 0;
    const safeDeleted = Number.isFinite(parsedDeleted) ? parsedDeleted : 0;

    files.push({
      path: normalizePath(path),
      added: safeAdded,
      deleted: safeDeleted,
      patch: patchByFile.get(normalizePath(path)) ?? ""
    });
    added += safeAdded;
    deleted += safeDeleted;
  }

  return { files, added, deleted };
}

function parsePatchByFile(rawPatch: string): Map<string, string> {
  const map = new Map<string, string>();
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath) return;
    map.set(currentPath, currentLines.join("\n"));
    currentLines = [];
  };

  for (const line of rawPatch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentPath = match ? normalizePath(match[2]) : null;
      if (currentPath) currentLines.push(line);
      continue;
    }
    if (currentPath) currentLines.push(line);
  }
  flush();
  return map;
}

function parseDiffPatch(rawPatch: string): DiffSummary {
  const patchByFile = parsePatchByFile(rawPatch);
  const files: DiffFileStats[] = [];
  let added = 0;
  let deleted = 0;

  for (const [path, patch] of patchByFile.entries()) {
    let fileAdded = 0;
    let fileDeleted = 0;

    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) fileAdded += 1;
      if (line.startsWith("-")) fileDeleted += 1;
    }

    files.push({
      path: normalizePath(path),
      added: fileAdded,
      deleted: fileDeleted,
      patch
    });
    added += fileAdded;
    deleted += fileDeleted;
  }

  return { files, added, deleted };
}

function extractNumericLiterals(line: string): number[] {
  if (line.includes("0x")) return [];
  const matches = line.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  return matches
    .map((match) => Number.parseFloat(match))
    .filter((value) => Number.isFinite(value) && value < 1e12);
}

function maxNumericLiteralDeltaPct(patch: string): number {
  const removed: number[] = [];
  const added: number[] = [];

  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("-")) removed.push(...extractNumericLiterals(line.slice(1)));
    if (line.startsWith("+")) added.push(...extractNumericLiterals(line.slice(1)));
  }

  const pairCount = Math.min(removed.length, added.length);
  let maxPct = 0;
  for (let i = 0; i < pairCount; i += 1) {
    const before = removed[i];
    const after = added[i];
    if (before === 0) continue;
    const pct = Math.abs(((after - before) / before) * 100);
    if (pct > maxPct) maxPct = pct;
  }
  return maxPct;
}

function evaluateTimelockReasons(policy: AutonomyPolicy, diff: DiffSummary): string[] {
  const reasons: string[] = [];

  for (const rule of policy.risk.timelock_required_if) {
    if (rule.startsWith("touches:")) {
      const pattern = rule.slice("touches:".length);
      if (diff.files.some((file) => matchesAnyGlob(file.path, [pattern]))) {
        reasons.push(`Touched high-risk path ${pattern}`);
      }
      continue;
    }

    if (rule.startsWith("changes_numeric_literal_over_pct:")) {
      const threshold = Number.parseFloat(rule.slice("changes_numeric_literal_over_pct:".length));
      if (!Number.isFinite(threshold)) continue;

      const maxDelta = diff.files.reduce((max, file) => Math.max(max, maxNumericLiteralDeltaPct(file.patch)), 0);
      if (maxDelta > threshold) {
        reasons.push(`Numeric literal delta ${maxDelta.toFixed(2)}% exceeded ${threshold}%`);
      }
    }
  }

  return reasons;
}

function evaluateForbiddenSymbols(symbolRules: string[], diff: DiffSummary): string[] {
  const violations: string[] = [];

  for (const rule of symbolRules) {
    const [path, symbol] = rule.split(":");
    if (!path || !symbol) continue;
    const file = diff.files.find((entry) => normalizePath(entry.path) === normalizePath(path));
    if (!file) continue;
    if (file.patch.includes(symbol)) {
      violations.push(`Forbidden symbol touched: ${rule}`);
    }
  }

  return violations;
}

async function readDiffSummaryFromFile(path: string): Promise<DiffSummary> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as {
    files?: Array<{ path: string; added: number; deleted: number; patch?: string }>;
    added?: number;
    deleted?: number;
  };

  const files = (parsed.files ?? []).map((file) => ({
    path: normalizePath(file.path),
    added: file.added ?? 0,
    deleted: file.deleted ?? 0,
    patch: file.patch ?? ""
  }));

  const added = parsed.added ?? files.reduce((sum, file) => sum + file.added, 0);
  const deleted = parsed.deleted ?? files.reduce((sum, file) => sum + file.deleted, 0);
  return { files, added, deleted };
}

async function loadDiffSummary(): Promise<{ diff: DiffSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const strictDiffSource = parseBoolean(process.env.AUTOPILOT_POLICY_GATE_STRICT_DIFF_SOURCE?.trim(), true);
  const diffSummaryPath = process.env.AUTOPILOT_DIFF_SUMMARY_PATH?.trim();
  if (diffSummaryPath) {
    return {
      diff: await readDiffSummaryFromFile(diffSummaryPath),
      warnings
    };
  }

  const diffPatchPath = process.env.AUTOPILOT_DIFF_PATCH_PATH?.trim();
  if (diffPatchPath) {
    const rawPatch = await readFile(diffPatchPath, "utf8");
    return {
      diff: parseDiffPatch(rawPatch),
      warnings
    };
  }

  const baseRef = process.env.AUTOPILOT_GIT_BASE?.trim();
  const headRef = process.env.AUTOPILOT_GIT_HEAD?.trim();
  try {
    return {
      diff: await getGitDiffSummary(baseRef, headRef),
      warnings
    };
  } catch (error) {
    if (strictDiffSource) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to load git diff and strict diff-source mode is enabled. Set AUTOPILOT_DIFF_SUMMARY_PATH or AUTOPILOT_DIFF_PATCH_PATH. git error: ${message}`
      );
    }
    warnings.push(
      "Git diff unavailable and no AUTOPILOT_DIFF_SUMMARY_PATH/AUTOPILOT_DIFF_PATCH_PATH provided; treating as empty diff because AUTOPILOT_POLICY_GATE_STRICT_DIFF_SOURCE=false"
    );
    return {
      diff: {
        files: [],
        added: 0,
        deleted: 0
      },
      warnings
    };
  }
}

export async function runPolicyGate(): Promise<PolicyGateResult> {
  const policy = await loadPolicy();
  const { diff, warnings } = await loadDiffSummary();

  const violations: string[] = [];
  const filesChanged = diff.files.length;

  if (filesChanged > policy.limits.max_files_changed) {
    violations.push(
      `Changed file count ${filesChanged} exceeds max ${policy.limits.max_files_changed}`
    );
  }
  if (diff.added > policy.limits.max_added_lines) {
    violations.push(`Added lines ${diff.added} exceed max ${policy.limits.max_added_lines}`);
  }
  if (diff.deleted > policy.limits.max_deleted_lines) {
    violations.push(`Deleted lines ${diff.deleted} exceed max ${policy.limits.max_deleted_lines}`);
  }

  for (const file of diff.files) {
    if (matchesAnyGlob(file.path, policy.forbidden.paths)) {
      violations.push(`Forbidden path touched: ${file.path}`);
      continue;
    }
    if (!matchesAnyGlob(file.path, policy.allowed.paths)) {
      violations.push(`Path outside autonomous allow-list: ${file.path}`);
    }
  }

  violations.push(...evaluateForbiddenSymbols(policy.forbidden.symbols, diff));

  const highRiskReasons = evaluateTimelockReasons(policy, diff);
  const requiresTimelock = highRiskReasons.length > 0;
  const requiresHumanApproval =
    filesChanged > 0 && (policy.mode.require_human_approval_default || requiresTimelock);

  return {
    ok: violations.length === 0,
    filesChanged,
    addedLines: diff.added,
    deletedLines: diff.deleted,
    requiresHumanApproval,
    requiresTimelock,
    highRiskReasons,
    violations,
    warnings
  };
}

async function main(): Promise<void> {
  const result = await runPolicyGate();
  const report = {
    generatedAt: nowIso(),
    result
  };
  const outputPath =
    process.env.AUTOPILOT_POLICY_GATE_REPORT_PATH?.trim() || repoPath("autonomy/reports/policy-gate.json");
  await writeJson(outputPath, report);

  const header = `[autopilot:policy-gate] files=${result.filesChanged} +${result.addedLines}/-${result.deletedLines}`;
  if (result.ok) {
    console.log(`${header} ok=true`);
  } else {
    console.error(`${header} ok=false`);
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
  }
  for (const reason of result.highRiskReasons) {
    console.log(`- high-risk: ${reason}`);
  }
  for (const warning of result.warnings) {
    console.log(`- warning: ${warning}`);
  }

  if (!result.ok) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
