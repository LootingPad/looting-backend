import type { FastifyInstance } from "fastify";
import { getTokenMarketSnapshot } from "../clients/mobula.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { normalizeAddress } from "../lib/utils.js";

function serializeLaunch(launch: {
  token: string;
  creator: string;
  curve: string | null;
  pair: string | null;
  phase: string;
  status: string;
  rewardsEnabled: boolean;
  creatorBps: number;
  luckyBoxBps: number;
  totalCreatorFeeBps: number;
  holderShareEnabled: boolean;
  quoteAsset: string | null;
  launchedAt: Date | null;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  description: string | null;
  configHash: string | null;
}) {
  return {
    token: launch.token,
    creator: launch.creator,
    curve: launch.curve,
    pair: launch.pair,
    phase: launch.phase,
    status: launch.status,
    rewardsEnabled: launch.rewardsEnabled,
    creatorBps: launch.creatorBps,
    luckyBoxBps: launch.luckyBoxBps,
    totalCreatorFeeBps: launch.totalCreatorFeeBps,
    holderShareEnabled: launch.holderShareEnabled,
    quoteAsset: launch.quoteAsset,
    launchedAt: launch.launchedAt?.toISOString() ?? null,
    name: launch.name,
    symbol: launch.symbol,
    imageUrl: launch.imageUrl,
    description: launch.description,
    configHash: launch.configHash,
  };
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

    return { data: launches.map(serializeLaunch), limit, offset };
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

    const market = await getTokenMarketSnapshot(normalized);
    return { data: { ...serializeLaunch(launch), market } };
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
    return { data: launches.map(serializeLaunch) };
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
