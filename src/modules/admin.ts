import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { getAddress, parseAbi, type Address } from "viem";
import { env } from "../config/env.js";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { resolveTokenProfile } from "../lib/token-profile.js";
import { normalizeAddress } from "../lib/utils.js";
import {
  hydrateRewardOutcomes,
  normalizeOutcome,
  outcomesFromConfig,
  validateRewardOutcomes,
  type RewardOutcome,
} from "./config-public.js";
import { requireAdmin } from "./health.js";
import { recomputeSeasonRanks } from "../services/xp.js";
import { readSiteConfigPublic, upsertSiteConfig, type SiteConfigUpdate } from "./site-config.js";

const erc20MetaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Some tokens return bytes32 for symbol/name — decode loosely. */
function asTokenString(value: unknown): string {
  if (typeof value === "string") return value.replace(/\0/g, "").trim();
  if (typeof value === "object" && value && "toString" in value) {
    return String(value).replace(/\0/g, "").trim();
  }
  return "";
}

async function readErc20Meta(token: Address): Promise<{
  symbol: string;
  name: string;
  decimals: number;
}> {
  const client = getPublicClient();
  const [symbolRes, nameRes, decimalsRes] = await Promise.allSettled([
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "decimals" }),
  ]);

  const symbol = symbolRes.status === "fulfilled" ? asTokenString(symbolRes.value) : "";
  const name = nameRes.status === "fulfilled" ? asTokenString(nameRes.value) : "";
  const decimals =
    decimalsRes.status === "fulfilled" && typeof decimalsRes.value === "number"
      ? decimalsRes.value
      : 18;

  return { symbol, name, decimals };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/admin/config", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const data = await readSiteConfigPublic();
    return { data };
  });

  app.put("/api/admin/config", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as SiteConfigUpdate;
    const result = await upsertSiteConfig(body);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    return { data: result.data };
  });

  app.get("/api/admin/seasons", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await prisma.season.findMany({ orderBy: { startsAt: "desc" }, take: 50 });
    return {
      data: rows.map((s) => ({
        seasonId: s.seasonId,
        status: s.status,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        bronzeThreshold: s.bronzeThreshold,
        silverThreshold: s.silverThreshold,
        goldThreshold: s.goldThreshold,
        thresholds: {
          bronze: s.bronzeThreshold,
          silver: s.silverThreshold,
          gold: s.goldThreshold,
        },
        configHash: s.configHash,
      })),
    };
  });

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

  app.get("/api/admin/reward-tables", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await prisma.rewardTableConfig.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        seasonId: r.seasonId,
        active: r.active,
        config: r.config,
        outcomes: outcomesFromConfig(r.config),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/admin/reward-table", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = req.body as {
      name: string;
      seasonId?: string;
      config: unknown;
      active?: boolean;
      outcomes?: RewardOutcome[];
    };
    if (!body.name || (body.config === undefined && !body.outcomes)) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    let outcomes: RewardOutcome[];
    if (Array.isArray(body.outcomes) && body.outcomes.length > 0) {
      outcomes = body.outcomes.map((o) => normalizeOutcome(o));
    } else {
      outcomes = outcomesFromConfig(body.config);
    }

    outcomes = await hydrateRewardOutcomes(outcomes);

    const validationError = await validateRewardOutcomes(outcomes);
    if (validationError) {
      return reply.code(400).send({ error: "INVALID_OUTCOMES", message: validationError });
    }

    const config = {
      labels: outcomes.map((o) => o.label),
      outcomes,
    };

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
        config,
        active: body.active !== false,
      },
    });

    return { data: { id: row.id, name: row.name, active: row.active, outcomes } };
  });

  app.get("/api/admin/launches", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = String((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    const rows = await prisma.launch.findMany({
      where: q
        ? {
            OR: [
              { token: { contains: q } },
              { symbol: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        token: true,
        symbol: true,
        name: true,
        status: true,
        rewardsEnabled: true,
        createdAt: true,
      },
    });
    return { data: rows };
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

  app.get("/api/admin/tokens", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await prisma.rewardPrizeToken.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    return {
      data: rows.map((r) => ({
        token: r.token,
        label: r.label,
        decimals: r.decimals,
        approved: r.approved,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  /** Resolve ERC-20 + logo for admin label autofill (prize tokens + $LOOTING CA). */
  app.get("/api/admin/token/lookup", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const raw = String((req.query as { token?: string }).token ?? "").trim();
    let token: string;
    try {
      token = normalizeAddress(raw);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    try {
      const profile = await resolveTokenProfile(token);
      const label = profile.symbol || profile.name || null;
      if (!label) {
        return reply.code(404).send({
          error: "SYMBOL_NOT_FOUND",
          message: "Could not read ERC-20 symbol for this address.",
        });
      }
      return {
        data: {
          token: profile.address,
          label,
          symbol: profile.symbol || null,
          name: profile.name || null,
          decimals: profile.decimals,
          logo: profile.logo || null,
          description: profile.description || null,
          totalSupply: profile.totalSupply,
        },
      };
    } catch (err) {
      return reply.code(502).send({
        error: "LOOKUP_FAILED",
        message: err instanceof Error ? err.message : "lookup failed",
      });
    }
  });

  app.post("/api/admin/token/approve", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = req.body as {
      token: string;
      approved?: boolean;
      label?: string;
      decimals?: number;
    };
    let token: string;
    try {
      token = normalizeAddress(body.token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const approved = body.approved !== false;
    let label = body.label?.trim() || null;
    let decimals =
      typeof body.decimals === "number" && Number.isFinite(body.decimals)
        ? Math.min(36, Math.max(0, Math.round(body.decimals)))
        : 18;

    if (approved && !label) {
      try {
        const meta = await readErc20Meta(getAddress(token) as Address);
        label = meta.symbol || meta.name || null;
        if (typeof meta.decimals === "number") decimals = meta.decimals;
      } catch {
        /* fall through */
      }
    }

    if (approved && !label) {
      return reply.code(400).send({
        error: "LABEL_REQUIRED",
        message: "Could not resolve token symbol — enter a label manually.",
      });
    }

    const row = await prisma.rewardPrizeToken.upsert({
      where: { token },
      create: {
        token,
        label,
        decimals,
        approved,
      },
      update: {
        approved,
        label: body.label !== undefined || label ? label : undefined,
        decimals: body.decimals !== undefined ? decimals : undefined,
      },
    });

    return {
      data: {
        token: row.token,
        approved: row.approved,
        label: row.label,
        decimals: row.decimals,
      },
    };
  });

  app.post("/api/admin/leaderboard/recompute", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const season = await prisma.season.findFirst({ where: { status: "active" } });
    if (!season) return reply.code(404).send({ error: "NO_ACTIVE_SEASON" });
    await recomputeSeasonRanks(season.id);
    return { ok: true, seasonId: season.seasonId };
  });
}
