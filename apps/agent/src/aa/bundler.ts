import type { Address, Chain, Hex } from "viem";
import { formatUserOperationRequest, createBundlerClient } from "viem/account-abstraction";
import { http } from "viem";
import type { SmartAccount } from "viem/account-abstraction";
import type { CirclePaymasterConfig, OptionalPaymasterClient } from "./paymaster";
import { createCirclePaymasterFields, toPaymasterParam } from "./paymaster";

export type Call = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type UserOpExecutionResult = {
  dryRun: boolean;
  success: boolean;
  callData: Hex;
  callDataWithSuffix: Hex;
  builderSuffix: Hex;
  userOpHash?: Hex;
  txHash?: Hex;
  blockNumber?: bigint;
  reason?: string;
  /** Set when Circle Paymaster was used — indicates gas was paid in USDC */
  circlePaymasterUsed?: boolean;
};

export type BundlerContext = {
  bundlerClient: ReturnType<typeof createBundlerClient>;
  entryPointAddress: Address;
};

type UserOpFeeOverrides = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

type PimlicoGasPriceTier = {
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

type PimlicoGasPriceResponse = {
  slow?: PimlicoGasPriceTier;
  standard?: PimlicoGasPriceTier;
  fast?: PimlicoGasPriceTier;
};

async function getUserOpFeeOverrides(context: BundlerContext): Promise<UserOpFeeOverrides> {
  try {
    const response = (await context.bundlerClient.request({
      method: "pimlico_getUserOperationGasPrice",
      params: []
    })) as PimlicoGasPriceResponse;

    const tier = response.standard ?? response.fast ?? response.slow;
    if (!tier?.maxFeePerGas || !tier.maxPriorityFeePerGas) {
      return {};
    }

    return {
      maxFeePerGas: BigInt(tier.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tier.maxPriorityFeePerGas)
    };
  } catch {
    return {};
  }
}

export function createBundlerContext(chain: Chain, bundlerRpcUrl: string, entryPointAddress: Address): BundlerContext {
  const bundlerClient = createBundlerClient({
    chain,
    transport: http(bundlerRpcUrl),
    pollingInterval: 1_500
  });

  return {
    bundlerClient,
    entryPointAddress
  };
}

export async function sendUserOperation(
  context: BundlerContext,
  account: SmartAccount,
  calls: Call[],
  callDataWithSuffix: Hex,
  builderSuffix: Hex,
  dryRun: boolean,
  paymasterClient?: OptionalPaymasterClient,
  circlePaymaster?: CirclePaymasterConfig
): Promise<UserOpExecutionResult> {
  const callData = await account.encodeCalls(calls);
  const useCircle = circlePaymaster?.enabled === true;

  if (dryRun) {
    return {
      dryRun: true,
      success: true,
      callData,
      callDataWithSuffix,
      builderSuffix,
      circlePaymasterUsed: useCircle,
      reason: `DRY_RUN enabled. UserOperation not sent.${useCircle ? " (Circle Paymaster would be used)" : ""}`
    };
  }

  let paymasterOverrides: Record<string, unknown> = {};

  if (useCircle) {
    // Circle Paymaster: set paymaster fields directly on the userOp
    const fields = createCirclePaymasterFields(circlePaymaster);
    paymasterOverrides = {
      paymaster: fields.paymaster,
      paymasterVerificationGasLimit: fields.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: fields.paymasterPostOpGasLimit,
      paymasterData: fields.paymasterData
    };
  }

  const paymasterParam = useCircle ? undefined : toPaymasterParam(paymasterClient);
  const feeOverrides = await getUserOpFeeOverrides(context);

  const prepared = await context.bundlerClient.prepareUserOperation({
    account,
    callData: callDataWithSuffix,
    ...(paymasterParam ? { paymaster: paymasterParam } : {}),
    ...paymasterOverrides,
    ...feeOverrides
  } as never);

  const userOperation = {
    ...(prepared as object),
    sender: account.address,
    callData: callDataWithSuffix,
    ...paymasterOverrides,
    ...feeOverrides
  } as never;

  const signature = await account.signUserOperation(userOperation);

  const userOpHash = await context.bundlerClient.request({
    method: "eth_sendUserOperation",
    params: [
      formatUserOperationRequest({
        ...(userOperation as object),
        signature
      } as never),
      context.entryPointAddress
    ]
  });

  const receipt = await context.bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 180_000,
    pollingInterval: 1_500
  });

  return {
    dryRun: false,
    success: receipt.success,
    callData,
    callDataWithSuffix,
    builderSuffix,
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
    reason: receipt.reason,
    circlePaymasterUsed: useCircle
  };
}
