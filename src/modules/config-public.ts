import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { FE_STAKING_LOCK_OPTIONS } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";

export type RewardOutcomeKind = "miss" | "eth" | "erc20";

export type RewardOutcome = {
  label: string;
  weight: number;
  kind: RewardOutcomeKind;
  prizeToken?: string;
  /** System-owned: random band within fairShare (admin does not set). */
  minShareBps: number;
  maxShareBps: number;
};

type OutcomeInput = {
  label?: string;
  weight?: number;
  kind?: string;
  prizeToken?: string | null;
  minShareBps?: number;
  maxShareBps?: number;
};

/** Full random within fairShare = pool ÷ unopened boxes (admin only sets token + weight). */
export const SYSTEM_MIN_SHARE_BPS = 1;
export const SYSTEM_MAX_SHARE_BPS = 10_000;

/** Default sealed table before admin configures prizes. */
export const DEFAULT_REWARD_TABLE = {
  name: "default-s1",
  config: {
    labels: ["ETH", "No reward"],
    outcomes: [
      {
        label: "ETH",
        weight: 40,
        kind: "eth",
        minShareBps: SYSTEM_MIN_SHARE_BPS,
        maxShareBps: SYSTEM_MAX_SHARE_BPS,
      },
      {
        label: "No reward",
        weight: 60,
        kind: "miss",
        minShareBps: 0,
        maxShareBps: 0,
      },
    ] satisfies RewardOutcome[],
  },
} as const;

function isMissLabel(label: string): boolean {
  const t = label.trim().toLowerCase();
  return t === "no reward" || t === "—" || t === "-" || t === "miss" || t === "empty";
}

export function normalizeOutcome(raw: string | OutcomeInput): RewardOutcome {
  if (typeof raw === "string") {
    const label = raw;
    if (isMissLabel(label)) {
      return { label, weight: 1, kind: "miss", minShareBps: 0, maxShareBps: 0 };
    }
    return {
      label,
      weight: 1,
      kind: "eth",
      minShareBps: SYSTEM_MIN_SHARE_BPS,
      maxShareBps: SYSTEM_MAX_SHARE_BPS,
    };
  }

  const weight = Math.max(1, Number(raw.weight ?? 1));

  let kind: RewardOutcomeKind = "eth";
  if (raw.kind === "miss" || raw.kind === "eth" || raw.kind === "erc20") {
    kind = raw.kind;
  } else if (raw.label && isMissLabel(raw.label)) {
    kind = "miss";
  } else if (raw.prizeToken) {
    kind = "erc20";
  }

  let prizeToken: string | undefined;
  if (kind === "erc20" && raw.prizeToken) {
    try {
      prizeToken = normalizeAddress(raw.prizeToken);
    } catch {
      prizeToken = undefined;
    }
  }

  const label =
    (raw.label ?? "").trim() ||
    (kind === "miss" ? "No reward" : kind === "eth" ? "ETH" : prizeToken?.slice(0, 10) || "Prize");

  if (kind === "miss") {
    return { label: isMissLabel(label) ? label : "No reward", weight, kind: "miss", minShareBps: 0, maxShareBps: 0 };
  }

  // Ignore admin-supplied share bands — always system fairShare random.
  return {
    label,
    weight,
    kind,
    prizeToken,
    minShareBps: SYSTEM_MIN_SHARE_BPS,
    maxShareBps: SYSTEM_MAX_SHARE_BPS,
  };
}

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

export function outcomesFromConfig(config: unknown): RewardOutcome[] {
  if (!config || typeof config !== "object") {
    return DEFAULT_REWARD_TABLE.config.outcomes.map((o) => ({ ...o }));
  }
  const c = config as Record<string, unknown>;
  if (Array.isArray(c.outcomes) && c.outcomes.length > 0) {
    return (c.outcomes as Array<string | OutcomeInput>).map((o) => normalizeOutcome(o));
  }
  const labels = labelsFromConfig(config);
  if (labels.length > 0) return labels.map((label) => normalizeOutcome(label));
  return DEFAULT_REWARD_TABLE.config.outcomes.map((o) => ({ ...o }));
}

/** Fill ERC-20 labels from allowlist; force system share bps. */
export async function hydrateRewardOutcomes(
  outcomes: RewardOutcome[],
): Promise<RewardOutcome[]> {
  const tokens = outcomes
    .filter((o) => o.kind === "erc20" && o.prizeToken)
    .map((o) => o.prizeToken!.toLowerCase());
  const rows =
    tokens.length > 0
      ? await prisma.rewardPrizeToken.findMany({ where: { token: { in: tokens } } })
      : [];
  const byToken = new Map(rows.map((r) => [r.token.toLowerCase(), r]));

  return outcomes.map((o) => {
    if (o.kind === "miss") return { ...o, minShareBps: 0, maxShareBps: 0 };
    if (o.kind === "eth") {
      return {
        ...o,
        label: "ETH",
        minShareBps: SYSTEM_MIN_SHARE_BPS,
        maxShareBps: SYSTEM_MAX_SHARE_BPS,
      };
    }
    const meta = o.prizeToken ? byToken.get(o.prizeToken.toLowerCase()) : undefined;
    return {
      ...o,
      label: meta?.label?.trim() || o.label || "TOKEN",
      minShareBps: SYSTEM_MIN_SHARE_BPS,
      maxShareBps: SYSTEM_MAX_SHARE_BPS,
    };
  });
}

/** Validate admin-submitted outcomes; returns error message or null. */
export async function validateRewardOutcomes(
  outcomes: RewardOutcome[],
): Promise<string | null> {
  if (outcomes.length === 0) return "Need at least one outcome";
  for (const o of outcomes) {
    if (o.weight < 1) return `Invalid weight for ${o.label || o.kind}`;
    if (o.kind === "miss") continue;
    if (o.kind === "erc20") {
      if (!o.prizeToken) return "prizeToken required for ERC-20 outcome";
      const row = await prisma.rewardPrizeToken.findFirst({
        where: { token: o.prizeToken.toLowerCase(), approved: true },
      });
      if (!row) return `Prize token not approved: ${o.prizeToken}`;
      if (!row.label?.trim()) {
        return `Prize token ${o.prizeToken} needs a label on Reward tokens`;
      }
    }
  }
  return null;
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
    const outcomes = outcomesFromConfig(row.config);
    const labels = outcomes.map((o) => o.label);
    return {
      data: {
        id: row.id,
        name: row.name,
        seasonId: row.seasonId,
        active: row.active,
        rewardPool: labels.length ? labels : [...DEFAULT_REWARD_TABLE.config.labels],
        outcomes,
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
