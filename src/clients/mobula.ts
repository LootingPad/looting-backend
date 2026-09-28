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

/** Local seed tokens (scripts/seed-demo-launches.ts) — Mobula has no quotes for these. */
const DEMO_MARKET: Record<
  string,
  { priceUsd: number; marketCap: number; volume24h: number; change1h: number; progress: number }
> = {
  "0xa1b2c3d4e5f678901234567890abcdef12345601": {
    priceUsd: 0.000186,
    marketCap: 186_420,
    volume24h: 94_200,
    change1h: 14.2,
    progress: 72,
  },
  "0xa1b2c3d4e5f678901234567890abcdef12345602": {
    priceUsd: 0.000084,
    marketCap: 84_210,
    volume24h: 41_800,
    change1h: -3.4,
    progress: 41,
  },
  "0xa1b2c3d4e5f678901234567890abcdef12345603": {
    priceUsd: 0.00094,
    marketCap: 940_000,
    volume24h: 312_400,
    change1h: 2.1,
    progress: 100,
  },
  "0xa1b2c3d4e5f678901234567890abcdef12345604": {
    priceUsd: 0.000012,
    marketCap: 12_440,
    volume24h: 6_820,
    change1h: 28.6,
    progress: 18,
  },
  "0xa1b2c3d4e5f678901234567890abcdef12345605": {
    priceUsd: 0.000257,
    marketCap: 256_800,
    volume24h: 128_000,
    change1h: 6.4,
    progress: 88,
  },
};

export function getDemoMarket(tokenAddress: string) {
  return DEMO_MARKET[tokenAddress.trim().toLowerCase()] ?? null;
}

/** Best-effort price enrichment for launch cards. */
export async function getTokenMarketSnapshot(tokenAddress: string): Promise<{
  priceUsd?: number;
  marketCap?: number;
  volume24h?: number;
  liquidity?: number;
  change1h?: number;
  change6h?: number;
  change24h?: number;
  ath?: number;
  txns?: number;
  progress?: number;
} | null> {
  const demo = getDemoMarket(tokenAddress);
  if (demo) return { ...demo };

  try {
    const raw = (await getTokenMetadata(tokenAddress)) as Record<string, unknown>;
    const nested = (raw.data ?? raw) as Record<string, unknown>;
    const priceChange = (nested.price_change_24h ?? nested.priceChange24h ?? nested.priceChange) as
      | Record<string, unknown>
      | number
      | undefined;

    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const price = num(nested.price ?? nested.priceUSD ?? nested.price_usd);
    const marketCap = num(nested.market_cap ?? nested.marketCap ?? nested.marketCapUSD);
    const volume24h = num(
      nested.volume ?? nested.volume_24h ?? nested.volume24h ?? nested.volume_24h_usd,
    );
    const liquidity = num(nested.liquidity ?? nested.liquidityUSD);
    const ath = num(nested.ath ?? nested.athMarketCap ?? nested.ath_market_cap ?? nested.market_cap_ath);

    let change1h = num(nested.price_change_1h ?? nested.priceChange1h ?? nested.change_1h);
    let change6h = num(nested.price_change_6h ?? nested.priceChange6h);
    let change24h = num(nested.price_change_24h ?? nested.priceChange24h ?? nested.change_24h);

    if (priceChange && typeof priceChange === "object") {
      change1h = change1h ?? num(priceChange["1h"] ?? priceChange.h1);
      change6h = change6h ?? num(priceChange["6h"] ?? priceChange.h6);
      change24h = change24h ?? num(priceChange["24h"] ?? priceChange.h24);
    } else if (typeof priceChange === "number") {
      change24h = change24h ?? priceChange;
    }

    const txns = num(nested.trades_24h ?? nested.txns_24h ?? nested.transactions_24h ?? nested.trades);

    return {
      priceUsd: price,
      marketCap,
      volume24h,
      liquidity,
      change1h,
      change6h,
      change24h,
      ath,
      txns,
    };
  } catch {
    return null;
  }
}
