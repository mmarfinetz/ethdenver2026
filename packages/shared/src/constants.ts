import type { Address } from "viem";

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const USDC_DECIMALS = 6;
export const WETH_DECIMALS = 18;
export const WSTETH_DECIMALS = 18;

export const BPS_DENOMINATOR = 10_000n;
export const WAD = 10n ** 18n;
export const RAY = 10n ** 27n;
export const USD_DECIMALS = 8n;
export const USD_UNIT = 10n ** USD_DECIMALS;
export const YEAR_SECONDS = 31_536_000n;
export const SECONDS_PER_DAY = 86_400n;
export const SECONDS_PER_MONTH = 2_592_000n;

export type ChainDefaults = {
  usdc: Address | "";
  weth: Address | "";
  wstEth: Address | "";
  aavePool: Address | "";
  dexRouter: Address | "";
  simpleAccountFactory07: Address;
  entryPoint07: Address;
  explorerTxUrl: string;
  explorerAddressUrl: string;
};

export const CHAIN_DEFAULTS: Record<number, ChainDefaults> = {
  [BASE_MAINNET_CHAIN_ID]: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    wstEth: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    dexRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    simpleAccountFactory07: "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985",
    entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    explorerTxUrl: "https://basescan.org/tx/",
    explorerAddressUrl: "https://basescan.org/address/"
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    usdc: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    weth: "0x4200000000000000000000000000000000000006",
    // Base Sepolia does not currently expose an Aave wstETH reserve; use WETH as a testnet stand-in.
    wstEth: "0x4200000000000000000000000000000000000006",
    aavePool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    // Only used for startup bytecode assertions in this codebase today.
    dexRouter: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    simpleAccountFactory07: "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985",
    entryPoint07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
    explorerAddressUrl: "https://sepolia.basescan.org/address/"
  }
};

export const MAX_UINT256 = (1n << 256n) - 1n;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" satisfies Address;
