import { Attribution } from "ox/erc8021";
import type { Hex } from "viem";

export function buildDataSuffix(builderCode: string): Hex {
  if (!builderCode.startsWith("bc_")) {
    throw new Error(`Invalid builder code: ${builderCode}`);
  }

  return Attribution.toDataSuffix({
    codes: [builderCode]
  }) as Hex;
}

export function applySuffix(callData: Hex, suffix: Hex): Hex {
  return `0x${callData.slice(2)}${suffix.slice(2)}` as Hex;
}

export function callDataHasSuffix(callData: Hex, suffix: Hex): boolean {
  return callData.toLowerCase().endsWith(suffix.slice(2).toLowerCase());
}
