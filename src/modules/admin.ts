import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { normalizeAddress } from "../lib/utils.js";
import { requireAdmin } from "./health.js";
import { recomputeSeasonRanks } from "../services/xp.js";

export async function registerAdminRoutes(app: FastifyInstance) {
  app.post("/api/admin/season", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = req.body as {
      seasonId: string;
      startsAt: string;
      endsAt: string;
      bronzeThreshold?: number;
      silverThreshold?: number;
      goldThreshold?: number;
      activate?: boolean;
    };

    if (!body.seasonId || !body.startsAt || !body.endsAt) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    const configHash = createHash("sha256")
      .update(
        JSON.stringify({
          seasonId: body.seasonId,
          bronze: body.bronzeThreshold ?? 0,
          silver: body.silverThreshold ?? 1000,
          gold: body.goldThreshold ?? 5000,
        }),
      )
      .digest("hex");

    if (body.activate) {
      await prisma.season.updateMany({
        where: { status: "active" },
        data: { status: "ended" },
      });
    }

    const season = await prisma.season.upsert({
      where: { seasonId: body.seasonId },
      create: {
        seasonId: body.seasonId,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        status: body.activate ? "active" : "upcoming",
        configHash,
        bronzeThreshold: body.bronzeThreshold ?? 0,
        silverThreshold: body.silverThreshold ?? 1000,
        goldThreshold: body.goldThreshold ?? 5000,
      },
      update: {
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        status: body.activate ? "active" : undefined,
        configHash,
        bronzeThreshold: body.bronzeThreshold,
        silverThreshold: body.silverThreshold,
        goldThreshold: body.goldThreshold,
      },
    });

    return {
      data: {
        seasonId: season.seasonId,
        status: season.status,
        configHash: season.configHash,
      },
    };
  });

  app.post("/api/admin/reward-table", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = req.body as { name: string; seasonId?: string; config: unknown; active?: boolean };
    if (!body.name || body.config === undefined) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    if (body.active !== false) {
      await prisma.rewardTableConfig.updateMany({
        where: { active: true },
        data: { active: false },
      });
    }

    const row = await prisma.rewardTableConfig.create({
      data: {
        name: body.name,
        seasonId: body.seasonId,
        config: body.config as object,
        active: body.active !== false,
      },
    });

    return { data: { id: row.id, name: row.name, active: row.active } };
  });

  app.post("/api/admin/launch/:token/pause-rewards", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

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

    const updated = await prisma.launch.update({
      where: { id: launch.id },
      data: { rewardsEnabled: false, status: "paused" },
    });

    return {
      data: {
        token: updated.token,
        rewardsEnabled: updated.rewardsEnabled,
        status: updated.status,
      },
    };
  });

  app.post("/api/admin/token/approve", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Placeholder for RWA / reward-token allowlist (Spec §31 Phase 5).
    const body = req.body as { token: string; approved?: boolean };
    let token: string;
    try {
      token = normalizeAddress(body.token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }
    return { data: { token, approved: body.approved !== false } };
  });

  app.post("/api/admin/leaderboard/recompute", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const season = await prisma.season.findFirst({ where: { status: "active" } });
    if (!season) return reply.code(404).send({ error: "NO_ACTIVE_SEASON" });
    await recomputeSeasonRanks(season.id);
    return { ok: true, seasonId: season.seasonId };
  });
}
