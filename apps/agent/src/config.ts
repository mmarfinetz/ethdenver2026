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
import { privateKeyToAccount } from "viem/accounts";
import { CIRCLE_PAYMASTER_ADDRESS } from "./aa/paymaster";

export type ComputeBillingMode = "escrow" | "conway";

export type AgentConfig = {
  chainId: number;
  dryRun: boolean;
  allowTestnet: boolean;
  computeBillingMode: ComputeBillingMode;
  baseRpcUrl: string;
  bundlerRpcUrl: string;
  paymasterRpcUrl?: string;
  useCirclePaymaster: boolean;
  circlePaymasterAddress: Address;
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
  conwayApiBaseUrl?: string;
  conwayApiKey?: string;
  conwayCreditsBalancePath: string;
  conwayCreditsTopupPath: string;
  conwayPaymentRecipientAddress?: Address;
  conwayPayerAddress?: Address;
  conwayX402Enabled: boolean;
  conwayPayerPrivateKey?: Hex;
  conwayX402HeaderName: string;
  conwayFallbackToEscrowOnError: boolean;
  conwayCreditsMinBalanceUsdc: bigint;
  conwayCreditsTargetBalanceUsdc: bigint;
  conwayCreditsTopupMaxUsdcPerTick: bigint;
  conwayCreditsTopupCooldownSeconds: number;
  conwayPayerMinBalanceUsdc: bigint;
  conwayPayerTargetBalanceUsdc: bigint;
  conwayPayerFundMaxUsdcPerTick: bigint;
  conwayPayerFundMaxUsdcPerDay: bigint;
  conwayPayerFundCooldownSeconds: number;
  conwayReconciliationBootstrapUsdc: bigint;
  conwayReconciliationWindowHours: number;
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

function optionalPrivateKey(raw: string | undefined, label: string): Hex | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid private key for ${label}`);
  }
  return value as Hex;
}

export function loadConfig(): AgentConfig {
  const chainId = parseInteger(process.env.CHAIN_ID ?? String(BASE_MAINNET_CHAIN_ID), "CHAIN_ID");
  const defaults = CHAIN_DEFAULTS[chainId] ?? CHAIN_DEFAULTS[BASE_MAINNET_CHAIN_ID];
  const computeBillingModeRaw = (process.env.COMPUTE_BILLING_MODE ?? "escrow").trim().toLowerCase();
  if (computeBillingModeRaw !== "escrow" && computeBillingModeRaw !== "conway") {
    throw new Error(`COMPUTE_BILLING_MODE must be escrow|conway, got ${computeBillingModeRaw}`);
  }
  const computeBillingMode = computeBillingModeRaw as ComputeBillingMode;

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

  const useCirclePaymaster = parseBoolean(process.env.USE_CIRCLE_PAYMASTER, false);
  const circlePaymasterAddress =
    optionalAddress(process.env.CIRCLE_PAYMASTER_ADDRESS, "CIRCLE_PAYMASTER_ADDRESS") ?? CIRCLE_PAYMASTER_ADDRESS;

  const conwayApiBaseUrl = optionalEnv("CONWAY_API_BASE_URL");
  if (computeBillingMode === "conway" && !conwayApiBaseUrl) {
    throw new Error("CONWAY_API_BASE_URL is required when COMPUTE_BILLING_MODE=conway");
  }
  const conwayPayerPrivateKey = optionalPrivateKey(process.env.CONWAY_PAYER_PRIVATE_KEY, "CONWAY_PAYER_PRIVATE_KEY");
  const conwayPayerAddress =
    optionalAddress(process.env.CONWAY_PAYER_ADDRESS, "CONWAY_PAYER_ADDRESS") ??
    (conwayPayerPrivateKey ? privateKeyToAccount(conwayPayerPrivateKey).address : undefined);
  const conwayCreditsMinBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_CREDITS_MIN_BALANCE_USDC ?? "10",
    usdcDecimals,
    "CONWAY_CREDITS_MIN_BALANCE_USDC"
  );
  const conwayCreditsTargetBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_CREDITS_TARGET_BALANCE_USDC ?? "50",
    usdcDecimals,
    "CONWAY_CREDITS_TARGET_BALANCE_USDC"
  );
  const conwayCreditsTopupMaxUsdcPerTick = parseDecimalToUnits(
    process.env.CONWAY_CREDITS_MAX_TOPUP_USDC_PER_TICK ?? "25",
    usdcDecimals,
    "CONWAY_CREDITS_MAX_TOPUP_USDC_PER_TICK"
  );
  const conwayCreditsTopupCooldownSeconds = parseInteger(
    process.env.CONWAY_CREDITS_TOPUP_COOLDOWN_SECONDS ?? "900",
    "CONWAY_CREDITS_TOPUP_COOLDOWN_SECONDS"
  );
  const conwayPayerMinBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_PAYER_MIN_BALANCE_USDC ?? "5",
    usdcDecimals,
    "CONWAY_PAYER_MIN_BALANCE_USDC"
  );
  const conwayPayerTargetBalanceUsdc = parseDecimalToUnits(
    process.env.CONWAY_PAYER_TARGET_BALANCE_USDC ?? "25",
    usdcDecimals,
    "CONWAY_PAYER_TARGET_BALANCE_USDC"
  );
  const conwayPayerFundMaxUsdcPerTick = parseDecimalToUnits(
    process.env.CONWAY_PAYER_MAX_FUND_USDC_PER_TICK ?? "25",
    usdcDecimals,
    "CONWAY_PAYER_MAX_FUND_USDC_PER_TICK"
  );
  const conwayPayerFundMaxUsdcPerDay = parseDecimalToUnits(
    process.env.CONWAY_PAYER_MAX_FUND_USDC_PER_DAY ?? "100",
    usdcDecimals,
    "CONWAY_PAYER_MAX_FUND_USDC_PER_DAY"
  );
  const conwayPayerFundCooldownSeconds = parseInteger(
    process.env.CONWAY_PAYER_FUND_COOLDOWN_SECONDS ?? "900",
    "CONWAY_PAYER_FUND_COOLDOWN_SECONDS"
  );
  const conwayReconciliationBootstrapUsdc = parseDecimalToUnits(
    process.env.CONWAY_RECONCILIATION_BOOTSTRAP_USDC ?? "0",
    usdcDecimals,
    "CONWAY_RECONCILIATION_BOOTSTRAP_USDC"
  );
  const conwayReconciliationWindowHours = parseInteger(
    process.env.CONWAY_RECONCILIATION_WINDOW_HOURS ?? "24",
    "CONWAY_RECONCILIATION_WINDOW_HOURS"
  );
  if (conwayCreditsTargetBalanceUsdc < conwayCreditsMinBalanceUsdc) {
    throw new Error("CONWAY_CREDITS_TARGET_BALANCE_USDC must be >= CONWAY_CREDITS_MIN_BALANCE_USDC");
  }
  if (conwayPayerTargetBalanceUsdc < conwayPayerMinBalanceUsdc) {
    throw new Error("CONWAY_PAYER_TARGET_BALANCE_USDC must be >= CONWAY_PAYER_MIN_BALANCE_USDC");
  }
  if (conwayCreditsTopupCooldownSeconds < 0) {
    throw new Error("CONWAY_CREDITS_TOPUP_COOLDOWN_SECONDS must be >= 0");
  }
  if (conwayPayerFundCooldownSeconds < 0) {
    throw new Error("CONWAY_PAYER_FUND_COOLDOWN_SECONDS must be >= 0");
  }
  if (conwayReconciliationWindowHours <= 0) {
    throw new Error("CONWAY_RECONCILIATION_WINDOW_HOURS must be > 0");
  }
  if (
    computeBillingMode === "conway" &&
    (conwayPayerMinBalanceUsdc > 0n || conwayPayerTargetBalanceUsdc > 0n) &&
    !conwayPayerAddress
  ) {
    throw new Error("CONWAY_PAYER_ADDRESS or CONWAY_PAYER_PRIVATE_KEY is required in Conway billing mode");
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
    computeBillingMode,
    baseRpcUrl: mustEnv("BASE_RPC_URL"),
    bundlerRpcUrl: mustEnv("BUNDLER_RPC_URL"),
    paymasterRpcUrl: optionalEnv("PAYMASTER_RPC_URL"),
    useCirclePaymaster,
    circlePaymasterAddress,
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
    conwayApiBaseUrl,
    conwayApiKey: optionalEnv("CONWAY_API_KEY"),
    conwayCreditsBalancePath: process.env.CONWAY_CREDITS_BALANCE_PATH?.trim() || "/v1/credits/balance",
    conwayCreditsTopupPath: process.env.CONWAY_CREDITS_TOPUP_PATH?.trim() || "/v1/credits/topup",
    conwayPaymentRecipientAddress: optionalAddress(
      process.env.CONWAY_PAYMENT_RECIPIENT_ADDRESS,
      "CONWAY_PAYMENT_RECIPIENT_ADDRESS"
    ),
    conwayPayerAddress,
    conwayX402Enabled: parseBoolean(process.env.CONWAY_X402_ENABLED, true),
    conwayPayerPrivateKey,
    conwayX402HeaderName: process.env.CONWAY_X402_HEADER_NAME?.trim() || "x-payment",
    conwayFallbackToEscrowOnError: parseBoolean(process.env.CONWAY_FALLBACK_TO_ESCROW_ON_ERROR, true),
    conwayCreditsMinBalanceUsdc,
    conwayCreditsTargetBalanceUsdc,
    conwayCreditsTopupMaxUsdcPerTick,
    conwayCreditsTopupCooldownSeconds,
    conwayPayerMinBalanceUsdc,
    conwayPayerTargetBalanceUsdc,
    conwayPayerFundMaxUsdcPerTick,
    conwayPayerFundMaxUsdcPerDay,
    conwayPayerFundCooldownSeconds,
    conwayReconciliationBootstrapUsdc,
    conwayReconciliationWindowHours,
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
