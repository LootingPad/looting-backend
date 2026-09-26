import type { FastifyInstance } from "fastify";
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

  const snap = (market ?? (await getTokenMarketSnapshot(launch.token))) as MarketEnrichment | null;
  const shaped = toFeLaunch(launch, snap);
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
  app.get("/api/launches", async (req) => {
    const q = req.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const offset = Number(q.offset ?? 0);

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

    return { data, limit, offset };
  });

  app.get("/api/launches/:token", async (req, reply) => {
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
    if (!launch) return reply.code(404).send({ error: "NOT_FOUND" });

    const data = await enrichLaunch(launch);
    return { data };
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
    if (!launch) return reply.code(404).send({ error: "NOT_FOUND" });

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
    if (!launch) return reply.code(404).send({ error: "NOT_FOUND" });

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

    const launches = await prisma.launch.findMany({
      where: { chainId: env.CHAIN_ID, creator },
      orderBy: { launchedAt: "desc" },
    });

    const data = await Promise.all(launches.map((l) => enrichLaunch(l)));
    return { data };
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
    if (!launch) return reply.code(404).send({ error: "NOT_FOUND" });

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
