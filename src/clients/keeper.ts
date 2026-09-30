import {
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { robinhood, getPublicClient } from "./rpc.js";

const RPC_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; LootingIndexer/0.1; +https://github.com/LootingPad/looting-backend)",
  Accept: "application/json",
};

let wallet: WalletClient | undefined;

/** Keeper wallet for protocol txs (allocate tax, etc.). Null when key unset. */
export function getKeeperWallet(): WalletClient | null {
  const raw = env.KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!wallet) {
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    const account = privateKeyToAccount(key);
    wallet = createWalletClient({
      account,
      chain: robinhood,
      transport: http(env.RPC_HTTP_URL, {
        timeout: 20_000,
        retryCount: 1,
        fetchOptions: { headers: RPC_FETCH_HEADERS },
      }),
    });
  }
  return wallet;
}

export function getPublic(): PublicClient {
  return getPublicClient();
}
