#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f "${E2E_ENV_FILE:-scripts/e2e/base-sepolia/e2e.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${E2E_ENV_FILE:-scripts/e2e/base-sepolia/e2e.env}"
  set +a
fi

report_dir="${E2E_REPORT_DIR:-autonomy/reports/e2e/base-sepolia}"
registry_env_path="$report_dir/champion-registry.env"
if [[ -f "$registry_env_path" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$registry_env_path"
  set +a
fi

rpc_url="${BASE_SEPOLIA_RPC_URL:-${BASE_RPC_URL:-}}"
private_key="${DEPLOYER_PRIVATE_KEY:-}"
registry_address="${AUTOPILOT_CHAMPION_REGISTRY_ADDRESS:-}"
state_path="${AUTOPILOT_CHAMPION_STATE_PATH:-apps/watcher/data/champions/state.json}"

if [[ -z "$rpc_url" ]]; then
  echo "[e2e] BASE_SEPOLIA_RPC_URL or BASE_RPC_URL is required" >&2
  exit 1
fi
if [[ -z "$private_key" ]]; then
  echo "[e2e] DEPLOYER_PRIVATE_KEY is required" >&2
  exit 1
fi
if [[ -z "$registry_address" ]]; then
  echo "[e2e] AUTOPILOT_CHAMPION_REGISTRY_ADDRESS is required" >&2
  exit 1
fi
if [[ ! -f "$state_path" ]]; then
  echo "[e2e] champion state file not found: $state_path" >&2
  exit 1
fi

to_bytes32() {
  local raw="$1"
  if [[ "$raw" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "$raw"
    return 0
  fi
  if [[ "$raw" =~ ^sha256:([0-9a-fA-F]{64})$ ]]; then
    echo "0x${BASH_REMATCH[1]}"
    return 0
  fi
  echo "[e2e] invalid hash format: $raw" >&2
  return 1
}

readarray -t champ_fields < <(
  node --input-type=module - "$state_path" <<'NODE'
import { readFileSync } from "node:fs";

const statePath = process.argv[2];
const state = JSON.parse(readFileSync(statePath, "utf8"));
const entry = state.currentChampion ?? (Array.isArray(state.lineage) ? state.lineage.at(-1) : null);
if (!entry) {
  process.stderr.write("[e2e] no champion lineage entry found\n");
  process.exit(2);
}

const parentChampionId = Number.isInteger(entry.parentChampionId) ? entry.parentChampionId : 0;
const lineageHash = String(entry.lineageHash ?? "");
const candidateHash = String(entry.candidateHash ?? "");
const provenanceHash = String(entry.provenanceHash ?? "");
const gateHash = String(entry.gateHash ?? "");
const promote = entry.promoted === true ? "true" : "false";

process.stdout.write(`${parentChampionId}\n`);
process.stdout.write(`${lineageHash}\n`);
process.stdout.write(`${candidateHash}\n`);
process.stdout.write(`${provenanceHash}\n`);
process.stdout.write(`${gateHash}\n`);
process.stdout.write(`${promote}\n`);
NODE
)

if [[ "${#champ_fields[@]}" -ne 6 ]]; then
  echo "[e2e] unable to parse champion fields from $state_path" >&2
  exit 1
fi

parent_id="${champ_fields[0]}"
lineage_hash="$(to_bytes32 "${champ_fields[1]}")"
candidate_hash="$(to_bytes32 "${champ_fields[2]}")"
provenance_hash="$(to_bytes32 "${champ_fields[3]}")"
gate_hash="$(to_bytes32 "${champ_fields[4]}")"
promote="${champ_fields[5]}"

echo "[e2e] submitting latest champion lineage to registry $registry_address"
cast send "$registry_address" \
  "registerChampion(uint256,bytes32,bytes32,bytes32,bytes32,bool)" \
  "$parent_id" \
  "$lineage_hash" \
  "$candidate_hash" \
  "$provenance_hash" \
  "$gate_hash" \
  "$promote" \
  --private-key "$private_key" \
  --rpc-url "$rpc_url"

champion_count="$(cast call "$registry_address" "championCount()(uint256)" --rpc-url "$rpc_url")"
current_champion="$(cast call "$registry_address" "currentChampionId()(uint256)" --rpc-url "$rpc_url")"

echo "[e2e] registry championCount=$champion_count currentChampionId=$current_champion"
