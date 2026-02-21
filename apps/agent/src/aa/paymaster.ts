import type { Address, Chain, Hex } from "viem";
import { encodeFunctionData, http } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { erc20Abi } from "@ssa/shared/abis";
import type { Call } from "./bundler";

/** Circle Paymaster on Base mainnet (EntryPoint v0.7) */
export const CIRCLE_PAYMASTER_ADDRESS: Address = "0x6C973eBe80dCD8660841D4356bf15c32460271C9";

export type OptionalPaymasterClient = ReturnType<typeof createPaymasterClient> | undefined;

export type CirclePaymasterConfig = {
  enabled: boolean;
  paymasterAddress: Address;
  usdcAddress: Address;
};

/**
 * Build a USDC approve call for the Circle Paymaster.
 * The agent's smart account must approve the paymaster to pull USDC
 * for gas payment before each userOp that uses it.
 */
export function buildCirclePaymasterApproval(
  config: CirclePaymasterConfig,
  amount: bigint
): Call {
  return {
    to: config.usdcAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [config.paymasterAddress, amount]
    })
  };
}

/**
 * Create the paymasterAndData bytes for Circle Paymaster.
 *
 * Circle's permissionless paymaster on Base uses a simple scheme:
 * paymasterAndData = paymasterAddress (20 bytes) — the paymaster reads
 * the USDC approval on-chain and deducts the equivalent gas cost in USDC.
 *
 * For EntryPoint v0.7, the paymaster fields are split into:
 *  - paymaster: address
 *  - paymasterVerificationGasLimit: uint256
 *  - paymasterPostOpGasLimit: uint256
 *  - paymasterData: bytes (empty for Circle)
 */
export function createCirclePaymasterFields(config: CirclePaymasterConfig): {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
} {
  return {
    paymaster: config.paymasterAddress,
    paymasterVerificationGasLimit: 100_000n,
    paymasterPostOpGasLimit: 50_000n,
    paymasterData: "0x" as Hex
  };
}

export function createOptionalPaymasterClient(url: string | undefined, _chain: Chain): OptionalPaymasterClient {
  if (!url) return undefined;

  return createPaymasterClient({
    transport: http(url)
  });
}

export function toPaymasterParam(client: OptionalPaymasterClient):
  | {
      getPaymasterData: (...args: any[]) => Promise<any>;
      getPaymasterStubData: (...args: any[]) => Promise<any>;
    }
  | undefined {
  if (!client) return undefined;

  return {
    getPaymasterData: (parameters: any) => client.getPaymasterData(parameters),
    getPaymasterStubData: (parameters: any) => client.getPaymasterStubData(parameters)
  };
}
