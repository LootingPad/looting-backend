import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { getCurrentSeason } from "../services/xp.js";

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get("/api/leaderboard/current", async (req) => {
    const q = req.query as { limit?: string; offset?: string; wallet?: string };
    const limit = Math.min(Number(q.limit ?? 20), 100);
    const offset = Number(q.offset ?? 0);

    const season = await getCurrentSeason();
    if (!season) {
      return { data: [], seasonId: null, you: null, limit, offset };
    }

    const rows = await prisma.seasonWalletStat.findMany({
      where: { seasonId: season.id },
      include: { wallet: true },
      orderBy: [{ rank: "asc" }, { xp: "desc" }],
      take: limit,
      skip: offset,
    });

    let you = null;
    if (q.wallet) {
      const wallet = q.wallet.trim().toLowerCase();
      const me = await prisma.seasonWalletStat.findFirst({
        where: { seasonId: season.id, wallet: { wallet } },
        include: { wallet: true },
      });
      if (me) {
        you = {
          rank: me.rank,
          wallet: me.wallet.wallet,
          xp: me.xp.toString(),
          tier: me.tier,
          tradeCount: me.tradeCount,
        };
      }
    }

    return {
      seasonId: season.seasonId,
      data: rows.map((r) => ({
        rank: r.rank,
        wallet: r.wallet.wallet,
        xp: r.xp.toString(),
        tier: r.tier,
        tradeCount: r.tradeCount,
        boxesEarned: r.boxesEarned,
      })),
      you,
      limit,
      offset,
    };
  });
}
