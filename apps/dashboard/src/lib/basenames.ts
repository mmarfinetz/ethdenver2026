import type { Address, PublicClient } from "viem";
import { getAddress } from "viem";

export type BasenameResolution = {
  address: Address;
  reverseName: string | null;
  basename: string | null;
  reverseVerified: boolean;
};

function isBasename(name: string): boolean {
  return name.toLowerCase().endsWith(".base.eth");
}

export async function resolveBasenameWithReverseCheck(
  client: PublicClient,
  address: Address
): Promise<BasenameResolution> {
  try {
    const reverseName = await client.getEnsName({ address });
    if (!reverseName || !isBasename(reverseName)) {
      return {
        address,
        reverseName: reverseName ?? null,
        basename: null,
        reverseVerified: false
      };
    }

    const resolved = await client.getEnsAddress({ name: reverseName });
    const reverseVerified = Boolean(resolved) && getAddress(resolved!) === getAddress(address);
    return {
      address,
      reverseName,
      basename: reverseVerified ? reverseName : null,
      reverseVerified
    };
  } catch {
    return {
      address,
      reverseName: null,
      basename: null,
      reverseVerified: false
    };
  }
}
