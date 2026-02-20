import { createHash } from "node:crypto";
import { join } from "node:path";
import { stableStringify, writeJson } from "../common";
import { resolveChampionProvenanceDir } from "./paths";
import type { ChampionCandidate, ChampionEvaluation, ChampionRunInput } from "./types";

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeChampionProvenanceRecord(
  candidate: ChampionCandidate,
  evaluation: ChampionEvaluation,
  input: ChampionRunInput
): Promise<{ provenancePath: string; provenanceHash: string }> {
  const payload = {
    schemaVersion: 1,
    candidate,
    evaluation,
    replay: {
      baselinePath: input.replay.baselinePath,
      candidatePath: input.replay.candidatePath,
      candidateSource: input.replay.candidateSource,
      simulationOnly: input.replay.simulationOnly,
      ok: input.replay.ok,
      checks: input.replay.checks,
      generatedAt: input.replay.generatedAt
    },
    verification: input.verification
      ? {
          ok: input.verification.ok,
          checks: input.verification.checks,
          generatedAt: input.verification.generatedAt
        }
      : null,
    provenanceVerification: input.provenance ?? null,
    build: {
      commitSha: input.commitSha,
      policyVersion: input.policyVersion,
      modelId: input.modelId
    }
  };

  const provenanceHash = `sha256:${hashText(stableStringify(payload))}`;
  const provenancePath = join(resolveChampionProvenanceDir(), `${candidate.candidateId}.json`);
  await writeJson(provenancePath, {
    ...payload,
    provenanceHash
  });

  return {
    provenancePath,
    provenanceHash
  };
}
