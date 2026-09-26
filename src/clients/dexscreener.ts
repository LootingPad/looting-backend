/**
 * Free DexScreener HTTP (no key) — Explore feed for Robinhood chain.
 * https://docs.dexscreener.com/api/reference
 */
import {
  toFeMarketStats,
  type FeLaunch,
  type FeMarketStats,
} from "../lib/fe-shape.js";
import { TtlCache } from "../lib/utils.js";

const BASE = "https://api.dexscreener.com";
const CHAIN = "robinhood";
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://dexscreener.com/",
} as const;

export type ExploreStage = "new" | "almost" | "migrate" | "all";

export type FeLaunchCard = FeLaunch & {
  stats: FeMarketStats;
  logoUrl?: string;
  sparkline?: number[];
};

export type DexPairSnapshot = {
  priceUsd?: number;
  marketCap?: number;
  volume24h?: number;
  volume1h?: number;
  change1h?: number;
  change6h?: number;
  change24h?: number;
  txns24h?: number;
  txns1h?: number;
  liquidity?: number;
  pairCreatedAt?: number;
  sparkline?: number[];
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  info?: {
    imageUrl?: string;
    header?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
};

const snapCache = new TtlCache<DexPairSnapshot | null>(45_000);
/** Peak mcap seen per token — ATH must not collapse when price dips. */
const athPeaks = new Map<string, number>();
/** Fresh window — after this we revalidate in background. */
const FEED_FRESH_MS = 25_000;
/** Serve last good snapshot up to this long if Dex blips. */
const FEED_STALE_MS = 15 * 60_000;

type FeedBundle = {
  at: number;
  byStage: Record<ExploreStage, FeLaunchCard[]>;
};

let feedBundle: FeedBundle | null = null;
let feedInflight: Promise<FeedBundle> | null = null;

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function txnCount(bucket?: { buys?: number; sells?: number }): number {
  return (bucket?.buys ?? 0) + (bucket?.sells ?? 0);
}

async function dexGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.trimStart().startsWith("<")) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function pickRobinhoodPair(pairs: DexPair[]): DexPair | null {
  if (!pairs.length) return null;
  const rh = pairs.filter((p) => (p.chainId || "").toLowerCase() === CHAIN);
  const pool = rh.length ? rh : pairs.filter((p) => (p.chainId || "").toLowerCase() === CHAIN);
  if (!pool.length) return null;
  return [...pool].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

function sparkFromChanges(price: number, ch: { h1?: number; h6?: number; h24?: number }): number[] {
  const back = (pct: number | undefined) => {
    if (pct == null || !Number.isFinite(pct)) return undefined;
    const factor = 1 + pct / 100;
    if (!(factor > 0)) return undefined;
    return price / factor;
  };
  const pts = [back(ch.h24), back(ch.h6), back(ch.h1), price].filter(
    (n): n is number => n != null && n > 0,
  );
  return pts.length >= 2 ? pts : [price, price];
}

function pairToSnapshot(pair: DexPair): DexPairSnapshot {
  const priceUsd = num(pair.priceUsd);
  const change1h = num(pair.priceChange?.h1);
  const change6h = num(pair.priceChange?.h6);
  const change24h = num(pair.priceChange?.h24);
  return {
    priceUsd,
    marketCap: num(pair.marketCap) ?? num(pair.fdv),
    volume24h: num(pair.volume?.h24),
    volume1h: num(pair.volume?.h1),
    change1h,
    change6h,
    change24h,
    txns24h: txnCount(pair.txns?.h24) || undefined,
    txns1h: txnCount(pair.txns?.h1) || undefined,
    liquidity: num(pair.liquidity?.usd),
    pairCreatedAt: pair.pairCreatedAt,
    sparkline: priceUsd
      ? sparkFromChanges(priceUsd, { h1: change1h, h6: change6h, h24: change24h })
      : undefined,
  };
}

export async function getDexTokenSnapshot(tokenAddress: string): Promise<DexPairSnapshot | null> {
  const key = tokenAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(key)) return null;
  const cached = snapCache.get(key);
  if (cached !== undefined) return cached;

  const body = await dexGet<{ pairs?: DexPair[] | null }>(`/latest/dex/tokens/${key}`);
  const pair = pickRobinhoodPair(body?.pairs ?? []);
  const snap = pair ? pairToSnapshot(pair) : null;
  snapCache.set(key, snap);
  return snap;
}

export async function getDexTokenSnapshots(
  addresses: string[],
  concurrency = 4,
): Promise<Map<string, DexPairSnapshot>> {
  const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, DexPairSnapshot>();
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const idx = i++;
      const addr = unique[idx];
      const snap = await getDexTokenSnapshot(addr);
      if (snap) out.set(addr, snap);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()));
  return out;
}

function formatAge(createdAtMs: number | undefined, now = Date.now()): string {
  if (!createdAtMs) return "0m";
  const ms = Math.max(0, now - createdAtMs);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Soft “bonding” progress from liquidity (DEX has no curve). */
function liqProgress(liquidityUsd: number): number {
  const target = 50_000;
  return Math.max(0, Math.min(100, Math.round((liquidityUsd / target) * 100)));
}

function pairToCard(pair: DexPair): FeLaunchCard | null {
  const address = (pair.baseToken?.address || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return null;

  const snap = pairToSnapshot(pair);
  const marketCap = snap.marketCap ?? 0;
  const priceUsd = snap.priceUsd ?? 0;
  const liquidity = snap.liquidity ?? 0;
  const progress = liqProgress(liquidity);
  const graduated = progress >= 100 || liquidity >= 50_000;
  const logoUrl = pair.info?.imageUrl;
  const createdAt = snap.pairCreatedAt ? new Date(snap.pairCreatedAt) : null;

  const websites = pair.info?.websites?.map((w) => w.url).filter(Boolean) ?? [];
  const socials = pair.info?.socials?.map((s) => s.url).filter(Boolean) ?? [];
  const description = [...websites, ...socials].filter(Boolean).join(" · ");

  const launch: FeLaunch = {
    address,
    name: pair.baseToken?.name || pair.baseToken?.symbol || "Unknown",
    symbol: (pair.baseToken?.symbol || "TOKEN").toUpperCase().slice(0, 16),
    description,
    creator: "0x0000000000000000000000000000000000000000",
    marketCap,
    progress: graduated ? 100 : progress,
    change1h: snap.change1h ?? 0,
    priceUsd,
    luckyShare: 20,
    creatorTax: 1,
    phase: graduated ? "graduated" : "curve",
  };

  const peak = Math.max(athPeaks.get(address) ?? 0, marketCap);
  if (peak > 0) athPeaks.set(address, peak);

  const stats = toFeMarketStats(launch, {
    launchedAt: createdAt,
    txns: snap.txns24h ?? 0,
    traders: 0,
    volume24h: snap.volume24h ?? 0,
    change6h: snap.change6h ?? 0,
    change24h: snap.change24h ?? 0,
    ath: peak,
  });
  stats.age = formatAge(snap.pairCreatedAt);
  stats.boxUsd =
    marketCap * (launch.creatorTax / 100) * (0.35 + launch.progress / 200) * (launch.luckyShare / 100);

  return {
    ...launch,
    stats,
    ...(logoUrl ? { logoUrl } : {}),
    ...(snap.sparkline ? { sparkline: snap.sparkline } : priceUsd > 0 ? { sparkline: [priceUsd, priceUsd] } : {}),
  };
}

async function discoverRobinhoodAddresses(): Promise<string[]> {
  const addrs = new Set<string>();

  const [profiles, boostsTop, boostsLatest] = await Promise.all([
    dexGet<Array<{ chainId?: string; tokenAddress?: string }>>("/token-profiles/latest/v1"),
    dexGet<Array<{ chainId?: string; tokenAddress?: string }>>("/token-boosts/top/v1"),
    dexGet<Array<{ chainId?: string; tokenAddress?: string }>>("/token-boosts/latest/v1"),
  ]);

  for (const row of [...(profiles ?? []), ...(boostsTop ?? []), ...(boostsLatest ?? [])]) {
    if ((row.chainId || "").toLowerCase() === CHAIN && row.tokenAddress) {
      addrs.add(row.tokenAddress.toLowerCase());
    }
  }

  const queries = ["WETH", "ETH", "USDC", "PONS", "meme", "robin", "acc", "doom"];
  await Promise.all(
    queries.map(async (q) => {
      const body = await dexGet<{ pairs?: DexPair[] }>(`/latest/dex/search?q=${encodeURIComponent(q)}`);
      for (const pair of body?.pairs ?? []) {
        if ((pair.chainId || "").toLowerCase() !== CHAIN) continue;
        const a = pair.baseToken?.address;
        if (a) addrs.add(a.toLowerCase());
      }
    }),
  );

  return [...addrs];
}

async function loadRobinhoodPairs(): Promise<DexPair[]> {
  let addrs = await discoverRobinhoodAddresses();
  // One retry if discovery came back empty (rate limit / CF blip).
  if (addrs.length === 0) {
    await new Promise((r) => setTimeout(r, 400));
    addrs = await discoverRobinhoodAddresses();
  }
  const byToken = new Map<string, DexPair>();
  let i = 0;
  const concurrency = 5;

  async function worker() {
    while (i < addrs.length) {
      const idx = i++;
      const addr = addrs[idx];
      const body = await dexGet<{ pairs?: DexPair[] }>(`/latest/dex/tokens/${addr}`);
      const pair = pickRobinhoodPair(body?.pairs ?? []);
      if (pair?.baseToken?.address) {
        byToken.set(pair.baseToken.address.toLowerCase(), pair);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, addrs.length || 1) }, () => worker()));
  return [...byToken.values()];
}

async function buildFeedBundle(): Promise<FeedBundle> {
  const pairs = await loadRobinhoodPairs();
  const pairsByAddr = new Map(
    pairs
      .filter((p) => p.baseToken?.address)
      .map((p) => [p.baseToken!.address!.toLowerCase(), p] as const),
  );
  const allCards = pairs
    .map(pairToCard)
    .filter((c): c is FeLaunchCard => c != null)
    .sort((a, b) => (b.stats.volume24h || 0) - (a.stats.volume24h || 0));

  // Never publish an empty bundle over a good cache (Dex flakiness).
  if (allCards.length === 0 && feedBundle && feedBundle.byStage.all.length > 0) {
    return feedBundle;
  }

  const byStage = {
    all: filterByStage(allCards, pairsByAddr, "all"),
    new: filterByStage(allCards, pairsByAddr, "new"),
    almost: filterByStage(allCards, pairsByAddr, "almost"),
    migrate: filterByStage(allCards, pairsByAddr, "migrate"),
  } satisfies Record<ExploreStage, FeLaunchCard[]>;

  return { at: Date.now(), byStage };
}

async function getFeedBundle(force = false): Promise<FeedBundle> {
  const now = Date.now();
  if (!force && feedBundle && now - feedBundle.at < FEED_FRESH_MS) {
    return feedBundle;
  }

  if (feedInflight) return feedInflight;

  feedInflight = (async () => {
    try {
      const next = await buildFeedBundle();
      if (next.byStage.all.length > 0) {
        feedBundle = next;
      } else if (!feedBundle) {
        feedBundle = next;
      }
      return feedBundle!;
    } finally {
      feedInflight = null;
    }
  })();

  // Stale-while-revalidate: if we have something, return it immediately while refresh runs.
  if (!force && feedBundle && now - feedBundle.at < FEED_STALE_MS) {
    void feedInflight;
    return feedBundle;
  }

  return feedInflight;
}

/** Full Explore page from DexScreener Robinhood pairs + metadata. */
export async function listDexExploreLaunches(opts: {
  limit: number;
  offset: number;
  stage?: ExploreStage;
}): Promise<{ data: FeLaunchCard[]; total: number; source: "dexscreener" }> {
  const stage = opts.stage ?? "all";
  const bundle = await getFeedBundle();
  const cards = bundle.byStage[stage] ?? bundle.byStage.all;
  const total = cards.length;
  return {
    data: cards.slice(opts.offset, opts.offset + opts.limit),
    total,
    source: "dexscreener",
  };
}

function ageMs(pair: DexPair, now = Date.now()): number {
  return pair.pairCreatedAt ? Math.max(0, now - pair.pairCreatedAt) : Number.POSITIVE_INFINITY;
}

function filterByStage(cards: FeLaunchCard[], pairsByAddr: Map<string, DexPair>, stage: ExploreStage): FeLaunchCard[] {
  // Full list every stage (sorted differently) so Explore table can paginate 14/page.
  if (stage === "all") {
    return [...cards].sort(
      (a, b) => (b.stats.volume24h || 0) - (a.stats.volume24h || 0) || b.marketCap - a.marketCap,
    );
  }

  const now = Date.now();
  const withMeta = cards.map((c) => {
    const pair = pairsByAddr.get(c.address);
    return {
      card: c,
      age: pair ? ageMs(pair, now) : Number.POSITIVE_INFINITY,
      liq: pair?.liquidity?.usd ?? 0,
    };
  });

  if (stage === "new") {
    return [...withMeta].sort((a, b) => a.age - b.age).map((x) => x.card);
  }

  if (stage === "almost") {
    return [...withMeta]
      .sort((a, b) => {
        const score = (c: FeLaunchCard) =>
          (c.stats.volume24h || 0) + Math.abs(c.change1h || 0) * 100 + Math.abs(c.stats.change24h || 0) * 50;
        // Prefer younger + hot, but keep full set for pagination
        const ageBias = (age: number) => (age < 48 * 3_600_000 ? 1 : 0.35);
        return score(b.card) * ageBias(b.age) - score(a.card) * ageBias(a.age);
      })
      .map((x) => x.card);
  }

  // migrate — established / high volume first, full set
  return [...withMeta]
    .sort(
      (a, b) =>
        (b.card.stats.volume24h || 0) - (a.card.stats.volume24h || 0) ||
        b.liq - a.liq ||
        b.card.marketCap - a.card.marketCap,
    )
    .map((x) => x.card);
}

export async function getDexExploreLaunch(token: string): Promise<FeLaunchCard | null> {
  const key = token.trim().toLowerCase();
  const body = await dexGet<{ pairs?: DexPair[] }>(`/latest/dex/tokens/${key}`);
  const pair = pickRobinhoodPair(body?.pairs ?? []);
  return pair ? pairToCard(pair) : null;
}
