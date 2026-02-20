import { aavePoolAbi, erc20Abi } from "@ssa/shared/abis";
import { assertBaseChain, parseAddress } from "@ssa/shared/utils";
import type { Address, Chain, PublicClient, WalletClient } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { AgentConfig } from "./config";

export type ChainContext = {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: ReturnType<typeof privateKeyToAccount>;
};

function resolveChain(chainId: number): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return {
    ...base,
    id: chainId,
    name: `Custom Base-like ${chainId}`,
    nativeCurrency: base.nativeCurrency,
    rpcUrls: {
      default: {
        http: [""],
        webSocket: undefined
      },
      public: {
        http: [""],
        webSocket: undefined
      }
    }
  } as Chain;
}

export function createChainContext(config: AgentConfig): ChainContext {
  const chain = resolveChain(config.chainId);
  const owner = privateKeyToAccount(config.ownerPrivateKey);

  const transport = http(config.baseRpcUrl, {
    retryCount: 3,
    retryDelay: 500
  });

  const publicClient = createPublicClient({
    chain,
    transport
  });

  const walletClient = createWalletClient({
    account: owner,
    chain,
    transport
  });

  return {
    chain,
    publicClient,
    walletClient,
    owner
  };
}

export async function assertCodeExists(client: PublicClient, address: Address, label: string): Promise<void> {
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") {
    throw new Error(`${label} has no code at ${address}`);
  }
}

async function assertTokenDecimals(
  client: PublicClient,
  token: Address,
  expected: number,
  label: string
): Promise<void> {
  const decimals = await client.readContract({
    abi: erc20Abi,
    address: token,
    functionName: "decimals"
  });

  if (decimals !== expected) {
    throw new Error(`${label} decimals mismatch. expected=${expected}, got=${decimals}`);
  }
}

export async function validateStartup(config: AgentConfig, ctx: ChainContext): Promise<void> {
  assertBaseChain(config.chainId, config.allowTestnet);

  const chainId = await ctx.publicClient.getChainId();
  if (chainId !== config.chainId) {
    throw new Error(`RPC chainId mismatch. expected=${config.chainId}, got=${chainId}`);
  }

  await Promise.all([
    assertCodeExists(ctx.publicClient, config.aavePoolAddress, "AAVE_POOL_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.dexRouterAddress, "DEX_ROUTER_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.entryPointAddress, "ENTRYPOINT_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.factoryAddress, "FACTORY_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.wethAddress, "WETH_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.wstEthAddress, "WSTETH_ADDRESS"),
    assertCodeExists(ctx.publicClient, config.usdcAddress, "USDC_ADDRESS")
  ]);

  await Promise.all([
    assertTokenDecimals(ctx.publicClient, config.usdcAddress, config.expectedDecimals.usdc, "USDC"),
    assertTokenDecimals(ctx.publicClient, config.wethAddress, config.expectedDecimals.weth, "WETH"),
    assertTokenDecimals(ctx.publicClient, config.wstEthAddress, config.expectedDecimals.wstEth, "wstETH")
  ]);

  const providerAddress = await ctx.publicClient.readContract({
    abi: aavePoolAbi,
    address: config.aavePoolAddress,
    functionName: "ADDRESSES_PROVIDER"
  });

  parseAddress(providerAddress, "AAVE_POOL.ADDRESSES_PROVIDER");

  if (!config.builderCode.startsWith("bc_")) {
    throw new Error("BUILDER_CODE must start with 'bc_'");
  }
}
