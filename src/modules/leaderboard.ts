import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { toFeLeaderboardRow } from "../lib/fe-shape.js";
import { ensureActiveSeason } from "../services/xp.js";

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get("/api/leaderboard/current", async (req) => {
    const q = req.query as { limit?: string; offset?: string; wallet?: string };
    const limit = Math.min(Number(q.limit ?? 20), 100);
    const offset = Number(q.offset ?? 0);

    const season = await ensureActiveSeason();

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
        you = toFeLeaderboardRow({
          wallet: me.wallet.wallet,
          xp: me.xp,
          tier: me.tier,
          tradeCount: me.tradeCount,
        });
      }
    }

    return {
      seasonId: season.seasonId,
      data: rows.map((r) =>
        toFeLeaderboardRow({
          wallet: r.wallet.wallet,
          xp: r.xp,
          tier: r.tier,
          tradeCount: r.tradeCount,
        }),
      ),
      you,
      limit,
      offset,
      message:
        rows.length === 0
          ? "Season is live. Rankings fill in as trades earn XP."
          : undefined,
    };
  });
}
