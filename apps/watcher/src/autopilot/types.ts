export type PolicyPathSet = {
  paths: string[];
};

export type PolicyForbidden = {
  paths: string[];
  symbols: string[];
};

export type PolicyLimits = {
  max_files_changed: number;
  max_added_lines: number;
  max_deleted_lines: number;
};

export type PolicyRisk = {
  timelock_hours: number;
  timelock_required_if: string[];
};

export type PolicyVerification = {
  required_commands: string[];
  replay_requirements: {
    candidate_must_not_increase_hf_breach_count: boolean;
    candidate_must_not_increase_failure_count: boolean;
    candidate_must_not_increase_runway_collapse_count: boolean;
    candidate_must_preserve_or_improve_success_rate: boolean;
    candidate_must_preserve_or_improve_net_delta: boolean;
  };
};

export type PolicyDeployment = {
  shadow_canary_cycles: number;
  live_canary_min_runs: number;
  max_consecutive_failures: number;
  max_error_rate_regression_pct: number;
  hf_floor_wad: string;
  rollback_triggers: string[];
};

export type PolicyProvenance = {
  artifact_paths: string[];
  manifest_path: string;
  attestation_path: string;
  signature_path: string;
};

export type PolicyOverrideControls = {
  emergency_stop_env: string;
  approval_mode_env: string;
  timelock_env: string;
  approval_file_env: string;
};

export type RolloutPhase = {
  phase: number;
  name: string;
  capabilities: string[];
  exit_criteria: string[];
};

export type PolicyRollout = {
  phases: RolloutPhase[];
  trust_model: string[];
};

export type AutonomyPolicy = {
  version: number;
  mode: {
    default_phase: number;
    require_human_approval_default: boolean;
    allow_direct_main_push: boolean;
  };
  allowed: PolicyPathSet;
  forbidden: PolicyForbidden;
  limits: PolicyLimits;
  risk: PolicyRisk;
  verification: PolicyVerification;
  deployment: PolicyDeployment;
  provenance: PolicyProvenance;
  override_controls: PolicyOverrideControls;
  rollout: PolicyRollout;
};

export type DiffFileStats = {
  path: string;
  added: number;
  deleted: number;
  patch: string;
};

export type DiffSummary = {
  files: DiffFileStats[];
  added: number;
  deleted: number;
};

export type PolicyGateResult = {
  ok: boolean;
  filesChanged: number;
  addedLines: number;
  deletedLines: number;
  requiresHumanApproval: boolean;
  requiresTimelock: boolean;
  highRiskReasons: string[];
  violations: string[];
  warnings: string[];
};

export type RunAggregate = {
  totalRuns: number;
  okRuns: number;
  errorRuns: number;
  skippedRuns: number;
  dryRunCount: number;
  liveRunCount: number;
  successRate: number;
  errorRate: number;
  minHealthFactorWad: bigint | null;
  hfBreachCount: number;
  runwayDeadCount: number;
  netDeltaUsdSum: bigint;
  consecutiveFailures: number;
  latestTimestamp: string | null;
};

export type ParameterProposal = {
  key: string;
  current: string;
  proposed: string;
  reason: string;
};

export type ProposalArtifact = {
  proposalId: string;
  createdAt: string;
  phase: number;
  summary: string;
  proposals: ParameterProposal[];
  sourceMetrics: RunAggregate;
};

export type ReplayReport = {
  baselinePath: string;
  candidatePath: string;
  candidateSource: "provided_run_log" | "simulated_isolated_log" | "command_generated_log";
  simulationOnly: boolean;
  baseline: RunAggregate;
  candidate: RunAggregate;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
  ok: boolean;
  generatedAt: string;
};

export type VerificationCheck = {
  command: string;
  ok: boolean;
  output: string;
};

export type VerificationReport = {
  replayOk: boolean;
  checks: VerificationCheck[];
  ok: boolean;
  generatedAt: string;
};

export type DeploymentStage = "shadow_canary" | "live_canary" | "promoted" | "rolled_back";

export type DeploymentAction = "hold" | "promote" | "rollback";

export type DeploymentExecution = {
  name: string;
  command: string;
  ok: boolean;
  output: string;
};

export type DeploymentDecision = {
  stage: DeploymentStage;
  action: DeploymentAction;
  reasons: string[];
  metrics: RunAggregate;
  baseline: RunAggregate;
  executions: DeploymentExecution[];
  generatedAt: string;
};

export type ProvenanceManifestFile = {
  path: string;
  digest: string;
  size: number;
};

export type ProvenanceManifest = {
  schemaVersion: number;
  artifactName: string;
  artifactDigest: string;
  files: ProvenanceManifestFile[];
  commitSha: string;
  lockfileDigest: string;
  buildTimestamp: string;
  policyVersion: string;
  modelId: string;
};

export type ProvenanceAttestation = {
  schemaVersion: number;
  predicateType: string;
  subjectDigest: string;
  predicate: {
    commitSha: string;
    policyVersion: string;
    modelId: string;
    generatedAt: string;
  };
};

export type ProvenanceSignature = {
  algorithm: "ed25519";
  keyId: string;
  signatureBase64: string;
};

export type ApprovalRecord = {
  approved: boolean;
  approvedBy: string;
  approvedAt: string;
  proposalId?: string;
  expiresAt?: string;
};

export type AutopilotState = {
  timestamp: string;
  phase: number;
  stage: DeploymentStage;
  emergencyStop: boolean;
  requireHumanApproval: boolean;
  requiresTimelock: boolean;
  lastPolicyGate?: PolicyGateResult;
  lastReplay?: ReplayReport;
  lastVerification?: VerificationReport;
  lastDeployment?: DeploymentDecision;
  lastProposal?: ProposalArtifact;
  provenance?: {
    commitSha: string;
    policyVersion: string;
    modelId: string;
    artifactDigest?: string;
  };
};
