/**
 * Pons V2 live Explore feed (Trenches-style New Pair).
 * HTTP bootstrap + WS subscribeNewToken — https://ponsapi.dev/docs#ws
 */
import WebSocket from "ws";
import { env } from "../config/env.js";
import {
  toFeMarketStats,
  type FeLaunch,
} from "../lib/fe-shape.js";
import type { ExploreStage, FeLaunchCard } from "../clients/dexscreener.js";
import { TtlCache } from "../lib/utils.js";

const DEFAULT_BASE = "https://api.ponsapi.dev";
const DEFAULT_WS = "wss://api.ponsapi.dev/v1/ws";
const V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const LIVE_CAP = 250;

type PonsapiListToken = {
  token: string;
  deployer?: string;
  name?: string;
  symbol?: string;
  priceUsd?: number;
  mcapUsd?: number;
};

type PonsapiDetail = {
  token: string;
  name?: string;
  symbol?: string;
  logo?: string | null;
  description?: string;
  deployer?: string;
  factory?: string;
  priceUsd?: number;
  mcapUsd?: number;
  fdvUsd?: number;
  graduated?: boolean;
  readyToGraduate?: boolean;
  graduationThreshold?: number;
  graduationProgress?: number;
  reserves?: { quote?: number; realQuote?: number; phantomQuote?: number };
  fees?: { creatorTaxBps?: number };
  launchedAt?: string;
};

type PonsapiTrade = {
  priceUsd?: number;
  amountUsd?: number;
  trader?: string;
};

function baseUrl() {
  return (env.PONSAPI_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function apiKey() {
  return env.PONSAPI_API_KEY?.trim() || "";
}

export function ponsapiLiveEnabled(): boolean {
  return Boolean(apiKey());
}

async function ponsGet<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("PONSAPI_KEY_MISSING");
  const url = new URL(path, `${baseUrl()}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json", "x-api-key": key },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PONSAPI_${res.status}:${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

function logoToHttp(logo?: string | null): string | undefined {
  if (!logo) return undefined;
  const raw = logo.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${raw.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return undefined;
}

function formatAge(from: Date | null | undefined, now = Date.now()): string {
  if (!from) return "0m";
  const ms = Math.max(0, now - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ponsProgress(detail: PonsapiDetail): number {
  if (detail.graduated) return 100;
  const gp = Number(detail.graduationProgress);
  if (Number.isFinite(gp) && gp > 0) {
    if (gp <= 1) return Math.max(0, Math.min(100, Math.round(gp * 100)));
    if (gp <= 100) return Math.round(gp);
  }
  const threshold = Number(detail.graduationThreshold);
  const real = Number(detail.reserves?.realQuote);
  if (threshold > 0 && real > 0) {
    return Math.max(0, Math.min(100, Math.round((real / threshold) * 100)));
  }
  if (detail.readyToGraduate) return 95;
  return 0;
}

function tradesToStats(trades: PonsapiTrade[], priceUsd: number) {
  const chronological = [...trades].reverse();
  let volume = 0;
  const prices: number[] = [];
  const traders = new Set<string>();
  for (const t of chronological) {
    const usd = Number(t.amountUsd);
    if (Number.isFinite(usd)) volume += Math.abs(usd);
    const p = Number(t.priceUsd);
    if (p > 0) prices.push(p);
    if (t.trader) traders.add(t.trader.toLowerCase());
  }
  let change1h = 0;
  let change24h = 0;
  if (prices.length >= 2) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    if (first > 0) change24h = Number((((last - first) / first) * 100).toFixed(2));
    const a = prices[Math.max(0, prices.length - 4)];
    if (a > 0) change1h = Number((((last - a) / a) * 100).toFixed(2));
  }
  return {
    volume24h: volume,
    txns: trades.length,
    traders: traders.size,
    change1h,
    change24h,
    sparkline: prices.length >= 2 ? prices : priceUsd > 0 ? [priceUsd, priceUsd] : undefined,
  };
}

function detailToCard(detail: PonsapiDetail, trades: PonsapiTrade[]): FeLaunchCard {
  const graduated = Boolean(detail.graduated);
  const progress = ponsProgress(detail);
  const marketCap = Number(detail.mcapUsd ?? 0) || 0;
  const priceUsd = Number(detail.priceUsd ?? 0) || 0;
  const launchedAt = detail.launchedAt ? new Date(detail.launchedAt) : new Date();
  const logoUrl = logoToHttp(detail.logo);
  const creatorTax = detail.fees?.creatorTaxBps != null ? detail.fees.creatorTaxBps / 100 : 1;
  const fromTrades = tradesToStats(trades, priceUsd);

  const launch: FeLaunch = {
    address: (detail.token || "").toLowerCase(),
    name: detail.name || detail.symbol || "Unknown",
    symbol: (detail.symbol || "TOKEN").toUpperCase().slice(0, 16),
    description: detail.description || "",
    creator: (detail.deployer || "0x0000000000000000000000000000000000000000").toLowerCase(),
    marketCap,
    progress,
    change1h: fromTrades.change1h,
    priceUsd,
    luckyShare: 20,
    creatorTax,
    phase: graduated ? "graduated" : "curve",
  };

  const stats = toFeMarketStats(launch, {
    launchedAt,
    txns: fromTrades.txns,
    traders: fromTrades.traders,
    volume24h: fromTrades.volume24h,
    change6h: 0,
    change24h: fromTrades.change24h,
    ath: Math.max(marketCap, Number(detail.fdvUsd) || 0),
  });
  stats.age = formatAge(launchedAt);
  stats.boxUsd =
    marketCap * (creatorTax / 100) * (0.35 + progress / 200) * (launch.luckyShare / 100);

  return {
    ...launch,
    stats,
    ...(logoUrl ? { logoUrl } : {}),
    ...(fromTrades.sparkline ? { sparkline: fromTrades.sparkline } : {}),
  };
}

const detailCache = new TtlCache<PonsapiDetail>(30_000);
const listCache = new TtlCache<PonsapiListToken[]>(15_000);

/** Newest-first live creates from WS (+ HTTP hydrate). */
const liveByToken = new Map<string, FeLaunchCard>();
const liveOrder: string[] = [];
type LiveListener = (card: FeLaunchCard, kind: "new" | "update") => void;
const liveListeners = new Set<LiveListener>();

export function subscribeLiveLaunches(listener: LiveListener): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

function emitLive(card: FeLaunchCard, kind: "new" | "update") {
  for (const listener of liveListeners) {
    try {
      listener(card, kind);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function upsertLive(card: FeLaunchCard) {
  const key = card.address.toLowerCase();
  const prev = liveByToken.get(key);
  // Keep high-water ATH so sparks turn off when mcap drops below peak.
  if (prev) {
    const peak = Math.max(prev.stats.ath || 0, card.stats.ath || 0, prev.marketCap || 0, card.marketCap || 0);
    card = {
      ...card,
      stats: { ...card.stats, ath: peak },
    };
  } else {
    card = {
      ...card,
      stats: { ...card.stats, ath: Math.max(card.stats.ath || 0, card.marketCap || 0) },
    };
  }
  const isNew = !prev;
  liveByToken.set(key, card);
  if (isNew) {
    liveOrder.unshift(key);
    while (liveOrder.length > LIVE_CAP) {
      const drop = liveOrder.pop();
      if (drop) liveByToken.delete(drop);
    }
  } else {
    const idx = liveOrder.indexOf(key);
    if (idx > 0) {
      liveOrder.splice(idx, 1);
      liveOrder.unshift(key);
    }
  }
  emitLive(card, isNew ? "new" : "update");
}

export function getLiveNewPairCards(): FeLaunchCard[] {
  return liveOrder.map((k) => liveByToken.get(k)!).filter(Boolean);
}

async function getDetail(token: string): Promise<PonsapiDetail | null> {
  const key = token.toLowerCase();
  const hit = detailCache.get(key);
  if (hit) return hit;
  try {
    const d = await ponsGet<PonsapiDetail>(`/v1/tokens/${key}`);
    detailCache.set(key, d);
    return d;
  } catch {
    return null;
  }
}

async function getTrades(token: string): Promise<PonsapiTrade[]> {
  try {
    const body = await ponsGet<{ trades?: PonsapiTrade[] }>(`/v1/tokens/${token}/trades`, {
      minutes: 180,
    });
    return Array.isArray(body.trades) ? body.trades : [];
  } catch {
    return [];
  }
}

async function hydrateToken(token: string, seed?: Partial<PonsapiDetail>): Promise<FeLaunchCard | null> {
  const detail =
    (await getDetail(token)) ||
    ({
      token,
      name: seed?.name,
      symbol: seed?.symbol,
      deployer: seed?.deployer,
      priceUsd: seed?.priceUsd,
      mcapUsd: seed?.mcapUsd,
      launchedAt: seed?.launchedAt ?? new Date().toISOString(),
      graduated: false,
    } satisfies PonsapiDetail);

  // Prefer V2 factory when known
  if (detail.factory && detail.factory.toLowerCase() !== V2_FACTORY && !seed) {
    /* still include — user launches may be V1; New Pair shows all pons creates */
  }

  const trades = await getTrades(token);
  return detailToCard(detail, trades);
}

async function listHttpTokens(): Promise<PonsapiListToken[]> {
  const cached = listCache.get("list");
  if (cached) return cached;
  const body = await ponsGet<{ tokens?: PonsapiListToken[] }>("/v1/tokens", {
    limit: 100,
    minutes: 180,
  });
  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  listCache.set("list", tokens);
  return tokens;
}

let ws: WebSocket | null = null;
let wsTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

async function onNewTokenEvent(raw: unknown) {
  const msg = raw as { event?: string; data?: Record<string, unknown> };
  if (msg.event !== "newToken" || !msg.data) return;
  const token = String(msg.data.token ?? msg.data.address ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(token)) return;
  const card = await hydrateToken(token, {
    token,
    name: msg.data.name ? String(msg.data.name) : undefined,
    symbol: msg.data.symbol ? String(msg.data.symbol) : undefined,
    deployer: msg.data.deployer ? String(msg.data.deployer) : undefined,
    launchedAt: new Date().toISOString(),
  });
  if (card) upsertLive(card);
}

function connectWs(log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }) {
  const key = apiKey();
  if (!key) return;

  const url = `${env.PONSAPI_WS_URL || DEFAULT_WS}?api-key=${encodeURIComponent(key)}`;
  try {
    ws?.terminate();
  } catch {
    /* ignore */
  }

  ws = new WebSocket(url);

  ws.on("open", () => {
    log?.info({}, "ponsapi ws connected — subscribeNewToken");
    ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", (buf) => {
    try {
      const raw = JSON.parse(buf.toString());
      void onNewTokenEvent(raw);
    } catch {
      /* ignore bad frames */
    }
  });

  ws.on("close", () => {
    log?.warn({}, "ponsapi ws closed — reconnect in 5s");
    wsTimer = setTimeout(() => connectWs(log), 5000);
  });

  ws.on("error", (err) => {
    log?.warn({ err }, "ponsapi ws error");
  });
}

/** Start WS listener once (call from server boot). */
export function startPonsapiLiveFeed(log?: {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
}) {
  if (started || !ponsapiLiveEnabled()) return;
  started = true;
  connectWs(log);
  // Bootstrap: pull recent HTTP creates into live buffer
  void (async () => {
    try {
      const listed = await listHttpTokens();
      for (const row of listed.slice(0, 40)) {
        const card = await hydrateToken(row.token, {
          token: row.token,
          name: row.name,
          symbol: row.symbol,
          deployer: row.deployer,
          priceUsd: row.priceUsd,
          mcapUsd: row.mcapUsd,
        });
        if (card) upsertLive(card);
      }
      log?.info({ n: liveOrder.length }, "ponsapi live buffer primed");
    } catch (err) {
      log?.warn({ err }, "ponsapi bootstrap failed");
    }
  })();
}

export function stopPonsapiLiveFeed() {
  started = false;
  if (wsTimer) clearTimeout(wsTimer);
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
}

export async function listPonsapiExploreLaunches(opts: {
  limit: number;
  offset: number;
  stage?: ExploreStage;
}): Promise<{ data: FeLaunchCard[]; total: number; source: "ponsapi" }> {
  const stage = opts.stage ?? "new";

  // Refresh HTTP list into buffer (WS also pushes)
  try {
    const listed = await listHttpTokens();
    const missing = listed.filter((t) => !liveByToken.has(t.token.toLowerCase())).slice(0, 20);
    await Promise.all(
      missing.map(async (row) => {
        const card = await hydrateToken(row.token, {
          token: row.token,
          name: row.name,
          symbol: row.symbol,
          deployer: row.deployer,
          priceUsd: row.priceUsd,
          mcapUsd: row.mcapUsd,
        });
        if (card) upsertLive(card);
      }),
    );
  } catch {
    /* keep live buffer */
  }

  let cards = getLiveNewPairCards().filter((c) => c.phase !== "graduated");

  if (stage === "almost") {
    const mid = cards.filter((c) => c.progress >= 50 && c.progress < 100);
    cards =
      mid.length >= 5
        ? mid.sort((a, b) => b.progress - a.progress || b.marketCap - a.marketCap)
        : [...cards].sort((a, b) => b.progress - a.progress || b.marketCap - a.marketCap);
  } else if (stage === "new" || stage === "all") {
    cards = [...cards].sort((a, b) => ageHours(a.stats.age) - ageHours(b.stats.age));
  } else {
    // migrate not served here
    cards = [];
  }

  return {
    data: cards.slice(opts.offset, opts.offset + opts.limit),
    total: cards.length,
    source: "ponsapi",
  };
}

export async function getPonsapiExploreLaunch(token: string): Promise<FeLaunchCard | null> {
  const key = token.toLowerCase();
  const live = liveByToken.get(key);
  if (live) return live;
  return hydrateToken(key);
}

function ageHours(age: string) {
  const value = Number.parseFloat(age);
  if (age.endsWith("m")) return value / 60;
  if (age.endsWith("h")) return value;
  if (age.endsWith("d")) return value * 24;
  return value;
}
