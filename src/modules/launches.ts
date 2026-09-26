import type { FastifyInstance } from "fastify";
import { getTokenMarketSnapshot } from "../clients/mobula.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { toFeLaunch, toFeMarketStats } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";

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

    return { data: launches.map((l) => toFeLaunch(l)), limit, offset };
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

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [market, txns, tradersRows, volumeAgg] = await Promise.all([
      getTokenMarketSnapshot(normalized),
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

    const shaped = toFeLaunch(launch, market);
    const volumeFromTrades = Number(volumeAgg._sum.usdNotional ?? 0);
    const stats = toFeMarketStats(shaped, {
      launchedAt: launch.launchedAt,
      txns,
      traders: tradersRows.length,
      volume24h: market?.volume24h ?? volumeFromTrades,
      ath: market?.marketCap ?? shaped.marketCap,
    });

    return { data: { ...shaped, stats } };
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
    return { data: launches.map((l) => toFeLaunch(l)) };
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
