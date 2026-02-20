import type { Chain } from "viem";
import { http } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";

export type OptionalPaymasterClient = ReturnType<typeof createPaymasterClient> | undefined;

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
