import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { lockIdToFe, rawToUiAmount, toFeDevLock } from "../lib/fe-shape.js";

function parseSince(raw?: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function registerFeedRoutes(app: FastifyInstance) {
  app.get("/api/feed/devlocks", async (req, reply) => {
    const q = req.query as { since?: string; limit?: string };
    const since = parseSince(q.since);
    if (q.since && !since) {
      return reply.code(400).send({ error: "INVALID_SINCE" });
    }
    const limit = Math.min(Number(q.limit ?? 50), 100);

    const locks = await prisma.devLock.findMany({
      where: {
        chainId: env.CHAIN_ID,
        ...(since
          ? {
              OR: [{ createdAt: { gt: since } }, { updatedAt: { gt: since } }],
            }
          : {}),
      },
      include: { launch: true },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    return {
      data: locks.map((l) => {
        const shaped = toFeDevLock(l, {
          name: l.launch?.name,
          symbol: l.launch?.symbol,
        });
        const isClaim =
          Number(shaped.claimed) > 0 &&
          l.updatedAt.getTime() - l.createdAt.getTime() > 2_000;
        return {
          ...shaped,
          owner: l.owner,
          status: l.status,
          createTxHash: l.createTxHash,
          createdAt: l.createdAt.getTime(),
          updatedAt: l.updatedAt.getTime(),
          kind: isClaim ? ("claim" as const) : ("create" as const),
        };
      }),
      limit,
    };
  });

  app.get("/api/feed/staking-activities", async (req, reply) => {
    const q = req.query as { since?: string; kind?: string; limit?: string };
    const since = parseSince(q.since);
    if (q.since && !since) {
      return reply.code(400).send({ error: "INVALID_SINCE" });
    }
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const kind = q.kind?.trim().toLowerCase();
    if (kind && !["stake", "claim", "unstake"].includes(kind)) {
      return reply.code(400).send({ error: "INVALID_KIND" });
    }

    const rows = await prisma.stakingActivity.findMany({
      where: {
        chainId: env.CHAIN_ID,
        ...(since ? { at: { gt: since } } : {}),
        ...(kind ? { kind } : {}),
      },
      orderBy: { at: "desc" },
      take: limit,
    });

    const vaultIds = [...new Set(rows.map((r) => r.vaultId))];
    const numericIds = vaultIds.filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id));
    const addressIds = vaultIds.map((id) => id.toLowerCase());
    const vaults =
      vaultIds.length === 0
        ? []
        : await prisma.stakingVault.findMany({
            where: {
              chainId: env.CHAIN_ID,
              OR: [
                ...(numericIds.length ? [{ vaultId: { in: numericIds } }] : []),
                ...(addressIds.length ? [{ vaultAddress: { in: addressIds } }] : []),
              ],
            },
            include: { launch: true },
          });
    const byVaultId = new Map(vaults.map((v) => [v.vaultId.toString(), v]));
    const byAddress = new Map(vaults.map((v) => [v.vaultAddress, v]));

    return {
      data: rows.map((r) => {
        const vault = byVaultId.get(r.vaultId) ?? byAddress.get(r.vaultId.toLowerCase());
        return {
          id: r.id,
          eventId: vault?.vaultId.toString() ?? r.vaultId,
          address: vault?.stakeToken ?? "",
          symbol: vault?.launch?.symbol ?? "",
          name: vault?.launch?.name ?? "",
          wallet: r.walletAddress,
          kind: r.kind as "stake" | "claim" | "unstake",
          lock: lockIdToFe(r.lockId),
          amount: rawToUiAmount(r.amount),
          reward: rawToUiAmount(r.reward),
          at: r.at.getTime(),
          txHash: r.txHash,
        };
      }),
      limit,
    };
  });
}
