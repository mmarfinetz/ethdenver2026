import { createHash } from "node:crypto";
import { nowIso, stableStringify } from "../common";
import type { ChampionCandidate, ChampionEvaluation, ChampionRunInput } from "./types";

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evaluateChampionCandidate(
  candidate: ChampionCandidate,
  input: ChampionRunInput
): ChampionEvaluation {
  const reasons: string[] = [];
  const replayOk = input.replay.ok;
  const verificationOk = typeof input.verification?.ok === "boolean" ? input.verification.ok : null;
  const provenanceOk = typeof input.provenance?.ok === "boolean" ? input.provenance.ok : null;

  let gateStatus: ChampionEvaluation["gateStatus"] = "pending";
  if (candidate.simulationOnly) {
    gateStatus = "simulation-only";
    reasons.push("Candidate comes from simulation-only replay fallback and is not promotable");
  } else if (!replayOk) {
    gateStatus = "fail";
    reasons.push("Replay checks failed");
  } else if (verificationOk === false) {
    gateStatus = "fail";
    reasons.push("Verification checks failed");
  } else if (provenanceOk === false) {
    gateStatus = "fail";
    reasons.push("Provenance verification failed");
  } else if (verificationOk === true && provenanceOk === true) {
    gateStatus = "pass";
    reasons.push("Replay, verification, and provenance checks passed");
  } else {
    gateStatus = "pending";
    reasons.push("Awaiting full verification/provenance evidence before promotion");
  }

  const evaluatedAt = nowIso();
  const gateHash = `sha256:${hashText(
    stableStringify({
      candidateId: candidate.candidateId,
      gateStatus,
      replayOk,
      verificationOk,
      provenanceOk,
      reasons
    })
  )}`;

  return {
    candidateId: candidate.candidateId,
    replayOk,
    verificationOk,
    provenanceOk,
    gateStatus,
    reasons,
    gateHash,
    evaluatedAt
  };
}
