import { simpleAccountAbi, simpleAccountFactoryAbi } from "@ssa/shared/abis";
import type { Address, Hex, TypedData } from "viem";
import {
  decodeFunctionData,
  encodeFunctionData,
  pad,
  parseAbi,
  type WalletClient
} from "viem";
import { readContract } from "viem/actions";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toSmartAccount,
  type SmartAccount
} from "viem/account-abstraction";

export type CreateSimpleSmartAccountParams = {
  walletClient: WalletClient;
  owner: Address;
  entryPointAddress: Address;
  factoryAddress: Address;
  salt: bigint;
};

export async function createSimpleSmartAccount(
  params: CreateSimpleSmartAccountParams
): Promise<SmartAccount> {
  const ownerAccount = params.walletClient.account;
  if (!ownerAccount || !ownerAccount.signMessage || !ownerAccount.signTypedData) {
    throw new Error("walletClient.account must be a local account with signMessage/signTypedData");
  }

  const entryPoint = {
    abi: entryPoint07Abi,
    address: params.entryPointAddress,
    version: "0.7" as const
  };

  const factory = {
    abi: simpleAccountFactoryAbi,
    address: params.factoryAddress
  };

  const account = await toSmartAccount({
    client: params.walletClient as any,
    entryPoint,
    extend: {
      abi: simpleAccountAbi,
      factory
    },
    async decodeCalls(data) {
      const decoded = decodeFunctionData({
        abi: simpleAccountAbi,
        data
      });

      if (decoded.functionName === "execute") {
        return [
          {
            to: decoded.args[0],
            value: decoded.args[1],
            data: decoded.args[2]
          }
        ];
      }

      if (decoded.functionName === "executeBatch") {
        const destinations = decoded.args[0];
        const values = decoded.args[1];
        const calls = decoded.args[2];

        return destinations.map((destination, index) => ({
          to: destination,
          data: calls[index],
          value: values[index] ?? 0n
        }));
      }

      throw new Error(`Unsupported account method for decodeCalls: ${decoded.functionName}`);
    },
    async encodeCalls(calls) {
      if (calls.length === 1) {
        return encodeFunctionData({
          abi: simpleAccountAbi,
          functionName: "execute",
          args: [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? "0x"]
        });
      }

      return encodeFunctionData({
        abi: simpleAccountAbi,
        functionName: "executeBatch",
        args: [
          calls.map((call) => call.to),
          calls.map((call) => call.value ?? 0n),
          calls.map((call) => call.data ?? "0x")
        ]
      });
    },
    async getAddress() {
      return readContract(params.walletClient, {
        ...factory,
        functionName: "getAddress",
        args: [params.owner, params.salt]
      });
    },
    async getFactoryArgs() {
      const factoryData = encodeFunctionData({
        abi: simpleAccountFactoryAbi,
        functionName: "createAccount",
        args: [params.owner, params.salt]
      });
      return {
        factory: params.factoryAddress,
        factoryData
      };
    },
    async getNonce() {
      return readContract(params.walletClient, {
        abi: parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]),
        address: params.entryPointAddress,
        functionName: "getNonce",
        args: [await this.getAddress(), 0n]
      });
    },
    async getStubSignature(parameters) {
      if (!parameters) {
        return ownerAccount.signMessage({
          message: {
            raw: "0x00"
          }
        });
      }

      const userOpHash = getUserOperationHash({
        chainId: parameters.chainId ?? params.walletClient.chain!.id,
        entryPointAddress: params.entryPointAddress,
        entryPointVersion: "0.7",
        userOperation: {
          ...(parameters as object),
          sender: parameters.sender ?? (await this.getAddress())
        } as never
      });

      return ownerAccount.signMessage({
        message: {
          raw: userOpHash
        }
      });
    },
    async signMessage(parameters) {
      return ownerAccount.signMessage(parameters);
    },
    async signTypedData(parameters) {
      return ownerAccount.signTypedData(parameters as {
        domain: Record<string, unknown>;
        types: TypedData;
        primaryType: string;
        message: Record<string, unknown>;
      });
    },
    async signUserOperation(parameters) {
      const userOpHash = getUserOperationHash({
        chainId: parameters.chainId ?? params.walletClient.chain!.id,
        entryPointAddress: params.entryPointAddress,
        entryPointVersion: "0.7",
        userOperation: {
          ...(parameters as object),
          sender: parameters.sender ?? (await this.getAddress())
        } as never
      });

      return ownerAccount.signMessage({
        message: {
          raw: userOpHash
        }
      });
    }
  });

  return account as unknown as SmartAccount;
}

export async function deriveSmartAccountAddress(
  walletClient: WalletClient,
  factoryAddress: Address,
  owner: Address,
  salt: bigint
): Promise<Address> {
  return readContract(walletClient, {
    abi: simpleAccountFactoryAbi,
    address: factoryAddress,
    functionName: "getAddress",
    args: [owner, salt]
  });
}

export function saltToBytes32(salt: bigint): Hex {
  return pad(`0x${salt.toString(16)}`, { size: 32 });
}
