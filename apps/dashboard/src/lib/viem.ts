import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  CHAIN_DEFAULTS,
  USDC_DECIMALS
} from "@ssa/shared/constants";
import { mustEnv, parseAddress, parseInteger } from "@ssa/shared/utils";
import type { Address, Chain } from "viem";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

export type DashboardConfig = {
  chainId: number;
  rpcUrl: string;
  smartAccountAddress: Address;
  entryPointAddress: Address;
  aavePoolAddress: Address;
  wethAddress: Address;
  wstEthAddress: Address;
  usdcAddress: Address;
  usdcDecimals: number;
  escrowAddress: Address;
  runLogPath: string;
  explorerTxUrl: string;
  escrowPaymentsFromBlock?: bigint;
  userOpsWindowBlocks: bigint;
  autopilotStatePath: string;
  championStatePath: string;
  autonomyPolicyPath: string;
  championRegistryAddress?: Address;
};

function resolveChain(chainId: number): Chain {
  if (chainId === BASE_MAINNET_CHAIN_ID) return base;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return baseSepolia;

  return {
    ...base,
    id: chainId,
    name: `Base-like ${chainId}`,
    rpcUrls: {
      default: {
        http: [""]
      },
      public: {
        http: [""]
      }
    }
  } as Chain;
}

export function getDashboardConfig(): DashboardConfig {
  const chainId = parseInteger(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(BASE_MAINNET_CHAIN_ID), "NEXT_PUBLIC_CHAIN_ID");
  const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[BASE_MAINNET_CHAIN_ID];

  const rpcUrl = process.env.BASE_RPC_URL?.trim() || process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("Set BASE_RPC_URL or NEXT_PUBLIC_BASE_RPC_URL for dashboard onchain reads");

  const usdcDecimals = parseInteger(
    process.env.NEXT_PUBLIC_USDC_DECIMALS ?? String(USDC_DECIMALS),
    "NEXT_PUBLIC_USDC_DECIMALS"
  );
  if (usdcDecimals <= 0 || usdcDecimals > 255) {
    throw new Error(`NEXT_PUBLIC_USDC_DECIMALS must be between 1 and 255, got ${usdcDecimals}`);
  }
  const championRegistryAddress = process.env.NEXT_PUBLIC_CHAMPION_REGISTRY_ADDRESS?.trim();

  return {
    chainId,
    rpcUrl,
    smartAccountAddress: parseAddress(mustEnv("NEXT_PUBLIC_SMART_ACCOUNT_ADDRESS"), "NEXT_PUBLIC_SMART_ACCOUNT_ADDRESS"),
    entryPointAddress: parseAddress(
      process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS?.trim() || defaults.entryPoint07,
      "NEXT_PUBLIC_ENTRYPOINT_ADDRESS"
    ),
    aavePoolAddress: parseAddress(
      process.env.NEXT_PUBLIC_AAVE_POOL_ADDRESS?.trim() || defaults.aavePool,
      "NEXT_PUBLIC_AAVE_POOL_ADDRESS"
    ),
    wethAddress: parseAddress(
      process.env.NEXT_PUBLIC_WETH_ADDRESS?.trim() || defaults.weth,
      "NEXT_PUBLIC_WETH_ADDRESS"
    ),
    wstEthAddress: parseAddress(
      process.env.NEXT_PUBLIC_WSTETH_ADDRESS?.trim() || defaults.wstEth,
      "NEXT_PUBLIC_WSTETH_ADDRESS"
    ),
    usdcAddress: parseAddress(
      process.env.NEXT_PUBLIC_USDC_ADDRESS?.trim() || defaults.usdc,
      "NEXT_PUBLIC_USDC_ADDRESS"
    ),
    usdcDecimals,
    escrowAddress: parseAddress(mustEnv("NEXT_PUBLIC_ESCROW_ADDRESS"), "NEXT_PUBLIC_ESCROW_ADDRESS"),
    runLogPath: process.env.RUN_LOG_PATH?.trim() || "../agent/data/runs.ndjson",
    explorerTxUrl: process.env.NEXT_PUBLIC_EXPLORER_TX_URL?.trim() || defaults.explorerTxUrl,
    escrowPaymentsFromBlock: process.env.ESCROW_PAYMENTS_FROM_BLOCK?.trim()
      ? BigInt(process.env.ESCROW_PAYMENTS_FROM_BLOCK.trim())
      : undefined,
    userOpsWindowBlocks: BigInt(process.env.USEROPS_WINDOW_BLOCKS?.trim() || "200000"),
    autopilotStatePath: process.env.AUTOPILOT_STATE_PATH?.trim() || "../watcher/data/autopilot-state.json",
    championStatePath: process.env.AUTOPILOT_CHAMPION_STATE_PATH?.trim() || "../watcher/data/champions/state.json",
    autonomyPolicyPath: process.env.AUTONOMY_POLICY_PATH?.trim() || "../../autonomy/policy.yaml",
    championRegistryAddress: championRegistryAddress
      ? parseAddress(championRegistryAddress, "NEXT_PUBLIC_CHAMPION_REGISTRY_ADDRESS")
      : undefined
  };
}

export function createDashboardPublicClient(config: DashboardConfig) {
  return createPublicClient({
    chain: resolveChain(config.chainId),
    transport: http(config.rpcUrl)
  });
}
