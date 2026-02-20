import { repoPath } from "../common";

export function resolveChampionStatePath(): string {
  return process.env.AUTOPILOT_CHAMPION_STATE_PATH?.trim() || repoPath("apps/watcher/data/champions/state.json");
}

export function resolveChampionProvenanceDir(): string {
  return (
    process.env.AUTOPILOT_CHAMPION_PROVENANCE_DIR?.trim() ||
    repoPath("apps/watcher/data/champions/provenance")
  );
}
