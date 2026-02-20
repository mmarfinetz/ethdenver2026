import "dotenv/config";

import { erc20Abi } from "@ssa/shared/abis";
import { BASE_MAINNET_CHAIN_ID, CHAIN_DEFAULTS, USDC_DECIMALS } from "@ssa/shared/constants";
import {
  assertBaseChain,
  formatToken,
  mustEnv,
  parseAddress,
  parseDecimalToUnits,
  parseInteger
} from "@ssa/shared/utils";
import { exec as execWithCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Address, Chain } from "viem";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

const exec = promisify(execWithCallback);

type WatcherConfig = {
  chainId: number;
  allowTestnet: boolean;
  rpcUrl: string;
  usdcAddress: Address;
  usdcDecimals: number;
  escrowAddress: Address;
  watchIntervalSeconds: number;
  failureThreshold: number;
  minEscrowBalanceUsdc: bigint;
  shutdownCommand: string;
};

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function resolveChain(chainId: number): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return {
    ...base,
    id: chainId,
    name: `Custom Base-like ${chainId}`,
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

function optionalAddress(raw: string | undefined, label: string): Address | undefined {
  if (!raw?.trim()) return undefined;
  return parseAddress(raw.trim(), label);
}

function loadWatcherConfig(): WatcherConfig {
  const chainId = parseInteger(process.env.CHAIN_ID ?? String(BASE_MAINNET_CHAIN_ID), "CHAIN_ID");
  const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[BASE_MAINNET_CHAIN_ID];

  const watchIntervalSeconds = parseInteger(process.env.WATCH_INTERVAL_SECONDS ?? "300", "WATCH_INTERVAL_SECONDS");
  const failureThreshold = parseInteger(process.env.WATCH_FAILURE_THRESHOLD ?? "3", "WATCH_FAILURE_THRESHOLD");
  const usdcDecimals = parseInteger(process.env.USDC_DECIMALS ?? String(USDC_DECIMALS), "USDC_DECIMALS");

  if (watchIntervalSeconds <= 0) {
    throw new Error(`WATCH_INTERVAL_SECONDS must be > 0, got ${watchIntervalSeconds}`);
  }
  if (failureThreshold <= 0) {
    throw new Error(`WATCH_FAILURE_THRESHOLD must be > 0, got ${failureThreshold}`);
  }
  if (usdcDecimals <= 0 || usdcDecimals > 255) {
    throw new Error(`USDC_DECIMALS must be between 1 and 255, got ${usdcDecimals}`);
  }

  return {
    chainId,
    allowTestnet: parseBoolean(process.env.ALLOW_TESTNET, false),
    rpcUrl: mustEnv("BASE_RPC_URL"),
    usdcAddress: optionalAddress(process.env.USDC_ADDRESS, "USDC_ADDRESS") ?? parseAddress(defaults.usdc, "USDC_ADDRESS"),
    usdcDecimals,
    escrowAddress: parseAddress(mustEnv("ESCROW_ADDRESS"), "ESCROW_ADDRESS"),
    watchIntervalSeconds,
    failureThreshold,
    minEscrowBalanceUsdc: parseDecimalToUnits(
      process.env.ESCROW_MIN_BALANCE_USDC ?? "0",
      usdcDecimals,
      "ESCROW_MIN_BALANCE_USDC"
    ),
    shutdownCommand: process.env.SHUTDOWN_COMMAND?.trim() || "systemctl stop ssa-agent"
  };
}

async function triggerShutdown(command: string): Promise<void> {
  console.error(`[watcher] triggering shutdown: ${command}`);
  try {
    const { stdout, stderr } = await exec(command);
    if (stdout.trim()) console.error(`[watcher] shutdown stdout: ${stdout.trim()}`);
    if (stderr.trim()) console.error(`[watcher] shutdown stderr: ${stderr.trim()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[watcher] shutdown command failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadWatcherConfig();
  assertBaseChain(config.chainId, config.allowTestnet);

  const client = createPublicClient({
    chain: resolveChain(config.chainId),
    transport: http(config.rpcUrl)
  });

  const rpcChainId = await client.getChainId();
  if (rpcChainId !== config.chainId) {
    throw new Error(`RPC chainId mismatch. expected=${config.chainId}, got=${rpcChainId}`);
  }

  let consecutiveLowReadings = 0;

  console.log(
    `[watcher] chainId=${config.chainId} escrow=${config.escrowAddress} interval=${config.watchIntervalSeconds}s threshold=${config.failureThreshold}`
  );

  const tick = async () => {
    try {
      const escrowBalanceUsdc = await client.readContract({
        abi: erc20Abi,
        address: config.usdcAddress,
        functionName: "balanceOf",
        args: [config.escrowAddress]
      });

      const belowThreshold = escrowBalanceUsdc <= config.minEscrowBalanceUsdc;

      if (belowThreshold) {
        consecutiveLowReadings += 1;
      } else {
        consecutiveLowReadings = 0;
      }

      console.log(
        `[watcher] escrow=${formatToken(escrowBalanceUsdc, config.usdcDecimals)} usdc min=${formatToken(config.minEscrowBalanceUsdc, config.usdcDecimals)} usdc consecutive=${consecutiveLowReadings}/${config.failureThreshold}`
      );

      if (consecutiveLowReadings >= config.failureThreshold) {
        await triggerShutdown(config.shutdownCommand);
        process.exit(0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[watcher] balance read failed: ${message}`);
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, config.watchIntervalSeconds * 1000);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[watcher:fatal]", message);
  process.exit(1);
});
