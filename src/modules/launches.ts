import type { FastifyInstance } from "fastify";
import {
  getDexExploreLaunch,
  listDexExploreLaunches,
  type ExploreStage,
  type FeLaunchCard,
} from "../clients/dexscreener.js";
import { getTokenMarketSnapshot } from "../clients/mobula.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  rawToUiAmount,
  toFeHolder,
  toFeLaunch,
  toFeMarketStats,
  toFeTokenTrade,
  type FeHolder,
  type FeLaunch,
  type MarketEnrichment,
} from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import {
  getPonsapiExploreLaunch,
  listPonsapiExploreLaunches,
  ponsapiLiveEnabled,
  subscribeLiveLaunches,
} from "../pons-adapter/live-feed.js";

/** Fill missing price/mcap/volume from DexScreener; keep better activity counts. */
function mergeLaunchMarket(primary: FeLaunchCard, market: FeLaunchCard): FeLaunchCard {
  const priceUsd = (primary.priceUsd ?? 0) > 0 ? primary.priceUsd : market.priceUsd;
  const marketCap = (primary.marketCap ?? 0) > 0 ? primary.marketCap : market.marketCap;

  return {
    ...primary,
    marketCap,
    priceUsd,
    change1h:
      (primary.change1h ?? 0) !== 0 ? primary.change1h : (market.change1h ?? primary.change1h),
    progress: Math.max(primary.progress ?? 0, market.progress ?? 0),
    phase: primary.phase === "graduated" || market.phase === "graduated" ? "graduated" : primary.phase,
    logoUrl: primary.logoUrl || market.logoUrl,
    sparkline:
      market.sparkline && market.sparkline.length > 0 ? market.sparkline : primary.sparkline,
    stats: {
      age: primary.stats?.age || market.stats?.age || "—",
      txns: Math.max(primary.stats?.txns ?? 0, market.stats?.txns ?? 0),
      volume24h: Math.max(primary.stats?.volume24h ?? 0, market.stats?.volume24h ?? 0),
      traders: Math.max(primary.stats?.traders ?? 0, market.stats?.traders ?? 0),
      change6h:
        (market.stats?.change6h ?? 0) !== 0
          ? (market.stats?.change6h ?? 0)
          : (primary.stats?.change6h ?? 0),
      change24h:
        (market.stats?.change24h ?? 0) !== 0
          ? (market.stats?.change24h ?? 0)
          : (primary.stats?.change24h ?? 0),
      ath: Math.max(
        market.stats?.ath ?? 0,
        marketCap ?? 0,
        // only trust primary ATH if it already had a real price
        (primary.priceUsd ?? 0) > 0 ? (primary.stats?.ath ?? 0) : 0,
      ),
      boxUsd: Math.max(primary.stats?.boxUsd ?? 0, market.stats?.boxUsd ?? 0),
    },
  };
}
async function enrichLaunch(
  launch: {
    id: string;
    token: string;
    creator: string;
    phase: string;
    luckyBoxBps: number;
    totalCreatorFeeBps: number;
    name: string | null;
    symbol: string | null;
    description: string | null;
    launchedAt: Date | null;
  },
  market?: MarketEnrichment | null,
): Promise<FeLaunch & { stats: ReturnType<typeof toFeMarketStats> }> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [txns, tradersRows, volumeAgg] = await Promise.all([
    prisma.trade.count({ where: { launchId: launch.id } }),
    prisma.trade.findMany({
      where: { launchId: launch.id },
      distinct: ["trader"],
      select: { trader: true },
    }),
    prisma.trade.aggregate({
      where: { launchId: launch.id, timestamp: { gte: since24h } },
      _sum: { usdNotional: true },
    }),
  ]);

  const snap = (market ?? (await getTokenMarketSnapshot(launch.token))) as
    | (MarketEnrichment & { progress?: number })
    | null;
  const shaped = toFeLaunch(launch, snap);
  if (snap?.progress != null && shaped.phase !== "graduated") {
    shaped.progress = Math.max(0, Math.min(100, Math.round(snap.progress)));
  }
  const volumeFromTrades = Number(volumeAgg._sum.usdNotional ?? 0);
  const stats = toFeMarketStats(shaped, {
    launchedAt: launch.launchedAt,
    txns,
    traders: tradersRows.length,
    volume24h: snap?.volume24h ?? volumeFromTrades,
    change6h: snap?.change6h,
    change24h: snap?.change24h,
    ath: snap?.ath ?? snap?.marketCap ?? shaped.marketCap,
  });
  return { ...shaped, stats };
}

/** Approximate holders from net buy−sell token flow per trader. */
async function holdersFromTrades(
  launchId: string,
  priceUsd: number,
): Promise<FeHolder[]> {
  const trades = await prisma.trade.findMany({
    where: {
      launchId,
      confirmationState: { in: ["CONFIRMED", "FINALIZED", "PENDING"] },
    },
    select: {
      trader: true,
      direction: true,
      tokenAmount: true,
      effectivePrice: true,
    },
  });

  const net = new Map<string, { amount: number; weightedEntry: number; weight: number }>();
  for (const t of trades) {
    const amt = rawToUiAmount(t.tokenAmount);
    const side = t.direction.toLowerCase();
    const signed = side === "sell" || side === "exit" || side === "ask" ? -amt : amt;
    const entry = t.effectivePrice != null ? Number(String(t.effectivePrice)) : priceUsd;
    const cur = net.get(t.trader) ?? { amount: 0, weightedEntry: 0, weight: 0 };
    cur.amount += signed;
    if (signed > 0 && entry > 0) {
      cur.weightedEntry += entry * signed;
      cur.weight += signed;
    }
    net.set(t.trader, cur);
  }

  const positive = [...net.entries()]
    .map(([address, row]) => ({
      address,
      amount: row.amount,
      entry: row.weight > 0 ? row.weightedEntry / row.weight : priceUsd,
    }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const total = positive.reduce((sum, row) => sum + row.amount, 0);
  return positive.slice(0, 100).map((row, index) =>
    toFeHolder({
      rank: index + 1,
      address: row.address,
      amount: row.amount,
      share: total > 0 ? (row.amount / total) * 100 : 0,
      entry: Math.max(row.entry, priceUsd * 0.2 || 0),
    }),
  );
}

export async function registerLaunchRoutes(app: FastifyInstance) {
  /** SSE: push new Pons creates to Explore New Pair in realtime. */
  app.get("/api/explore/stream", async (req, reply) => {
    if (!ponsapiLiveEnabled()) {
      return reply.code(503).send({ error: "PONSAPI_DISABLED" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": env.CORS_ORIGIN.split(",")[0]?.trim() || "*",
    });
    reply.raw.write(": connected\n\n");

    const send = (event: string, payload: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const unsub = subscribeLiveLaunches((card, kind) => {
      send(kind === "new" ? "newToken" : "tokenUpdate", card);
    });

    const ping = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 15_000);

    const close = () => {
      clearInterval(ping);
      unsub();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
  });

  app.get("/api/launches", async (req) => {
    const q = req.query as { limit?: string; offset?: string; status?: string; stage?: string };
    const limit = Math.min(Number(q.limit ?? 50), 500);
    const offset = Number(q.offset ?? 0);
    const stageRaw = (q.stage ?? "all").toLowerCase();
    const stage: ExploreStage =
      stageRaw === "new" || stageRaw === "almost" || stageRaw === "migrate" || stageRaw === "all"
        ? stageRaw
        : "all";

    // New Pair / Almost → ponsapi live. Never pad empty boards with DexScreener.
    if (ponsapiLiveEnabled() && (stage === "new" || stage === "almost" || stage === "all")) {
      try {
        const { data, total, source } = await listPonsapiExploreLaunches({ limit, offset, stage });
        return { data, limit, offset, total, stage, source };
      } catch (err) {
        req.log.warn({ err }, "ponsapi explore feed failed; falling back to db");
      }
    }

    if (env.ENABLE_DEXSCREENER_FEED && stage === "migrate") {
      try {
        const { data, total, source } = await listDexExploreLaunches({ limit, offset, stage });
        return { data, limit, offset, total, stage, source };
      } catch (err) {
        req.log.warn({ err }, "dexscreener migrate feed failed; falling back to db");
      }
    }

    const launches = await prisma.launch.findMany({
      where: {
        chainId: env.CHAIN_ID,
        ...(q.status ? { status: q.status as "active" | "paused" | "archived" } : {}),
      },
      orderBy: { launchedAt: "desc" },
      take: limit,
      skip: offset,
    });

    const uniqueTokens = [...new Set(launches.map((l) => l.token))];
    const marketByToken = new Map<string, MarketEnrichment>();
    await Promise.all(
      uniqueTokens.map(async (token) => {
        const snap = await getTokenMarketSnapshot(token);
        if (snap) marketByToken.set(token, snap);
      }),
    );

    const data = await Promise.all(
      launches.map((l) => enrichLaunch(l, marketByToken.get(l.token) ?? null)),
    );

    return { data, limit, offset, source: "db" };
  });

  app.get("/api/launches/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    let normalized: string;
    try {
      normalized = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    if (ponsapiLiveEnabled()) {
      try {
        const pons = await getPonsapiExploreLaunch(normalized);
        if (pons) {
          const thinMarket =
            (pons.priceUsd ?? 0) <= 0 ||
            (pons.marketCap ?? 0) <= 0 ||
            ((pons.stats?.volume24h ?? 0) <= 0 && (pons.stats?.txns ?? 0) <= 0);
          if (thinMarket && env.ENABLE_DEXSCREENER_FEED) {
            try {
              const dex = await getDexExploreLaunch(normalized);
              if (dex) {
                return { data: mergeLaunchMarket(pons, dex), source: "ponsapi+dex" };
              }
            } catch (err) {
              req.log.warn({ err }, "dexscreener enrich after ponsapi failed");
            }
          }
          return { data: pons, source: "ponsapi" };
        }
      } catch (err) {
        req.log.warn({ err }, "ponsapi token lookup failed");
      }
    }

    if (env.ENABLE_DEXSCREENER_FEED) {
      try {
        const dex = await getDexExploreLaunch(normalized);
        if (dex) return { data: dex, source: "dexscreener" };
      } catch (err) {
        req.log.warn({ err }, "dexscreener token lookup failed");
      }
    }

    const launch = await prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token: normalized } },
    });
    if (!launch) return reply.code(404).send({ error: "NOT_FOUND" });

    const data = await enrichLaunch(launch);
    return { data, source: "db" };
  });

  app.get("/api/launches/:token/trades", async (req, reply) => {
    const { token } = req.params as { token: string };
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const offset = Number(q.offset ?? 0);

    let normalized: string;
    try {
      normalized = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const launch = await prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token: normalized } },
    });
    if (!launch) return { data: [], limit, offset };

    const trades = await prisma.trade.findMany({
      where: {
        launchId: launch.id,
        confirmationState: { in: ["CONFIRMED", "FINALIZED", "PENDING"] },
      },
      orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }],
      take: limit,
      skip: offset,
    });

    return {
      data: trades.map((t) => toFeTokenTrade(t)),
      limit,
      offset,
    };
  });

  app.get("/api/launches/:token/holders", async (req, reply) => {
    const { token } = req.params as { token: string };
    let normalized: string;
    try {
      normalized = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const launch = await prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token: normalized } },
    });
    if (!launch) return { data: [] };

    const market = await getTokenMarketSnapshot(normalized);
    const shaped = toFeLaunch(launch, market);
    const data = await holdersFromTrades(launch.id, shaped.priceUsd);
    return { data };
  });

  app.get("/api/creator/:address/launches", async (req, reply) => {
    const { address } = req.params as { address: string };
    let creator: string;
    try {
      creator = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    if (env.ENABLE_DEXSCREENER_FEED) {
      try {
        const { data } = await listDexExploreLaunches({ limit: 500, offset: 0, stage: "all" });
        return {
          data: data.filter((l) => l.creator.toLowerCase() === creator),
          source: "dexscreener",
        };
      } catch {
        /* fall through */
      }
    }

    const launches = await prisma.launch.findMany({
      where: { chainId: env.CHAIN_ID, creator },
      orderBy: { launchedAt: "desc" },
    });

    const data = await Promise.all(launches.map((l) => enrichLaunch(l)));
    return { data, source: "db" };
  });

  app.get("/api/launch/:token/rewards", async (req, reply) => {
    const { token } = req.params as { token: string };
    let normalized: string;
    try {
      normalized = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const launch = await prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token: normalized } },
    });
    if (!launch) return { data: [] };

    const rewards = await prisma.reward.findMany({
      where: { launchId: launch.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return {
      data: rewards.map((r) => ({
        id: r.id,
        rewardType: r.rewardType,
        token: r.token,
        amount: r.amount?.toString() ?? null,
        status: r.status,
        swapTxHash: r.swapTxHash,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
