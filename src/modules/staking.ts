import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";

export async function registerStakingRoutes(app: FastifyInstance) {
  app.get("/api/staking/events", async (req) => {
    const q = req.query as { limit?: string; offset?: string; token?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const offset = Number(q.offset ?? 0);

    const vaults = await prisma.stakingVault.findMany({
      where: {
        chainId: env.CHAIN_ID,
        ...(q.token ? { stakeToken: q.token.trim().toLowerCase() } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    return {
      data: vaults.map((v) => ({
        vaultId: v.vaultId.toString(),
        vaultAddress: v.vaultAddress,
        stakeToken: v.stakeToken,
        creator: v.creator,
        rewardFunded: v.rewardFunded.toString(),
        rewardRemaining: v.rewardRemaining.toString(),
        totalStaked: v.totalStaked.toString(),
        stakerCount: v.stakerCount,
        endsAt: v.endsAt.toISOString(),
        lockMask: v.lockMask,
        aprBps: [v.aprFlexBps, v.apr30Bps, v.apr90Bps],
        status: v.status,
      })),
      limit,
      offset,
    };
  });

  app.get("/api/staking/events/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    const vault = await prisma.stakingVault.findFirst({
      where: {
        chainId: env.CHAIN_ID,
        OR: [{ vaultId: BigInt(vaultId) }, { vaultAddress: vaultId.toLowerCase() }],
      },
    });
    if (!vault) return reply.code(404).send({ error: "NOT_FOUND" });

    return {
      data: {
        vaultId: vault.vaultId.toString(),
        vaultAddress: vault.vaultAddress,
        stakeToken: vault.stakeToken,
        creator: vault.creator,
        rewardFunded: vault.rewardFunded.toString(),
        rewardRemaining: vault.rewardRemaining.toString(),
        totalStaked: vault.totalStaked.toString(),
        stakerCount: vault.stakerCount,
        endsAt: vault.endsAt.toISOString(),
        lockMask: vault.lockMask,
        aprBps: [vault.aprFlexBps, vault.apr30Bps, vault.apr90Bps],
        status: vault.status,
        createTxHash: vault.createTxHash,
      },
    };
  });
}
