import { env } from "../config/env.js";
import { TtlCache } from "../lib/utils.js";

const cache = new TtlCache<number>(60_000);
const KEY = "eth-usd";
/** Last successful spot — used only when a fresh fetch fails mid-request. */
let lastGood = 0;

/** Well-known graduated Pons token (docs example) — public `/price` needs no key. */
const PONS_REF_TOKEN = "0x39dBED3a2bd333467115dE45665cC57F813C4571";

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function ethFromPair(priceUsd: number | undefined, priceEth: number | undefined): number | undefined {
  if (priceUsd == null || priceEth == null || !(priceEth > 0) || !(priceUsd > 0)) return undefined;
  const rate = priceUsd / priceEth;
  return rate > 100 && rate < 1_000_000 ? rate : undefined;
}

function ponsBase() {
  return (env.PONSAPI_BASE_URL || "https://api.ponsapi.dev").replace(/\/$/, "");
}

function ponsKey() {
  return env.PONSAPI_API_KEY?.trim() || "";
}

/**
 * Derive ETH/USD from Pons on-chain spot: priceUsd / priceEth.
 * Public `/v1/tokens/{token}/price` first, then authenticated live feed.
 */
async function fromPons(): Promise<number | undefined> {
  const base = ponsBase();

  try {
    const res = await fetch(`${base}/v1/tokens/${PONS_REF_TOKEN}/price`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      const nested = (body.data ?? body) as Record<string, unknown>;
      const rate = ethFromPair(num(nested.priceUsd ?? nested.price_usd), num(nested.priceEth ?? nested.price_eth));
      if (rate) return rate;
    }
  } catch {
    /* try live list next */
  }

  const key = ponsKey();
  if (!key) return undefined;
  try {
    const url = new URL("/v1/tokens", `${base}/`);
    url.searchParams.set("limit", "30");
    url.searchParams.set("minutes", "180");
    const res = await fetch(url, {
      headers: { Accept: "application/json", "x-api-key": key },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tokens?: Array<Record<string, unknown>> };
    for (const row of body.tokens ?? []) {
      const rate = ethFromPair(num(row.priceUsd ?? row.price_usd), num(row.priceEth ?? row.price_eth));
      if (rate) return rate;
      // Some list rows only have USD mcap — skip until we have a paired ETH print.
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Live ETH/USD from Pons (on-chain priceEth + priceUsd). No DexScreener. */
export async function getEthUsd(): Promise<number> {
  const hit = cache.get(KEY);
  if (hit != null && hit > 0) return hit;

  const price = (await fromPons()) ?? lastGood;
  if (price > 0) {
    lastGood = price;
    cache.set(KEY, price);
  }
  return price;
}

/** Sync read of last fetched spot (0 if never resolved). */
export function getEthUsdCached(): number {
  return cache.get(KEY) ?? lastGood;
}
