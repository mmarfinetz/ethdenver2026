import { strict as assert } from "node:assert";
import test from "node:test";
import { runPolicyGate } from "./policyGate";

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

test("runPolicyGate fails in strict diff-source mode when git diff is unavailable", async () => {
  await withEnv(
    {
      AUTOPILOT_POLICY_GATE_STRICT_DIFF_SOURCE: "true",
      AUTOPILOT_DIFF_SUMMARY_PATH: undefined,
      AUTOPILOT_DIFF_PATCH_PATH: undefined,
      AUTOPILOT_GIT_BASE: undefined,
      AUTOPILOT_GIT_HEAD: undefined,
      PATH: ""
    },
    async () => {
      await assert.rejects(runPolicyGate(), /strict diff-source mode is enabled/);
    }
  );
});

test("runPolicyGate permits empty diff fallback only when strict mode is disabled", async () => {
  await withEnv(
    {
      AUTOPILOT_POLICY_GATE_STRICT_DIFF_SOURCE: "false",
      AUTOPILOT_DIFF_SUMMARY_PATH: undefined,
      AUTOPILOT_DIFF_PATCH_PATH: undefined,
      AUTOPILOT_GIT_BASE: undefined,
      AUTOPILOT_GIT_HEAD: undefined,
      PATH: ""
    },
    async () => {
      const result = await runPolicyGate();
      assert.equal(result.ok, true);
      assert.equal(result.filesChanged, 0);
      assert.equal(result.warnings.length > 0, true);
    }
  );
});
