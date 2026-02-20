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

rpc_url="${BASE_SEPOLIA_RPC_URL:-${BASE_RPC_URL:-}}"
private_key="${DEPLOYER_PRIVATE_KEY:-}"
lineage_root="${CHAMPION_LINEAGE_ARCHIVE_ROOT:-}"
provenance_root="${CHAMPION_PROVENANCE_ARCHIVE_ROOT:-}"
owner="${CHAMPION_REGISTRY_OWNER:-}"

if [[ -z "$rpc_url" ]]; then
  echo "[e2e] BASE_SEPOLIA_RPC_URL or BASE_RPC_URL is required" >&2
  exit 1
fi
if [[ -z "$private_key" ]]; then
  echo "[e2e] DEPLOYER_PRIVATE_KEY is required" >&2
  exit 1
fi
if [[ -z "$lineage_root" || -z "$provenance_root" ]]; then
  echo "[e2e] CHAMPION_LINEAGE_ARCHIVE_ROOT and CHAMPION_PROVENANCE_ARCHIVE_ROOT are required" >&2
  exit 1
fi
if [[ -z "$owner" ]]; then
  owner="$(cast wallet address --private-key "$private_key")"
fi

report_dir="${E2E_REPORT_DIR:-autonomy/reports/e2e/base-sepolia}"
mkdir -p "$report_dir"

echo "[e2e] deploying ChampionRegistry to Base Sepolia..."
deploy_output="$(
  forge create contracts/src/ChampionRegistry.sol:ChampionRegistry \
    --rpc-url "$rpc_url" \
    --private-key "$private_key" \
    --constructor-args "$owner" "$lineage_root" "$provenance_root" \
    2>&1
)"
echo "$deploy_output"

registry_address="$(printf "%s\n" "$deploy_output" | awk '/Deployed to:/ {print $3}' | tail -n 1)"
if [[ -z "$registry_address" ]]; then
  echo "[e2e] failed to parse deployed ChampionRegistry address" >&2
  exit 1
fi

registry_env_path="$report_dir/champion-registry.env"
registry_json_path="$report_dir/champion-registry.json"

cat >"$registry_env_path" <<EOF
AUTOPILOT_CHAMPION_REGISTRY_ADDRESS=$registry_address
CHAMPION_REGISTRY_OWNER=$owner
BASE_SEPOLIA_RPC_URL=$rpc_url
EOF

cat >"$registry_json_path" <<EOF
{
  "network": "base-sepolia",
  "chainId": 84532,
  "registryAddress": "$registry_address",
  "owner": "$owner",
  "lineageArchiveRoot": "$lineage_root",
  "provenanceArchiveRoot": "$provenance_root"
}
EOF

echo "[e2e] ChampionRegistry deployed: $registry_address"
echo "[e2e] wrote $registry_env_path"
echo "[e2e] wrote $registry_json_path"
