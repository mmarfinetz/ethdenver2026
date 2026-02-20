import { readFile } from "node:fs/promises";
import { nowIso, writeJson } from "../common";
import { resolveChampionStatePath } from "./paths";
import type { ChampionScaffoldState } from "./types";

function createDefaultState(): ChampionScaffoldState {
  return {
    updatedAt: nowIso(),
    registryAddress: process.env.AUTOPILOT_CHAMPION_REGISTRY_ADDRESS?.trim() || null,
    currentChampionId: null,
    nextChampionId: 1,
    gateStatus: "pending",
    artifactDigest: null,
    provenanceDigest: null,
    currentChampion: null,
    lineage: []
  };
}

export async function readChampionScaffoldState(
  path = resolveChampionStatePath()
): Promise<ChampionScaffoldState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ChampionScaffoldState;
    return {
      ...parsed,
      registryAddress: process.env.AUTOPILOT_CHAMPION_REGISTRY_ADDRESS?.trim() || parsed.registryAddress || null,
      nextChampionId: parsed.nextChampionId > 0 ? parsed.nextChampionId : 1,
      lineage: Array.isArray(parsed.lineage) ? parsed.lineage : []
    };
  } catch {
    return createDefaultState();
  }
}

export async function writeChampionScaffoldState(
  state: ChampionScaffoldState,
  path = resolveChampionStatePath()
): Promise<void> {
  await writeJson(path, {
    ...state,
    updatedAt: nowIso(),
    registryAddress: process.env.AUTOPILOT_CHAMPION_REGISTRY_ADDRESS?.trim() || state.registryAddress || null
  });
}
