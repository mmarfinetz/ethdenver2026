import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertHumanControls } from "./controls";
import type { PolicyGateResult } from "./types";

function baseGate(): PolicyGateResult {
  return {
    ok: true,
    filesChanged: 1,
    addedLines: 1,
    deletedLines: 0,
    requiresHumanApproval: false,
    requiresTimelock: false,
    highRiskReasons: [],
    violations: [],
    warnings: []
  };
}

test("assertHumanControls enforces proposal-bound approval records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-controls-"));
  const approvalPath = join(dir, "approval.json");
  await writeFile(
    approvalPath,
    JSON.stringify(
      {
        approved: true,
        approvedBy: "ops@example.com",
        approvedAt: "2026-02-19T00:00:00.000Z",
        proposalId: "autopilot-fixed-id"
      },
      null,
      2
    ),
    "utf8"
  );

  await assert.rejects(
    assertHumanControls({
      controls: {
        emergencyStop: false,
        requireHumanApproval: true,
        timelockHours: 0,
        approvalFile: approvalPath
      },
      gate: baseGate(),
      proposalId: "autopilot-other-id"
    }),
    /Approval proposalId mismatch/
  );

  await assert.doesNotReject(
    assertHumanControls({
      controls: {
        emergencyStop: false,
        requireHumanApproval: true,
        timelockHours: 0,
        approvalFile: approvalPath
      },
      gate: baseGate(),
      proposalId: "autopilot-fixed-id"
    })
  );
});
