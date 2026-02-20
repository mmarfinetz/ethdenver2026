import "dotenv/config";

import {
  BASE_MAINNET_CHAIN_ID,
  CHAIN_DEFAULTS,
  BPS_DENOMINATOR,
  USDC_DECIMALS,
  WAD,
  WSTETH_DECIMALS,
  WETH_DECIMALS
} from "@ssa/shared/constants";
import {
  mustEnv,
  optionalEnv,
  parseAddress,
  parseDecimalToUnits,
  parseFloatToWad,
  parseInteger,
  parseSalt
} from "@ssa/shared/utils";
import type { Address, Hex } from "viem";

export type AgentConfig = {
  chainId: number;
  dryRun: boolean;
  allowTestnet: boolean;
  baseRpcUrl: string;
  bundlerRpcUrl: string;
  paymasterRpcUrl?: string;
  entryPointAddress: Address;
  entryPointVersion: "0.7";
  factoryAddress: Address;
  ownerPrivateKey: Hex;
  smartAccountSalt: bigint;
  builderCode: string;
  hfTargetWad: bigint;
  hfBufferWad: bigint;
  maxLoops: number;
  loopBorrowBps: number;
  runIntervalSeconds: number;
  escrowAddress: Address;
  monthlyServerCostUsdc: bigint;
  computeBufferBps: number;
  runwayNominalDays: number;
  runwayElevatedDays: number;
  runwayDeadDays: number;
  maxHarvestEquityBps: number;
  slippageBps: number;
  wstEthAddress: Address;
  wethAddress: Address;
  usdcAddress: Address;
  aavePoolAddress: Address;
  dexRouterAddress: Address;
  zrxApiUrl: string;
  zrxApiKey?: string;
  runLogPath: string;
  snapshotPath: string;
  swapCostUsdEstimate: bigint;
  expectedDecimals: {
    usdc: number;
    weth: number;
    wstEth: number;
  };
};

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function optionalAddress(raw: string | undefined, label: string): Address | undefined {
  if (!raw?.trim()) return undefined;
  return parseAddress(raw.trim(), label);
}

export function loadConfig(): AgentConfig {
  const chainId = parseInteger(process.env.CHAIN_ID ?? String(BASE_MAINNET_CHAIN_ID), "CHAIN_ID");
  const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[BASE_MAINNET_CHAIN_ID];

  const dryRun = parseBoolean(process.env.DRY_RUN, false);
  const allowTestnet = parseBoolean(process.env.ALLOW_TESTNET, false);
  const hfTargetWad = parseFloatToWad(process.env.HF_TARGET ?? "1.6", "HF_TARGET");
  const hfBufferWad = parseFloatToWad(process.env.HF_BUFFER ?? "0.1", "HF_BUFFER");
  const slippageBps = parseInteger(process.env.SLIPPAGE_BPS ?? "100", "SLIPPAGE_BPS");
  const loopBorrowBps = parseInteger(process.env.LOOP_BORROW_BPS ?? "3500", "LOOP_BORROW_BPS");

  if (slippageBps <= 0 || slippageBps >= 10_000) {
    throw new Error(`SLIPPAGE_BPS must be between 1 and 9999, got ${slippageBps}`);
  }
  if (loopBorrowBps <= 0 || loopBorrowBps > 10_000) {
    throw new Error(`LOOP_BORROW_BPS must be between 1 and 10000, got ${loopBorrowBps}`);
  }
  const runIntervalSeconds = parseInteger(process.env.RUN_INTERVAL_SECONDS ?? "60", "RUN_INTERVAL_SECONDS");
  if (runIntervalSeconds <= 0) {
    throw new Error(`RUN_INTERVAL_SECONDS must be > 0, got ${runIntervalSeconds}`);
  }
  const usdcDecimals = parseInteger(process.env.USDC_DECIMALS ?? String(USDC_DECIMALS), "USDC_DECIMALS");
  if (usdcDecimals <= 0 || usdcDecimals > 255) {
    throw new Error(`USDC_DECIMALS must be between 1 and 255, got ${usdcDecimals}`);
  }

  const computeBufferBps = parseInteger(process.env.COMPUTE_BUFFER_BPS ?? "2000", "COMPUTE_BUFFER_BPS");
  if (computeBufferBps < 0 || computeBufferBps > Number(BPS_DENOMINATOR)) {
    throw new Error(`COMPUTE_BUFFER_BPS must be between 0 and 10000, got ${computeBufferBps}`);
  }

  const runwayNominalDays = parseInteger(process.env.RUNWAY_NOMINAL_DAYS ?? "14", "RUNWAY_NOMINAL_DAYS");
  const runwayElevatedDays = parseInteger(process.env.RUNWAY_ELEVATED_DAYS ?? "7", "RUNWAY_ELEVATED_DAYS");
  const runwayDeadDays = parseInteger(process.env.RUNWAY_DEAD_DAYS ?? "2", "RUNWAY_DEAD_DAYS");

  if (runwayDeadDays <= 0 || runwayElevatedDays <= 0 || runwayNominalDays <= 0) {
    throw new Error("RUNWAY_*_DAYS values must be positive integers");
  }
  if (!(runwayNominalDays > runwayElevatedDays && runwayElevatedDays > runwayDeadDays)) {
    throw new Error(
      `Runway thresholds must satisfy nominal > elevated > dead. got nominal=${runwayNominalDays}, elevated=${runwayElevatedDays}, dead=${runwayDeadDays}`
    );
  }

  const maxHarvestEquityBps = parseInteger(process.env.MAX_HARVEST_EQUITY_BPS ?? "500", "MAX_HARVEST_EQUITY_BPS");
  if (maxHarvestEquityBps <= 0 || maxHarvestEquityBps > Number(BPS_DENOMINATOR)) {
    throw new Error(`MAX_HARVEST_EQUITY_BPS must be between 1 and 10000, got ${maxHarvestEquityBps}`);
  }
  if (hfTargetWad < WAD) {
    throw new Error("HF_TARGET must be >= 1.0");
  }

  const entryPointAddress = optionalAddress(process.env.ENTRYPOINT_ADDRESS, "ENTRYPOINT_ADDRESS") ?? defaults.entryPoint07;
  const wstEthAddress = optionalAddress(process.env.WSTETH_ADDRESS, "WSTETH_ADDRESS") ?? parseAddress(defaults.wstEth, "WSTETH_ADDRESS");
  const wethAddress = optionalAddress(process.env.WETH_ADDRESS, "WETH_ADDRESS") ?? parseAddress(defaults.weth, "WETH_ADDRESS");
  const usdcAddress = optionalAddress(process.env.USDC_ADDRESS, "USDC_ADDRESS") ?? parseAddress(defaults.usdc, "USDC_ADDRESS");
  const aavePoolAddress = optionalAddress(process.env.AAVE_POOL_ADDRESS, "AAVE_POOL_ADDRESS") ?? parseAddress(defaults.aavePool, "AAVE_POOL_ADDRESS");
  const dexRouterAddress = optionalAddress(process.env.DEX_ROUTER_ADDRESS, "DEX_ROUTER_ADDRESS") ?? parseAddress(defaults.dexRouter, "DEX_ROUTER_ADDRESS");

  return {
    chainId,
    dryRun,
    allowTestnet,
    baseRpcUrl: mustEnv("BASE_RPC_URL"),
    bundlerRpcUrl: mustEnv("BUNDLER_RPC_URL"),
    paymasterRpcUrl: optionalEnv("PAYMASTER_RPC_URL"),
    entryPointAddress,
    entryPointVersion: "0.7",
    factoryAddress: optionalAddress(process.env.FACTORY_ADDRESS, "FACTORY_ADDRESS") ?? defaults.simpleAccountFactory07,
    ownerPrivateKey: mustEnv("OWNER_PRIVATE_KEY") as Hex,
    smartAccountSalt: parseSalt(process.env.SMART_ACCOUNT_SALT ?? "0"),
    builderCode: mustEnv("BUILDER_CODE"),
    hfTargetWad,
    hfBufferWad,
    maxLoops: parseInteger(process.env.MAX_LOOPS ?? "5", "MAX_LOOPS"),
    loopBorrowBps,
    runIntervalSeconds,
    escrowAddress: parseAddress(mustEnv("ESCROW_ADDRESS"), "ESCROW_ADDRESS"),
    monthlyServerCostUsdc: parseDecimalToUnits(
      process.env.MONTHLY_SERVER_COST_USDC ?? "7.50",
      usdcDecimals,
      "MONTHLY_SERVER_COST_USDC"
    ),
    computeBufferBps,
    runwayNominalDays,
    runwayElevatedDays,
    runwayDeadDays,
    maxHarvestEquityBps,
    slippageBps,
    wstEthAddress,
    wethAddress,
    usdcAddress,
    aavePoolAddress,
    dexRouterAddress,
    zrxApiUrl: process.env.ZEROX_API_URL?.trim() || "https://base.api.0x.org/swap/allowance-holder/quote",
    zrxApiKey: optionalEnv("ZEROX_API_KEY"),
    runLogPath: process.env.RUN_LOG_PATH?.trim() || "./data/runs.ndjson",
    snapshotPath: process.env.SNAPSHOT_PATH?.trim() || "./data/wsteth-snapshots.json",
    swapCostUsdEstimate: parseDecimalToUnits(process.env.SWAP_COST_USD_ESTIMATE ?? "0", 8, "SWAP_COST_USD_ESTIMATE"),
    expectedDecimals: {
      usdc: usdcDecimals,
      weth: WETH_DECIMALS,
      wstEth: WSTETH_DECIMALS
    }
  };
}
