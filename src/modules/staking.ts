import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { toFeStakingEvent } from "../lib/fe-shape.js";
import { getPonsapiExploreLaunch, ponsapiLiveEnabled } from "../pons-adapter/live-feed.js";

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
      include: { launch: true },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const uniqueTokens = [...new Set(vaults.map((v) => v.stakeToken))];
    const marketByToken = new Map<string, { marketCap?: number; volume24h?: number }>();
    if (ponsapiLiveEnabled()) {
      await Promise.all(
        uniqueTokens.map(async (token) => {
          try {
            const card = await getPonsapiExploreLaunch(token);
            if (card) {
              marketByToken.set(token, {
                marketCap: card.marketCap,
                volume24h: card.stats.volume24h,
              });
            }
          } catch {
            /* leave empty — UI shows 0 */
          }
        }),
      );
    }

    return {
      data: vaults.map((v) => {
        const market = marketByToken.get(v.stakeToken);
        return toFeStakingEvent(v, {
          name: v.launch?.name,
          symbol: v.launch?.symbol,
          marketCap: market?.marketCap,
          volume24h: market?.volume24h,
        });
      }),
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
      include: { launch: true },
    });
    if (!vault) return reply.code(404).send({ error: "NOT_FOUND" });

    let marketCap: number | undefined;
    let volume24h: number | undefined;
    if (ponsapiLiveEnabled()) {
      try {
        const card = await getPonsapiExploreLaunch(vault.stakeToken);
        marketCap = card?.marketCap;
        volume24h = card?.stats.volume24h;
      } catch {
        /* empty */
      }
    }
    return {
      data: toFeStakingEvent(vault, {
        name: vault.launch?.name,
        symbol: vault.launch?.symbol,
        marketCap,
        volume24h,
      }),
    };
  });
}
