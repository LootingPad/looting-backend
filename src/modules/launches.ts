import type { FastifyInstance } from "fastify";
import { getEthUsd } from "../clients/eth-price.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  rawToUiAmount,
  toFeHolder,
  toFeLaunch,
  toFeMarketStats,
  toFeTokenTrade,
  type ExploreStage,
  type FeHolder,
  type FeLaunch,
  type FeLaunchCard,
  type MarketEnrichment,
} from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import {
  getPonsapiExploreLaunch,
  listPonsapiExploreLaunches,
  ponsapiLiveEnabled,
  subscribeLiveLaunches,
} from "../pons-adapter/live-feed.js";

/** Prefer DB / trench logo when live feeds omit the image. */
async function withDbLogo(token: string, card: FeLaunchCard): Promise<FeLaunchCard> {
  if (card.logoUrl) return card;
  const [launch, trench] = await Promise.all([
    prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      select: { imageUrl: true },
    }),
    prisma.trenchPair.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      select: { logo: true },
    }),
  ]);
  const logoUrl = (launch?.imageUrl || trench?.logo || "").trim();
  if (!logoUrl) return card;
  return { ...card, logoUrl };
}

/** Overlay LOOTING registry tax / lucky split onto a Pons live card. */
function withRegistrySplit(
  card: FeLaunchCard,
  launch: {
    token?: string;
    creator: string;
    phase?: string;
    luckyBoxBps: number;
    totalCreatorFeeBps: number;
    name: string | null;
    symbol: string | null;
    description: string | null;
    imageUrl?: string | null;
  },
): FeLaunchCard {
  const shaped = toFeLaunch({
    token: launch.token ?? card.address,
    creator: launch.creator,
    phase: launch.phase ?? card.phase,
    luckyBoxBps: launch.luckyBoxBps,
    totalCreatorFeeBps: launch.totalCreatorFeeBps,
    name: launch.name,
    symbol: launch.symbol,
    description: launch.description,
    imageUrl: launch.imageUrl,
  });
  return {
    ...card,
    creator: shaped.creator || card.creator,
    name: shaped.name || card.name,
    symbol: shaped.symbol || card.symbol,
    description: shaped.description || card.description,
    luckyShare: shaped.luckyShare,
    creatorTax: shaped.creatorTax > 0 ? shaped.creatorTax : card.creatorTax,
    logoUrl: card.logoUrl || shaped.logoUrl,
    stats: {
      ...card.stats,
      boxUsd:
        card.stats.volume24h > 0 && shaped.creatorTax > 0
          ? toFeMarketStats(
              { ...card, luckyShare: shaped.luckyShare, creatorTax: shaped.creatorTax },
              { volume24h: card.stats.volume24h },
            ).boxUsd
          : card.stats.boxUsd,
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
    imageUrl?: string | null;
    launchedAt: Date | null;
  },
): Promise<FeLaunch & { stats: ReturnType<typeof toFeMarketStats>; sparkline?: number[] }> {
  // Prefer Pons live / on-chain card over third-party market APIs.
  if (ponsapiLiveEnabled()) {
    try {
      const pons = await getPonsapiExploreLaunch(launch.token);
      if (pons) {
        const merged = withRegistrySplit(await withDbLogo(launch.token, pons), launch);
        return merged;
      }
    } catch {
      /* fall through to indexed trades */
    }
  }

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

  const shaped = toFeLaunch(launch);
  const volumeFromTrades = Number(volumeAgg._sum.usdNotional ?? 0);
  const stats = toFeMarketStats(shaped, {
    launchedAt: launch.launchedAt,
    txns,
    traders: tradersRows.length,
    volume24h: volumeFromTrades,
    ath: shaped.marketCap,
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
      entry: row.entry > 0 ? row.entry : 0,
    }),
  );
}

export async function registerLaunchRoutes(app: FastifyInstance) {
  /** SSE: push new Pons creates to Explore New Pair in realtime. */
  app.get("/api/explore/stream", async (req, reply) => {
    if (!ponsapiLiveEnabled()) {
      return reply.code(503).send({ error: "PONSAPI_DISABLED" });
    }

    const requestOrigin = String(req.headers.origin || "");
    const allowed = new Set(
      [
        ...env.CORS_ORIGIN.split(",").map((s) => s.trim()),
        "https://looting-web-production.up.railway.app",
        "https://looting-admin-production.up.railway.app",
      ].filter(Boolean),
    );
    const allowOrigin =
      allowed.has("*") || (requestOrigin && allowed.has(requestOrigin))
        ? requestOrigin || "*"
        : "https://looting-web-production.up.railway.app";

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
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

    // All Explore stages from Pons live / on-chain — never DexScreener.
    if (ponsapiLiveEnabled()) {
      try {
        const { data, total, source } = await listPonsapiExploreLaunches({ limit, offset, stage });
        return { data, limit, offset, total, stage, source };
      } catch (err) {
        req.log.warn({ err }, "ponsapi explore feed failed; falling back to db");
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

    const data = await Promise.all(launches.map((l) => enrichLaunch(l)));
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
          const launch = await prisma.launch.findUnique({
            where: { chainId_token: { chainId: env.CHAIN_ID, token: normalized } },
          });
          const card = launch ? withRegistrySplit(pons, launch) : pons;
          return { data: await withDbLogo(normalized, card), source: "ponsapi" };
        }
      } catch (err) {
        req.log.warn({ err }, "ponsapi token lookup failed");
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

    const ethUsd = await getEthUsd();
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
      data: trades.map((t) => toFeTokenTrade(t, ethUsd)),
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

    let priceUsd = 0;
    if (ponsapiLiveEnabled()) {
      try {
        const pons = await getPonsapiExploreLaunch(normalized);
        priceUsd = pons?.priceUsd ?? 0;
      } catch {
        /* indexed entry prices only */
      }
    }
    const shaped = toFeLaunch(launch, priceUsd > 0 ? ({ priceUsd } satisfies MarketEnrichment) : null);
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
