import { gasWeiToUsd, tokenToUsd } from "./aave";

export function computeGasCostUsd(actualGasCostWei: bigint, wethUsd: bigint): bigint {
  return gasWeiToUsd(actualGasCostWei, wethUsd);
}

export function computeSwapCostUsd(
  sellAmount: bigint,
  sellDecimals: number,
  sellPriceUsd: bigint,
  buyAmount: bigint,
  buyDecimals: number,
  buyPriceUsd: bigint
): bigint {
  const soldUsd = tokenToUsd(sellAmount, sellDecimals, sellPriceUsd);
  const boughtUsd = tokenToUsd(buyAmount, buyDecimals, buyPriceUsd);
  return soldUsd > boughtUsd ? soldUsd - boughtUsd : 0n;
}
