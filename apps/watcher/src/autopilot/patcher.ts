import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ensureParent, nowIso, repoPath, stableStringify, writeJson } from "./common";
import type { ParameterProposal, ProposalArtifact, RunAggregate } from "./types";

const DEFAULT_AGENT_ENV_EXAMPLE_PATH = repoPath("apps/agent/.env.example");
const DEFAULT_PROPOSAL_DIR = repoPath("autonomy/proposals");

function normalizeMetrics(metrics: RunAggregate): Record<string, string | number | null> {
  return {
    totalRuns: metrics.totalRuns,
    okRuns: metrics.okRuns,
    errorRuns: metrics.errorRuns,
    skippedRuns: metrics.skippedRuns,
    dryRunCount: metrics.dryRunCount,
    liveRunCount: metrics.liveRunCount,
    successRate: Number(metrics.successRate.toFixed(8)),
    errorRate: Number(metrics.errorRate.toFixed(8)),
    minHealthFactorWad: metrics.minHealthFactorWad == null ? null : metrics.minHealthFactorWad.toString(),
    hfBreachCount: metrics.hfBreachCount,
    runwayDeadCount: metrics.runwayDeadCount,
    netDeltaUsdSum: metrics.netDeltaUsdSum.toString(),
    consecutiveFailures: metrics.consecutiveFailures,
    latestTimestamp: metrics.latestTimestamp
  };
}

function buildProposalId(options: {
  phase: number;
  summary: string;
  proposals: ParameterProposal[];
  metrics: RunAggregate;
}): string {
  const payload = stableStringify({
    phase: options.phase,
    summary: options.summary,
    proposals: options.proposals.map((proposal) => ({
      key: proposal.key,
      current: proposal.current,
      proposed: proposal.proposed,
      reason: proposal.reason
    })),
    metrics: normalizeMetrics(options.metrics)
  });
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return `autopilot-${digest}`;
}

export function applyProposalsToEnv(raw: string, proposals: ParameterProposal[]): string {
  const lines = raw.split("\n");
  const proposalMap = new Map(proposals.map((proposal) => [proposal.key, proposal.proposed]));

  return lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) return line;
      const key = match[1];
      const value = proposalMap.get(key);
      if (!value) return line;
      return `${key}=${value}`;
    })
    .join("\n");
}

export async function createProposalArtifact(options: {
  phase: number;
  metrics: RunAggregate;
  proposals: ParameterProposal[];
  summary: string;
  proposalId?: string;
  proposalDir?: string;
  sourceEnvPath?: string;
}): Promise<ProposalArtifact | null> {
  if (options.proposals.length === 0) return null;

  const proposalId =
    options.proposalId ??
    buildProposalId({
      phase: options.phase,
      summary: options.summary,
      proposals: options.proposals,
      metrics: options.metrics
    });
  const proposalDir = options.proposalDir || process.env.AUTOPILOT_PROPOSAL_DIR?.trim() || DEFAULT_PROPOSAL_DIR;
  const sourceEnvPath =
    options.sourceEnvPath || process.env.AUTOPILOT_AGENT_ENV_EXAMPLE_PATH?.trim() || DEFAULT_AGENT_ENV_EXAMPLE_PATH;

  const rawEnv = await readFile(sourceEnvPath, "utf8");
  const proposedEnv = applyProposalsToEnv(rawEnv, options.proposals);
  const createdAt = nowIso();

  const artifact: ProposalArtifact = {
    proposalId,
    createdAt,
    phase: options.phase,
    summary: options.summary,
    proposals: options.proposals,
    sourceMetrics: options.metrics
  };

  const proposalJsonPath = `${proposalDir}/${proposalId}.json`;
  const proposalEnvPath = `${proposalDir}/${proposalId}.env`;
  const proposalMdPath = `${proposalDir}/${proposalId}.md`;

  await writeJson(proposalJsonPath, artifact);
  await ensureParent(proposalEnvPath);
  await writeFile(proposalEnvPath, proposedEnv, "utf8");

  const markdown = [
    `# Autopilot Proposal ${proposalId}`,
    "",
    `Created: ${createdAt}`,
    `Phase: ${options.phase}`,
    "",
    "## Summary",
    options.summary,
    "",
    "## Parameter Changes",
    ...options.proposals.map(
      (proposal) => `- \`${proposal.key}\`: \`${proposal.current}\` -> \`${proposal.proposed}\` (${proposal.reason})`
    )
  ].join("\n");

  await writeFile(proposalMdPath, `${markdown}\n`, "utf8");

  const applyDirectly = process.env.AUTOPILOT_APPLY_PROPOSAL_TO_ENV_EXAMPLE?.trim() === "true";
  if (applyDirectly) {
    await writeFile(sourceEnvPath, proposedEnv, "utf8");
  }

  return artifact;
}
