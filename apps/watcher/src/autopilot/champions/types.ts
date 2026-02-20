import type { ReplayReport, VerificationReport } from "../types";

export type ChampionGateStatus = "pending" | "pass" | "fail" | "simulation-only";

export type ChampionCandidate = {
  candidateId: string;
  proposalId: string | null;
  parentChampionId: number | null;
  submitterAddress: string | null;
  replaySource: ReplayReport["candidateSource"];
  simulationOnly: boolean;
  candidateHash: string;
  lineageHash: string;
  createdAt: string;
};

export type ChampionEvaluation = {
  candidateId: string;
  replayOk: boolean;
  verificationOk: boolean | null;
  provenanceOk: boolean | null;
  gateStatus: ChampionGateStatus;
  reasons: string[];
  gateHash: string;
  evaluatedAt: string;
};

export type ChampionLineageEntry = ChampionCandidate &
  ChampionEvaluation & {
    championId: number | null;
    parentChampionId: number | null;
    provenanceHash: string;
    provenancePath: string;
    promoted: boolean;
  };

export type ChampionScaffoldState = {
  updatedAt: string;
  registryAddress: string | null;
  currentChampionId: number | null;
  nextChampionId: number;
  gateStatus: ChampionGateStatus;
  artifactDigest: string | null;
  provenanceDigest: string | null;
  currentChampion: ChampionLineageEntry | null;
  lineage: ChampionLineageEntry[];
};

export type ChampionRunInput = {
  proposalId?: string;
  replay: ReplayReport;
  verification?: VerificationReport;
  provenance?: {
    ok: boolean;
    reasons: string[];
  };
  commitSha: string;
  policyVersion: string;
  modelId: string;
};
