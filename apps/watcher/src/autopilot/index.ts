import "dotenv/config";

import { recordChampionScaffoldRun } from "./champions";
import { collectRunMetrics } from "./collector";
import { assertHumanControls, loadControls } from "./controls";
import { runDeploymentController } from "./deploy";
import { proposeParameterChanges } from "./heuristics";
import { createProposalArtifact } from "./patcher";
import { hasCapability, getCurrentPhase, loadPolicy } from "./policy";
import { runPolicyGate } from "./policyGate";
import { createPrDraft } from "./pr";
import { verifyProvenanceBundle } from "./provenance";
import { runReplay } from "./replay";
import { readAutopilotState, writeAutopilotState } from "./state";
import { runVerification } from "./verifier";

async function runAutopilot(): Promise<void> {
  const policy = await loadPolicy();
  const phase = getCurrentPhase(policy);
  const controls = loadControls(policy);

  if (!hasCapability(policy, "proposal")) {
    throw new Error(`Rollout phase ${phase.phase} has no proposal capability`);
  }

  const baselineState = await readAutopilotState();
  if (controls.emergencyStop) {
    await writeAutopilotState(
      {
        lastPolicyGate: undefined
      },
      {
        phase: phase.phase,
        stage: baselineState?.stage ?? "shadow_canary",
        emergencyStop: true,
        requireHumanApproval: controls.requireHumanApproval,
        requiresTimelock: false
      }
    );
    console.error("[autopilot] emergency stop enabled; skipping cycle");
    return;
  }

  const hfFloorWad = BigInt(policy.deployment.hf_floor_wad);
  const metrics = await collectRunMetrics({ hfFloorWad });
  const proposals = await proposeParameterChanges(metrics);

  const proposal = await createProposalArtifact({
    phase: phase.phase,
    metrics,
    proposals,
    summary:
      proposals.length === 0
        ? "No tunable parameter deltas met heuristic thresholds"
        : `Generated ${proposals.length} parameter update suggestions`
  });

  const gate = await runPolicyGate();
  if (!gate.ok) {
    throw new Error(`Policy gate failed: ${gate.violations.join("; ")}`);
  }
  await assertHumanControls({
    controls,
    gate,
    proposalId: proposal?.proposalId
  });

  if (proposal) {
    await createPrDraft(proposal);
  }

  const replay = await runReplay();
  if (!replay.ok) {
    throw new Error("Replay gate failed; refusing to proceed");
  }

  const hasDeployCapability = hasCapability(policy, "deploy_canary") || hasCapability(policy, "promote_production");
  const shouldRunVerification = hasDeployCapability || process.env.AUTOPILOT_RUN_VERIFICATION?.trim() === "true";
  const verification = shouldRunVerification ? await runVerification() : undefined;
  if (verification && !verification.ok) {
    throw new Error("Verification gate failed; refusing to proceed");
  }

  const shouldVerifyProvenance = hasDeployCapability || process.env.AUTOPILOT_VERIFY_PROVENANCE?.trim() === "true";
  const provenanceResult = shouldVerifyProvenance
    ? await verifyProvenanceBundle({ requireSignature: hasDeployCapability })
    : undefined;
  if (provenanceResult && !provenanceResult.ok) {
    throw new Error(`Provenance verification failed: ${provenanceResult.reasons.join("; ")}`);
  }

  const deployment = hasDeployCapability ? await runDeploymentController() : undefined;
  const commitSha = process.env.AUTOPILOT_COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || "unknown";
  const policyVersion = process.env.AUTOPILOT_POLICY_VERSION?.trim() || String(policy.version);
  const modelId = process.env.AUTOPILOT_MODEL_ID?.trim() || "unspecified";

  let championGateStatus = "skipped";
  try {
    const championState = await recordChampionScaffoldRun({
      proposalId: proposal?.proposalId,
      replay,
      verification,
      provenance: provenanceResult,
      commitSha,
      policyVersion,
      modelId
    });
    championGateStatus = championState.gateStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[autopilot:champions] failed to write scaffold state: ${message}`);
  }

  await writeAutopilotState(
    {
      phase: phase.phase,
      stage: deployment?.stage ?? baselineState?.stage ?? "shadow_canary",
      emergencyStop: controls.emergencyStop,
      requireHumanApproval: controls.requireHumanApproval,
      requiresTimelock: gate.requiresTimelock,
      lastPolicyGate: gate,
      lastReplay: replay,
      lastVerification: verification,
      lastDeployment: deployment,
      lastProposal: proposal ?? undefined,
      provenance: {
        commitSha,
        policyVersion,
        modelId
      }
    },
    {
      phase: phase.phase,
      stage: deployment?.stage ?? baselineState?.stage ?? "shadow_canary",
      emergencyStop: controls.emergencyStop,
      requireHumanApproval: controls.requireHumanApproval,
      requiresTimelock: gate.requiresTimelock
    }
  );

  console.log(
    `[autopilot] phase=${phase.phase} proposal=${proposal?.proposalId ?? "none"} gate=${gate.ok} replay=${replay.ok} verify=${verification?.ok ?? "skipped"} provenance=${provenanceResult?.ok ?? "skipped"} deploy=${deployment?.action ?? "skipped"} championGate=${championGateStatus}`
  );
}

runAutopilot().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[autopilot:fatal] ${message}`);

  try {
    const policy = await loadPolicy();
    const phase = getCurrentPhase(policy);
    const controls = loadControls(policy);
    await writeAutopilotState(
      {},
      {
        phase: phase.phase,
        stage: "rolled_back",
        emergencyStop: controls.emergencyStop,
        requireHumanApproval: controls.requireHumanApproval,
        requiresTimelock: true
      }
    );
  } catch {
    // ignore fallback state write errors
  }
  process.exit(1);
});
