import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { nowIso, repoPath, writeJson } from "./common";
import type { ProposalArtifact } from "./types";

const execFileAsync = promisify(execFile);

export type PRDraft = {
  proposalId: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  mode: "execute" | "draft";
  status: "draft_only" | "opened" | "existing";
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  commitSha?: string;
  warnings: string[];
  createdAt: string;
};

type GitHubPullRequest = {
  number: number;
  html_url: string;
};

function parseRepositorySlug(raw: string): string | undefined {
  const normalized = raw.trim();
  if (!normalized) return undefined;

  const scpLike = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/.exec(normalized);
  if (scpLike?.groups?.owner && scpLike.groups.repo) {
    return `${scpLike.groups.owner}/${scpLike.groups.repo}`;
  }

  const httpsLike = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/.exec(normalized);
  if (httpsLike?.groups?.owner && httpsLike.groups.repo) {
    return `${httpsLike.groups.owner}/${httpsLike.groups.repo}`;
  }

  const sshLike = /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/.exec(normalized);
  if (sshLike?.groups?.owner && sshLike.groups.repo) {
    return `${sshLike.groups.owner}/${sshLike.groups.repo}`;
  }

  return undefined;
}

function parseGitHubRepository(): string | undefined {
  const envRepo =
    process.env.AUTOPILOT_GITHUB_REPOSITORY?.trim() || process.env.GITHUB_REPOSITORY?.trim();
  if (envRepo) return envRepo;
  return undefined;
}

async function runGit(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoPath("."),
      maxBuffer: 10 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const stdout = String((error as { stdout?: string }).stdout ?? "");
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      throw new Error(`git ${args.join(" ")} failed: ${(stdout + stderr).trim()}`);
    }
    throw error;
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<{ status: number; data: T }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  return {
    status: response.status,
    data
  };
}

async function createOrFindPullRequest(options: {
  token: string;
  repository: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}): Promise<{ pullRequest: GitHubPullRequest; existing: boolean }> {
  const [owner] = options.repository.split("/");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ssa-autopilot"
  };

  const createResponse = await fetchJson<GitHubPullRequest>(
    `https://api.github.com/repos/${options.repository}/pulls`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: options.title,
        head: options.headBranch,
        base: options.baseBranch,
        body: options.body,
        draft: true
      })
    }
  );

  if (createResponse.status === 201) {
    return {
      pullRequest: createResponse.data,
      existing: false
    };
  }

  if (createResponse.status !== 422) {
    throw new Error(`GitHub PR creation failed (status=${createResponse.status})`);
  }

  const queryHead = encodeURIComponent(`${owner}:${options.headBranch}`);
  const queryBase = encodeURIComponent(options.baseBranch);
  const listResponse = await fetchJson<GitHubPullRequest[]>(
    `https://api.github.com/repos/${options.repository}/pulls?state=open&head=${queryHead}&base=${queryBase}`,
    {
      method: "GET",
      headers
    }
  );
  if (listResponse.status >= 400) {
    throw new Error(`GitHub PR lookup failed (status=${listResponse.status})`);
  }
  const pullRequest = listResponse.data[0];
  if (!pullRequest) {
    throw new Error("GitHub returned 422 for PR creation, but no existing PR was found");
  }
  return {
    pullRequest,
    existing: true
  };
}

async function resolveRepositoryFromGit(remoteName: string): Promise<string | undefined> {
  const remoteUrl = await runGit(["remote", "get-url", remoteName]).catch(() => "");
  return parseRepositorySlug(remoteUrl);
}

async function ensureFileExists(path: string): Promise<void> {
  await access(path);
}

async function resolveBranchBaseRef(
  remote: string,
  baseBranch: string,
  warnings: string[]
): Promise<string> {
  const remoteRef = `${remote}/${baseBranch}`;

  try {
    await runGit(["fetch", remote, baseBranch]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(
      `Failed to fetch remote base ${remoteRef}; falling back to local ${baseBranch}: ${message}`
    );
    return baseBranch;
  }

  const hasRemoteBase =
    (await runGit(["rev-parse", "--verify", remoteRef]).catch(() => "")).trim().length > 0;
  if (hasRemoteBase) return remoteRef;

  warnings.push(`Remote base ref ${remoteRef} not found after fetch; falling back to local ${baseBranch}`);
  return baseBranch;
}

export async function createPrDraft(proposal: ProposalArtifact): Promise<PRDraft> {
  const mode = process.env.AUTOPILOT_PR_MODE?.trim() === "draft" ? "draft" : "execute";
  const baseBranch = process.env.AUTOPILOT_PR_BASE?.trim() || "main";
  const remote = process.env.AUTOPILOT_PR_REMOTE?.trim() || "origin";
  const branch = `autopilot/${proposal.proposalId}`;
  const title = `chore(autopilot): tune policy parameters (${proposal.proposalId})`;
  const bodyLines = [
    `Autopilot proposal generated at ${proposal.createdAt}.`,
    "",
    "## Summary",
    proposal.summary,
    "",
    "## Parameter changes"
  ];
  for (const change of proposal.proposals) {
    bodyLines.push(`- \`${change.key}\`: \`${change.current}\` -> \`${change.proposed}\` (${change.reason})`);
  }
  bodyLines.push("");
  bodyLines.push("## Policy");
  bodyLines.push("- Scoped by autonomy/policy.yaml");
  bodyLines.push("- No direct push to protected branches");

  const draft: PRDraft = {
    proposalId: proposal.proposalId,
    branch,
    baseBranch,
    title,
    body: bodyLines.join("\n"),
    mode,
    status: "draft_only",
    warnings: [],
    createdAt: nowIso()
  };

  const outputPath =
    process.env.AUTOPILOT_PR_DRAFT_PATH?.trim() || repoPath(`autonomy/proposals/${proposal.proposalId}.pr.json`);

  const proposalDir = process.env.AUTOPILOT_PROPOSAL_DIR?.trim() || repoPath("autonomy/proposals");
  const trackedFiles = [
    `${proposalDir}/${proposal.proposalId}.json`,
    `${proposalDir}/${proposal.proposalId}.env`,
    `${proposalDir}/${proposal.proposalId}.md`,
    outputPath
  ]
    .map((path) => resolve(path))
    .filter((path, index, list) => list.indexOf(path) === index);

  if (mode === "draft") {
    await writeJson(outputPath, draft);
    return draft;
  }

  // Persist an initial draft before staging so the tracked .pr.json file always exists in execute mode.
  await writeJson(outputPath, draft);

  const repoRoot = repoPath(".");
  const trackedRepoFiles = trackedFiles.map((path) => {
    const rel = relative(repoRoot, path);
    if (rel.startsWith("..")) {
      throw new Error(`Refusing to git add path outside repository root: ${path}`);
    }
    return rel;
  });

  for (const filePath of trackedFiles) {
    await ensureFileExists(filePath);
  }

  const repository =
    parseGitHubRepository() || (await resolveRepositoryFromGit(remote)) || undefined;
  const token =
    process.env.AUTOPILOT_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim();
  if (!repository) {
    throw new Error("Missing GitHub repository (AUTOPILOT_GITHUB_REPOSITORY or GITHUB_REPOSITORY)");
  }
  if (!token) {
    throw new Error("Missing GitHub token (AUTOPILOT_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN)");
  }

  const previousRef = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const restoreRef = parseBoolean(process.env.AUTOPILOT_PR_RESTORE_REF, true);

  try {
    const branchBaseRef = await resolveBranchBaseRef(remote, baseBranch, draft.warnings);
    await runGit(["checkout", "-B", branch, branchBaseRef]);
    await runGit(["add", "--", ...trackedRepoFiles]);
    const hasStagedChanges =
      (await runGit(["diff", "--cached", "--name-only"]).catch(() => "")).trim().length > 0;
    if (hasStagedChanges) {
      const commitMessage =
        process.env.AUTOPILOT_PR_COMMIT_MESSAGE?.trim() ||
        `chore(autopilot): apply proposal ${proposal.proposalId}`;
      await runGit(["commit", "-m", commitMessage]);
    }
    await runGit(["push", "--set-upstream", remote, branch]);

    const currentCommit = await runGit(["rev-parse", "HEAD"]);
    const prResult = await createOrFindPullRequest({
      token,
      repository,
      title,
      body: draft.body,
      headBranch: branch,
      baseBranch
    });

    draft.status = prResult.existing ? "existing" : "opened";
    draft.pullRequestNumber = prResult.pullRequest.number;
    draft.pullRequestUrl = prResult.pullRequest.html_url;
    draft.commitSha = currentCommit;
    await writeJson(outputPath, draft);
    return draft;
  } finally {
    if (restoreRef && previousRef && previousRef !== "HEAD" && previousRef !== branch) {
      await runGit(["checkout", previousRef]).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        draft.warnings.push(`Failed to restore previous git ref ${previousRef}: ${message}`);
      });
    }
  }
}
