import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateProvenanceBundle, verifyProvenanceBundle } from "./provenance";
import type { AutonomyPolicy } from "./types";

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

function minimalPolicy(paths: {
  artifactPathGlob: string;
  manifestPath: string;
  attestationPath: string;
  signaturePath: string;
}): AutonomyPolicy {
  return {
    version: 1,
    mode: {
      default_phase: 1,
      require_human_approval_default: true,
      allow_direct_main_push: false
    },
    allowed: { paths: ["autonomy/**"] },
    forbidden: { paths: ["contracts/src/**"], symbols: [] },
    limits: {
      max_files_changed: 10,
      max_added_lines: 1000,
      max_deleted_lines: 1000
    },
    risk: {
      timelock_hours: 1,
      timelock_required_if: []
    },
    verification: {
      required_commands: [],
      replay_requirements: {
        candidate_must_not_increase_hf_breach_count: true,
        candidate_must_not_increase_failure_count: true,
        candidate_must_not_increase_runway_collapse_count: true,
        candidate_must_preserve_or_improve_success_rate: true,
        candidate_must_preserve_or_improve_net_delta: true
      }
    },
    deployment: {
      shadow_canary_cycles: 1,
      live_canary_min_runs: 1,
      max_consecutive_failures: 1,
      max_error_rate_regression_pct: 50,
      hf_floor_wad: "1100000000000000000",
      rollback_triggers: []
    },
    provenance: {
      artifact_paths: [paths.artifactPathGlob],
      manifest_path: paths.manifestPath,
      attestation_path: paths.attestationPath,
      signature_path: paths.signaturePath
    },
    override_controls: {
      emergency_stop_env: "AUTOPILOT_EMERGENCY_STOP",
      approval_mode_env: "AUTOPILOT_REQUIRE_HUMAN_APPROVAL",
      timelock_env: "AUTOPILOT_TIMELOCK_HOURS",
      approval_file_env: "AUTOPILOT_APPROVAL_FILE"
    },
    rollout: {
      phases: [
        {
          phase: 1,
          name: "Phase 1",
          capabilities: ["proposal"],
          exit_criteria: []
        }
      ],
      trust_model: []
    }
  };
}

test("verifyProvenanceBundle fails closed when signature verification is required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-provenance-"));
  const artifactDir = join(dir, "artifacts");
  const artifactPath = join(artifactDir, "bundle.txt");
  const policyPath = join(dir, "policy.json");
  const manifestPath = join(dir, "manifest.json");
  const attestationPath = join(dir, "attestation.json");
  const signaturePath = join(dir, "manifest.sig");

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, "artifact", "utf8");
  const policy = minimalPolicy({
    artifactPathGlob: `${artifactDir}/**`,
    manifestPath,
    attestationPath,
    signaturePath
  });
  await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

  await withEnv(
    {
      AUTOPILOT_POLICY_PATH: policyPath,
      AUTOPILOT_SIGNING_PRIVATE_KEY_PEM: undefined,
      AUTOPILOT_SIGNING_PUBLIC_KEY_PEM: undefined
    },
    async () => {
      await generateProvenanceBundle();
      const result = await verifyProvenanceBundle({ requireSignature: true });
      assert.equal(result.ok, false);
      assert.equal(
        result.reasons.some((reason) => reason.includes("AUTOPILOT_SIGNING_PUBLIC_KEY_PEM")),
        true
      );
    }
  );
});

test("verifyProvenanceBundle enforces signature requirement from AUTOPILOT_PROVENANCE_REQUIRE_SIGNATURE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autopilot-provenance-"));
  const artifactDir = join(dir, "artifacts");
  const artifactPath = join(artifactDir, "bundle.txt");
  const policyPath = join(dir, "policy.json");
  const manifestPath = join(dir, "manifest.json");
  const attestationPath = join(dir, "attestation.json");
  const signaturePath = join(dir, "manifest.sig");

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, "artifact", "utf8");
  const policy = minimalPolicy({
    artifactPathGlob: `${artifactDir}/**`,
    manifestPath,
    attestationPath,
    signaturePath
  });
  await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf8");

  await withEnv(
    {
      AUTOPILOT_POLICY_PATH: policyPath,
      AUTOPILOT_PROVENANCE_REQUIRE_SIGNATURE: "true",
      AUTOPILOT_SIGNING_PRIVATE_KEY_PEM: undefined,
      AUTOPILOT_SIGNING_PUBLIC_KEY_PEM: undefined
    },
    async () => {
      await generateProvenanceBundle();
      const result = await verifyProvenanceBundle();
      assert.equal(result.ok, false);
      assert.equal(
        result.reasons.some((reason) => reason.includes("AUTOPILOT_SIGNING_PUBLIC_KEY_PEM")),
        true
      );
    }
  );
});
