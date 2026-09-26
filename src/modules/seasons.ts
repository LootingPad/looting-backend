import type { FastifyInstance } from "fastify";
import { getCurrentSeason } from "../services/xp.js";

export async function registerSeasonRoutes(app: FastifyInstance) {
  app.get("/api/seasons/current", async (_req, reply) => {
    const season = await getCurrentSeason();
    if (!season) return reply.code(404).send({ error: "NO_ACTIVE_SEASON" });

    return {
      data: {
        seasonId: season.seasonId,
        startsAt: season.startsAt.toISOString(),
        endsAt: season.endsAt.toISOString(),
        status: season.status,
        configHash: season.configHash,
        thresholds: {
          bronze: season.bronzeThreshold,
          silver: season.silverThreshold,
          gold: season.goldThreshold,
        },
      },
    };
  });
}
