import { createPublicClient, http, type PublicClient } from "viem";
import { env } from "../config/env.js";

/** Robinhood Chain mainnet (chainId 4663). */
export const robinhood = {
  id: env.CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.RPC_HTTP_URL] },
  },
} as const;

let client: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: robinhood,
      transport: http(env.RPC_HTTP_URL, { timeout: 30_000 }),
    });
  }
  return client;
}
