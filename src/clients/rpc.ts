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

/**
 * Phantom's Cloudflare edge returns 403 for bare Node/curl User-Agents.
 * A browser-like UA is enough for the public node-proxy; no API key required.
 */
const RPC_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; LootingIndexer/0.1; +https://github.com/LootingPad/looting-backend)",
  Accept: "application/json",
};

let client: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: robinhood,
      transport: http(env.RPC_HTTP_URL, {
        timeout: 30_000,
        fetchOptions: { headers: RPC_FETCH_HEADERS },
      }),
    });
  }
  return client;
}
