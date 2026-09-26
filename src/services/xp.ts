import { Tier, type Season } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { ensureWallet, tierFromXp } from "../lib/utils.js";

export async function getCurrentSeason(): Promise<Season | null> {
  const now = new Date();
  return prisma.season.findFirst({
    where: {
      status: "active",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    orderBy: { startsAt: "desc" },
  });
}

export async function recomputeSeasonRanks(seasonDbId: string): Promise<void> {
  const rows = await prisma.seasonWalletStat.findMany({
    where: { seasonId: seasonDbId },
    orderBy: [{ xp: "desc" }, { updatedAt: "asc" }],
    select: { id: true },
  });

  await prisma.$transaction(
    rows.map((row, index) =>
      prisma.seasonWalletStat.update({
        where: { id: row.id },
        data: { rank: index + 1 },
      }),
    ),
  );
}

export async function awardXp(opts: {
  chainId: number;
  wallet: string;
  xp: number;
  tradeIncrement?: number;
}): Promise<void> {
  if (opts.xp <= 0) return;

  const season = await getCurrentSeason();
  const user = await ensureWallet(opts.chainId, opts.wallet);

  await prisma.userWallet.update({
    where: { id: user.id },
    data: {
      lifetimeXp: { increment: opts.xp },
      lifetimeTradeCount: { increment: opts.tradeIncrement ?? 0 },
      lastSeenAt: new Date(),
    },
  });

  if (!season) return;

  const thresholds = {
    bronze: season.bronzeThreshold,
    silver: season.silverThreshold,
    gold: season.goldThreshold,
  };

  const existing = await prisma.seasonWalletStat.findUnique({
    where: { seasonId_walletId: { seasonId: season.id, walletId: user.id } },
  });

  const nextXp = BigInt(existing?.xp ?? 0n) + BigInt(opts.xp);
  const tier = tierFromXp(nextXp, thresholds) as Tier;

  await prisma.seasonWalletStat.upsert({
    where: { seasonId_walletId: { seasonId: season.id, walletId: user.id } },
    create: {
      seasonId: season.id,
      walletId: user.id,
      xp: BigInt(opts.xp),
      tradeCount: opts.tradeIncrement ?? 0,
      tier,
    },
    update: {
      xp: { increment: opts.xp },
      tradeCount: { increment: opts.tradeIncrement ?? 0 },
      tier,
    },
  });

  await recomputeSeasonRanks(season.id);
}
