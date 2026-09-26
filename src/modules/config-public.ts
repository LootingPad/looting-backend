import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { FE_STAKING_LOCK_OPTIONS } from "../lib/fe-shape.js";

type Outcome = { label: string; weight: number };

/** Default sealed table so Rewards reel is never empty before admin configs one. */
export const DEFAULT_REWARD_TABLE = {
  name: "default-s1",
  config: {
    labels: ["25 LOOTING", "0.18 mNVDA", "0.42 mSPY", "No reward", "40 LOOTING"],
    outcomes: [
      { label: "25 LOOTING", weight: 25 },
      { label: "0.18 mNVDA", weight: 15 },
      { label: "0.42 mSPY", weight: 15 },
      { label: "No reward", weight: 30 },
      { label: "40 LOOTING", weight: 15 },
    ],
  },
} as const;

export function labelsFromConfig(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const c = config as Record<string, unknown>;
  if (Array.isArray(c.labels)) {
    return c.labels.filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(c.outcomes)) {
    return (c.outcomes as Array<string | { label?: string }>)
      .map((o) => (typeof o === "string" ? o : o?.label))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (Array.isArray(c.pool)) {
    return c.pool.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export function outcomesFromConfig(config: unknown): Outcome[] {
  if (!config || typeof config !== "object") {
    return DEFAULT_REWARD_TABLE.config.outcomes.map((o) => ({ ...o }));
  }
  const c = config as Record<string, unknown>;
  if (Array.isArray(c.outcomes) && c.outcomes.length > 0) {
    return (c.outcomes as Array<string | { label?: string; weight?: number }>).map((o) => {
      if (typeof o === "string") return { label: o, weight: 1 };
      return { label: o.label ?? "No reward", weight: Math.max(1, Number(o.weight ?? 1)) };
    });
  }
  const labels = labelsFromConfig(config);
  if (labels.length > 0) return labels.map((label) => ({ label, weight: 1 }));
  return DEFAULT_REWARD_TABLE.config.outcomes.map((o) => ({ ...o }));
}

export async function ensureActiveRewardTable() {
  const existing = await prisma.rewardTableConfig.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return existing;

  return prisma.rewardTableConfig.create({
    data: {
      name: DEFAULT_REWARD_TABLE.name,
      config: DEFAULT_REWARD_TABLE.config,
      active: true,
    },
  });
}

export async function registerRewardTableRoutes(app: FastifyInstance) {
  app.get("/api/reward-table", async () => {
    const row = await ensureActiveRewardTable();
    const labels = labelsFromConfig(row.config);
    return {
      data: {
        id: row.id,
        name: row.name,
        seasonId: row.seasonId,
        active: row.active,
        rewardPool: labels.length ? labels : [...DEFAULT_REWARD_TABLE.config.labels],
        config: row.config,
      },
    };
  });
}

export async function registerStakingConfigRoutes(app: FastifyInstance) {
  app.get("/api/staking/config", async () => ({
    data: {
      locks: FE_STAKING_LOCK_OPTIONS,
    },
  }));
}
