import { env } from "../config/env.js";
import { TtlCache } from "../lib/utils.js";

const metadataCache = new TtlCache<unknown>(5 * 60_000);
const ohlcvCache = new TtlCache<unknown>(30_000);

export type OhlcvCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export class MobulaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MobulaError";
  }
}

async function mobulaGet<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, env.MOBULA_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: env.MOBULA_API_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MobulaError(`Mobula ${res.status}: ${body.slice(0, 400)}`, res.status);
  }

  return (await res.json()) as T;
}

/** Token metadata / details. Tries v2 details then legacy metadata. */
export async function getTokenMetadata(tokenAddress: string) {
  const key = `meta:${env.CHAIN_ID}:${tokenAddress.toLowerCase()}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;

  try {
    const data = await mobulaGet<unknown>("/api/2/token/details", {
      address: tokenAddress,
      blockchain: env.CHAIN_ID,
    });
    metadataCache.set(key, data);
    return data;
  } catch (first) {
    try {
      const data = await mobulaGet<unknown>("/api/1/metadata", {
        asset: tokenAddress,
        blockchain: env.CHAIN_ID,
      });
      metadataCache.set(key, data);
      return data;
    } catch (second) {
      const status =
        second instanceof MobulaError
          ? second.status
          : first instanceof MobulaError
            ? first.status
            : 502;
      throw new MobulaError(
        second instanceof Error ? second.message : String(second),
        status >= 400 && status < 500 ? status : 502,
      );
    }
  }
}

/** OHLCV candles for Terminal / Explore charts. */
export async function getTokenOhlcv(opts: {
  address: string;
  period?: string;
  from?: number;
  to?: number;
  amount?: number;
}): Promise<{ data: OhlcvCandle[] }> {
  const period = opts.period ?? "1h";
  const key = `ohlcv:${env.CHAIN_ID}:${opts.address.toLowerCase()}:${period}:${opts.from ?? ""}:${opts.to ?? ""}:${opts.amount ?? ""}`;
  const cached = ohlcvCache.get(key) as { data: OhlcvCandle[] } | undefined;
  if (cached) return cached;

  const data = await mobulaGet<{ data: OhlcvCandle[] }>("/api/2/token/ohlcv-history", {
    address: opts.address,
    blockchain: env.CHAIN_ID,
    period,
    from: opts.from,
    to: opts.to,
    amount: opts.amount ?? 200,
    usd: "true",
  });

  ohlcvCache.set(key, data);
  return data;
}

/** Best-effort price enrichment for launch cards. */
export async function getTokenMarketSnapshot(tokenAddress: string): Promise<{
  priceUsd?: number;
  marketCap?: number;
  volume24h?: number;
  liquidity?: number;
} | null> {
  try {
    const raw = (await getTokenMetadata(tokenAddress)) as Record<string, unknown>;
    const nested = (raw.data ?? raw) as Record<string, unknown>;
    const price =
      Number(nested.price ?? nested.priceUSD ?? nested.price_usd ?? NaN) || undefined;
    const marketCap =
      Number(nested.market_cap ?? nested.marketCap ?? nested.marketCapUSD ?? NaN) || undefined;
    const volume24h =
      Number(nested.volume ?? nested.volume_24h ?? nested.volume24h ?? NaN) || undefined;
    const liquidity =
      Number(nested.liquidity ?? nested.liquidityUSD ?? NaN) || undefined;
    return { priceUsd: price, marketCap, volume24h, liquidity };
  } catch {
    return null;
  }
}
