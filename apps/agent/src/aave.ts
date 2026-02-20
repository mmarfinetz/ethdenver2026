import {
  aaveAddressProviderAbi,
  aaveOracleAbi,
  aavePoolAbi,
  erc20Abi,
  wstEthAbi
} from "@ssa/shared/abis";
import {
  USD_UNIT,
  WAD,
  WETH_DECIMALS,
  WSTETH_DECIMALS,
  USDC_DECIMALS
} from "@ssa/shared/constants";
import { mulDiv } from "@ssa/shared/utils";
import type { Address, Hex, PublicClient } from "viem";
import { encodeFunctionData } from "viem";
import type { AgentConfig } from "./config";

export type PositionState = {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThresholdBps: bigint;
  currentLtvBps: bigint;
  healthFactor: bigint;
};

export type ReserveState = {
  currentVariableBorrowRateRay: bigint;
};

export type PriceState = {
  wethUsd: bigint;
  wstEthUsd: bigint;
  usdcUsd: bigint;
  oracle: Address;
};

export type BalanceState = {
  eth: bigint;
  weth: bigint;
  wstEth: bigint;
  usdc: bigint;
};

export type ChainSnapshot = {
  timestamp: string;
  blockNumber: bigint;
  account: Address;
  escrowUsdc: bigint;
  position: PositionState;
  reserve: ReserveState;
  prices: PriceState;
  balances: BalanceState;
  wstEthPerToken: bigint;
};

export type Call = {
  to: Address;
  data: Hex;
  value?: bigint;
};

async function readWstEthPerToken(client: PublicClient, token: Address): Promise<bigint> {
  try {
    return await client.readContract({
      abi: wstEthAbi,
      address: token,
      functionName: "stEthPerToken"
    });
  } catch {
    // Multichain wstETH deployments may not expose stEthPerToken; use neutral 1.0 ratio fallback.
    return WAD;
  }
}

export async function readChainSnapshot(
  client: PublicClient,
  config: AgentConfig,
  account: Address
): Promise<ChainSnapshot> {
  const blockNumber = await client.getBlockNumber();

  const [
    eth,
    weth,
    wstEth,
    usdc,
    escrowUsdc,
    userData,
    reserveData,
    provider,
    wstEthPerToken
  ] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({
      abi: erc20Abi,
      address: config.wethAddress,
      functionName: "balanceOf",
      args: [account]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.wstEthAddress,
      functionName: "balanceOf",
      args: [account]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.usdcAddress,
      functionName: "balanceOf",
      args: [account]
    }),
    client.readContract({
      abi: erc20Abi,
      address: config.usdcAddress,
      functionName: "balanceOf",
      args: [config.escrowAddress]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "getUserAccountData",
      args: [account]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "getReserveData",
      args: [config.wethAddress]
    }),
    client.readContract({
      abi: aavePoolAbi,
      address: config.aavePoolAddress,
      functionName: "ADDRESSES_PROVIDER"
    }),
    readWstEthPerToken(client, config.wstEthAddress)
  ]);

  const oracle = await client.readContract({
    abi: aaveAddressProviderAbi,
    address: provider,
    functionName: "getPriceOracle"
  });

  const [wethUsd, wstEthUsd, usdcUsd] = await Promise.all([
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.wethAddress]
    }),
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.wstEthAddress]
    }),
    client.readContract({
      abi: aaveOracleAbi,
      address: oracle,
      functionName: "getAssetPrice",
      args: [config.usdcAddress]
    })
  ]);

  const position: PositionState = {
    totalCollateralBase: userData[0],
    totalDebtBase: userData[1],
    availableBorrowsBase: userData[2],
    currentLiquidationThresholdBps: userData[3],
    currentLtvBps: userData[4],
    healthFactor: userData[5]
  };

  return {
    timestamp: new Date().toISOString(),
    blockNumber,
    account,
    escrowUsdc,
    balances: {
      eth,
      weth,
      wstEth,
      usdc
    },
    position,
    reserve: {
      currentVariableBorrowRateRay: reserveData.currentVariableBorrowRate
    },
    prices: {
      wethUsd,
      wstEthUsd,
      usdcUsd,
      oracle
    },
    wstEthPerToken
  };
}

export function tokenToUsd(amount: bigint, tokenDecimals: number, priceUsd: bigint): bigint {
  const unit = 10n ** BigInt(tokenDecimals);
  return mulDiv(amount, priceUsd, unit);
}

export function usdToToken(usdValue: bigint, tokenDecimals: number, priceUsd: bigint): bigint {
  if (priceUsd === 0n) throw new Error("Oracle returned zero price");
  const unit = 10n ** BigInt(tokenDecimals);
  return mulDiv(usdValue, unit, priceUsd);
}

export function usdcToUsd(usdcAmount: bigint, usdcPrice: bigint, usdcDecimals = USDC_DECIMALS): bigint {
  return tokenToUsd(usdcAmount, usdcDecimals, usdcPrice);
}

export function gasWeiToUsd(gasWei: bigint, wethUsd: bigint): bigint {
  return tokenToUsd(gasWei, WETH_DECIMALS, wethUsd);
}

export function callApprove(token: Address, spender: Address, amount: bigint): Call {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount]
    })
  };
}

export function callTransfer(token: Address, to: Address, amount: bigint): Call {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amount]
    })
  };
}

export function callSupply(pool: Address, asset: Address, amount: bigint, onBehalfOf: Address): Call {
  return {
    to: pool,
    value: 0n,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [asset, amount, onBehalfOf, 0]
    })
  };
}

export function callBorrow(pool: Address, asset: Address, amount: bigint, onBehalfOf: Address): Call {
  return {
    to: pool,
    value: 0n,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "borrow",
      args: [asset, amount, 2n, 0, onBehalfOf]
    })
  };
}

export function callRepay(pool: Address, asset: Address, amount: bigint, onBehalfOf: Address): Call {
  return {
    to: pool,
    value: 0n,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "repay",
      args: [asset, amount, 2n, onBehalfOf]
    })
  };
}

export function callWithdraw(pool: Address, asset: Address, amount: bigint, to: Address): Call {
  return {
    to: pool,
    value: 0n,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "withdraw",
      args: [asset, amount, to]
    })
  };
}

export function wstEthUsd(amount: bigint, priceUsd: bigint): bigint {
  return tokenToUsd(amount, WSTETH_DECIMALS, priceUsd);
}

export function wethUsd(amount: bigint, priceUsd: bigint): bigint {
  return tokenToUsd(amount, WETH_DECIMALS, priceUsd);
}

export function normalizeToUsd(value: bigint): bigint {
  return mulDiv(value, USD_UNIT, USD_UNIT);
}
