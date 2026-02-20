import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repoPath } from "./common";
import { createPrDraft } from "./pr";
import type { ProposalArtifact } from "./types";

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

async function withMockFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function makeProposal(proposalId: string): ProposalArtifact {
  return {
    proposalId,
    createdAt: "2026-02-20T00:00:00.000Z",
    phase: 1,
    summary: "test proposal",
    proposals: [
      {
        key: "HF_BUFFER",
        current: "0.10",
        proposed: "0.12",
        reason: "safety increase"
      }
    ],
    sourceMetrics: {
      totalRuns: 10,
      okRuns: 8,
      errorRuns: 2,
      skippedRuns: 0,
      dryRunCount: 10,
      liveRunCount: 0,
      successRate: 0.8,
      errorRate: 0.2,
      minHealthFactorWad: 1200000000000000000n,
      hfBreachCount: 0,
      runwayDeadCount: 0,
      netDeltaUsdSum: 10n,
      consecutiveFailures: 1,
      latestTimestamp: "2026-02-20T00:00:00.000Z"
    }
  };
}

async function writeProposalInputs(proposalDir: string, proposalId: string): Promise<void> {
  await mkdir(proposalDir, { recursive: true });
  await writeFile(join(proposalDir, `${proposalId}.json`), "{\"ok\":true}\n", "utf8");
  await writeFile(join(proposalDir, `${proposalId}.env`), "HF_BUFFER=0.12\n", "utf8");
  await writeFile(join(proposalDir, `${proposalId}.md`), "# proposal\n", "utf8");
}

async function createFakeGit(dir: string, gitLogPath: string): Promise<string> {
  const gitPath = join(dir, "git");
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$*" >> "$AUTOPILOT_TEST_GIT_LOG"
case "$*" in
  "remote get-url "*)
    echo "https://github.com/acme/autopilot-demo.git"
    ;;
  "rev-parse --abbrev-ref HEAD")
    echo "feature/local-head"
    ;;
  "rev-parse --verify origin/main")
    echo "1111111111111111111111111111111111111111"
    ;;
  "diff --cached --name-only")
    echo "autonomy/proposals/staged.json"
    ;;
  "rev-parse HEAD")
    echo "2222222222222222222222222222222222222222"
    ;;
esac
exit 0
`,
    "utf8"
  );
  await chmod(gitPath, 0o755);
  await writeFile(gitLogPath, "", "utf8");
  return dir;
}

test("createPrDraft supports draft-only mode without git side effects", { concurrency: false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-pr-"));
  const proposalId = "autopilot-test-proposal";
  const proposalDir = join(dir, "proposals");
  const outputPath = join(proposalDir, `${proposalId}.pr.json`);

  await writeProposalInputs(proposalDir, proposalId);

  await withEnv(
    {
      AUTOPILOT_PR_MODE: "draft",
      AUTOPILOT_PR_DRAFT_PATH: outputPath,
      AUTOPILOT_PROPOSAL_DIR: proposalDir
    },
    async () => {
      const result = await createPrDraft(makeProposal(proposalId));
      assert.equal(result.mode, "draft");
      assert.equal(result.status, "draft_only");

      const persisted = JSON.parse(await readFile(outputPath, "utf8")) as { mode: string; status: string };
      assert.equal(persisted.mode, "draft");
      assert.equal(persisted.status, "draft_only");
    }
  );
});

test(
  "createPrDraft execute mode stages proposal artifacts, anchors branch to remote base, and opens PR",
  { concurrency: false },
  async () => {
    const toolsDir = await mkdtemp(join(tmpdir(), "autopilot-pr-tools-"));
    const gitLogPath = join(toolsDir, "git.log");
    await createFakeGit(toolsDir, gitLogPath);

    const proposalDir = await mkdtemp(join(repoPath("autonomy/proposals"), "pr-exec-"));
    const proposalId = `autopilot-exec-${Date.now()}`;
    const outputPath = join(proposalDir, `${proposalId}.pr.json`);
    await writeProposalInputs(proposalDir, proposalId);

    const requests: Array<{ url: string; method: string | undefined; body: string | null }> = [];

    try {
      await withMockFetch(
        async (url, init) => {
          requests.push({
            url,
            method: init?.method,
            body: typeof init?.body === "string" ? init.body : null
          });
          return new Response(
            JSON.stringify({
              number: 101,
              html_url: "https://github.com/acme/autopilot-demo/pull/101"
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" }
            }
          );
        },
        async () => {
          await withEnv(
            {
              AUTOPILOT_PR_MODE: "execute",
              AUTOPILOT_PR_BASE: "main",
              AUTOPILOT_PR_REMOTE: "origin",
              AUTOPILOT_PR_DRAFT_PATH: outputPath,
              AUTOPILOT_PROPOSAL_DIR: proposalDir,
              AUTOPILOT_GITHUB_REPOSITORY: undefined,
              AUTOPILOT_GITHUB_TOKEN: "token-123",
              GITHUB_TOKEN: undefined,
              GH_TOKEN: undefined,
              AUTOPILOT_TEST_GIT_LOG: gitLogPath,
              PATH: `${toolsDir}:${process.env.PATH ?? ""}`
            },
            async () => {
              const result = await createPrDraft(makeProposal(proposalId));
              assert.equal(result.mode, "execute");
              assert.equal(result.status, "opened");
              assert.equal(result.pullRequestNumber, 101);
              assert.equal(result.pullRequestUrl, "https://github.com/acme/autopilot-demo/pull/101");
              assert.equal(result.commitSha, "2222222222222222222222222222222222222222");

              const persisted = JSON.parse(await readFile(outputPath, "utf8")) as {
                status: string;
                pullRequestNumber: number;
              };
              assert.equal(persisted.status, "opened");
              assert.equal(persisted.pullRequestNumber, 101);
            }
          );
        }
      );

      const gitLogLines = (await readFile(gitLogPath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const fetchIndex = gitLogLines.indexOf("fetch origin main");
      const checkoutIndex = gitLogLines.indexOf(`checkout -B autopilot/${proposalId} origin/main`);
      assert.equal(fetchIndex >= 0, true);
      assert.equal(checkoutIndex > fetchIndex, true);
      assert.equal(
        gitLogLines.some((line) => line.startsWith("add --") && line.includes(`${proposalId}.pr.json`)),
        true
      );
      assert.equal(gitLogLines.includes(`push --set-upstream origin autopilot/${proposalId}`), true);

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, "POST");
      assert.equal(
        requests[0]?.url,
        "https://api.github.com/repos/acme/autopilot-demo/pulls"
      );
      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as { head?: string; base?: string };
      assert.equal(requestBody.head, `autopilot/${proposalId}`);
      assert.equal(requestBody.base, "main");
    } finally {
      await rm(proposalDir, { recursive: true, force: true });
    }
  }
);

test("createPrDraft execute mode reuses existing PR on GitHub 422", { concurrency: false }, async () => {
  const toolsDir = await mkdtemp(join(tmpdir(), "autopilot-pr-tools-"));
  const gitLogPath = join(toolsDir, "git.log");
  await createFakeGit(toolsDir, gitLogPath);

  const proposalDir = await mkdtemp(join(repoPath("autonomy/proposals"), "pr-existing-"));
  const proposalId = `autopilot-existing-${Date.now()}`;
  const outputPath = join(proposalDir, `${proposalId}.pr.json`);
  await writeProposalInputs(proposalDir, proposalId);

  const requestUrls: string[] = [];

  try {
    await withMockFetch(
      async (url, init) => {
        requestUrls.push(url);
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              message: "Validation Failed"
            }),
            {
              status: 422,
              headers: { "content-type": "application/json" }
            }
          );
        }

        return new Response(
          JSON.stringify([
            {
              number: 202,
              html_url: "https://github.com/acme/autopilot-demo/pull/202"
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      },
      async () => {
        await withEnv(
          {
            AUTOPILOT_PR_MODE: "execute",
            AUTOPILOT_PR_BASE: "main",
            AUTOPILOT_PR_REMOTE: "origin",
            AUTOPILOT_PR_DRAFT_PATH: outputPath,
            AUTOPILOT_PROPOSAL_DIR: proposalDir,
            AUTOPILOT_GITHUB_REPOSITORY: "acme/autopilot-demo",
            AUTOPILOT_GITHUB_TOKEN: "token-123",
            AUTOPILOT_TEST_GIT_LOG: gitLogPath,
            PATH: `${toolsDir}:${process.env.PATH ?? ""}`
          },
          async () => {
            const result = await createPrDraft(makeProposal(proposalId));
            assert.equal(result.status, "existing");
            assert.equal(result.pullRequestNumber, 202);
            assert.equal(result.pullRequestUrl, "https://github.com/acme/autopilot-demo/pull/202");
          }
        );
      }
    );

    assert.equal(requestUrls.length, 2);
    assert.equal(requestUrls[0], "https://api.github.com/repos/acme/autopilot-demo/pulls");
    assert.equal(
      requestUrls[1]?.startsWith(
        "https://api.github.com/repos/acme/autopilot-demo/pulls?state=open&head=acme%3Aautopilot%2F"
      ),
      true
    );
  } finally {
    await rm(proposalDir, { recursive: true, force: true });
  }
});
