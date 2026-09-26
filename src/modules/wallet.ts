import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  toFeDevLock,
  toFeLuckyBox,
  toFeStakingPosition,
  toFeWallet,
} from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import { getCurrentSeason } from "../services/xp.js";

export async function registerWalletRoutes(app: FastifyInstance) {
  app.get("/api/wallet/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    const season = await getCurrentSeason();
    let seasonXp = 0n;
    let tier = "bronze";
    let rank: number | null = null;
    let tradeCount = 0;

    if (user && season) {
      const stats = await prisma.seasonWalletStat.findUnique({
        where: { seasonId_walletId: { seasonId: season.id, walletId: user.id } },
      });
      if (stats) {
        seasonXp = stats.xp;
        tier = stats.tier;
        rank = stats.rank;
        tradeCount = stats.tradeCount;
      }
    }

    const boxesAvailable = user
      ? await prisma.luckyBox.count({
          where: { walletId: user.id, status: { in: ["unclaimed", "in_market"] } },
        })
      : 0;

    return {
      data: toFeWallet({
        wallet,
        tier,
        seasonXp,
        tradeCount: tradeCount || (user?.lifetimeTradeCount ?? 0),
        lifetimeXp: user?.lifetimeXp ?? 0n,
        lifetimeTradeCount: user?.lifetimeTradeCount ?? 0,
        lifetimeBoxCount: user?.lifetimeBoxCount ?? 0,
        luckyBoxesAvailable: boxesAvailable,
        rank,
        seasonId: season?.seasonId ?? null,
      }),
    };
  });

  app.get("/api/wallet/:address/rewards", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    if (!user) return { data: [] };

    const rewards = await prisma.reward.findMany({
      where: { walletId: user.id },
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

  app.get("/api/wallet/:address/lucky-boxes", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    if (!user) return { data: [] };

    const boxes = await prisma.luckyBox.findMany({
      where: { walletId: user.id },
      include: { launch: true, rewards: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return {
      data: boxes.map((b) => toFeLuckyBox(b, b.launch?.symbol ?? "")),
    };
  });

  app.get("/api/wallet/:address/staking-positions", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const positions = await prisma.stakingPosition.findMany({
      where: { walletAddress: wallet },
      include: { vault: { include: { launch: true } } },
      orderBy: { updatedAt: "desc" },
    });

    return {
      data: positions.map((p) =>
        toFeStakingPosition(p, p.vault, {
          name: p.vault.launch?.name,
          symbol: p.vault.launch?.symbol,
          claimable: 0,
        }),
      ),
    };
  });

  app.get("/api/wallet/:address/dev-locks", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const locks = await prisma.devLock.findMany({
      where: { chainId: env.CHAIN_ID, owner: wallet },
      include: { launch: true },
      orderBy: { createdAt: "desc" },
    });

    return {
      data: locks.map((l) =>
        toFeDevLock(l, {
          name: l.launch?.name,
          symbol: l.launch?.symbol,
        }),
      ),
    };
  });
}
