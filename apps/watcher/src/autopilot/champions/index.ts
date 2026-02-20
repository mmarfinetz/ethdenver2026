import { breedChampionCandidate } from "./breed";
import { evaluateChampionCandidate } from "./evaluate";
import { readChampionScaffoldState, writeChampionScaffoldState } from "./state";
import { writeChampionProvenanceRecord } from "./provenance";
import type { ChampionLineageEntry, ChampionRunInput, ChampionScaffoldState } from "./types";

export async function recordChampionScaffoldRun(
  input: ChampionRunInput
): Promise<ChampionScaffoldState> {
  const previous = await readChampionScaffoldState();
  const candidate = breedChampionCandidate(input, previous.currentChampionId);
  const evaluation = evaluateChampionCandidate(candidate, input);
  const { provenancePath, provenanceHash } = await writeChampionProvenanceRecord(candidate, evaluation, input);

  const promoted = evaluation.gateStatus === "pass";
  const championId = promoted ? previous.nextChampionId : null;

  const lineageEntry: ChampionLineageEntry = {
    ...candidate,
    ...evaluation,
    championId,
    parentChampionId: candidate.parentChampionId,
    provenanceHash,
    provenancePath,
    promoted
  };

  const nextLineage = [...previous.lineage, lineageEntry].slice(-200);
  const nextCurrentChampionId = promoted && championId != null ? championId : previous.currentChampionId;
  const nextCurrentChampion = promoted ? lineageEntry : previous.currentChampion;
  const nextState: ChampionScaffoldState = {
    ...previous,
    registryAddress: process.env.AUTOPILOT_CHAMPION_REGISTRY_ADDRESS?.trim() || previous.registryAddress || null,
    currentChampionId: nextCurrentChampionId,
    nextChampionId: promoted && championId != null ? championId + 1 : previous.nextChampionId,
    gateStatus: evaluation.gateStatus,
    artifactDigest: candidate.candidateHash,
    provenanceDigest: provenanceHash,
    currentChampion: nextCurrentChampion,
    lineage: nextLineage
  };

  await writeChampionScaffoldState(nextState);
  return nextState;
}

export * from "./paths";
export * from "./types";
