import { createHash } from "node:crypto";
import { nowIso, stableStringify } from "../common";
import type { ChampionCandidate, ChampionRunInput } from "./types";

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function breedChampionCandidate(
  input: ChampionRunInput,
  parentChampionId: number | null
): ChampionCandidate {
  const seed = {
    proposalId: input.proposalId ?? null,
    parentChampionId,
    submitterAddress:
      process.env.AUTOPILOT_CHAMPION_SUBMITTER_ADDRESS?.trim() ||
      process.env.AUTOPILOT_CHAMPION_OPERATOR_ADDRESS?.trim() ||
      null,
    replaySource: input.replay.candidateSource,
    replaySimulationOnly: input.replay.simulationOnly,
    replayBaselinePath: input.replay.baselinePath,
    replayCandidatePath: input.replay.candidatePath,
    replayGeneratedAt: input.replay.generatedAt,
    commitSha: input.commitSha,
    policyVersion: input.policyVersion,
    modelId: input.modelId
  };
  const candidateHash = `sha256:${hashText(stableStringify(seed))}`;
  const lineageHash = `sha256:${hashText(`${parentChampionId ?? 0}:${candidateHash}`)}`;
  const createdAt = nowIso();
  const candidateId = `${createdAt.slice(0, 19).replace(/[^0-9]/g, "")}-${candidateHash.slice(7, 15)}`;

  return {
    candidateId,
    proposalId: input.proposalId ?? null,
    parentChampionId,
    submitterAddress:
      process.env.AUTOPILOT_CHAMPION_SUBMITTER_ADDRESS?.trim() ||
      process.env.AUTOPILOT_CHAMPION_OPERATOR_ADDRESS?.trim() ||
      null,
    replaySource: input.replay.candidateSource,
    simulationOnly: input.replay.simulationOnly,
    candidateHash,
    lineageHash,
    createdAt
  };
}
