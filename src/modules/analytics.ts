import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  FE_FEES,
  FE_STAKING_LOCK_OPTIONS,
  lockMaskToIds,
  rawToUiAmount,
  toFeLaunch,
  toFeMarketStats,
  type FeLockId,
} from "../lib/fe-shape.js";
import { getCurrentSeason } from "../services/xp.js";

const SERIES_DAYS = 72;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(dayKey(d));
  }
  return out;
}

function feeAccrualWeight(progress: number) {
  return 0.35 + progress / 200;
}

function accruedFeeUsd(launch: { marketCap: number; creatorTax: number; progress: number }) {
  return launch.marketCap * (launch.creatorTax / 100) * feeAccrualWeight(launch.progress);
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics", async (req) => {
    const q = req.query as { window?: string };
    const window = q.window === "all" ? "all" : "24h";
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceDay = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [launches, vaults, locks, season, volumeAll, volume24, txnsAll, tradersAll] =
      await Promise.all([
        prisma.launch.findMany({
          where: { chainId: env.CHAIN_ID, status: "active" },
          orderBy: { launchedAt: "desc" },
          take: 200,
        }),
        prisma.stakingVault.findMany({
          where: { chainId: env.CHAIN_ID },
          include: { launch: true },
        }),
        prisma.devLock.findMany({
          where: { chainId: env.CHAIN_ID },
          include: { launch: true },
        }),
        getCurrentSeason(),
        prisma.trade.aggregate({
          where: { chainId: env.CHAIN_ID },
          _sum: { usdNotional: true },
          _count: true,
        }),
        prisma.trade.aggregate({
          where: { chainId: env.CHAIN_ID, timestamp: { gte: since24h } },
          _sum: { usdNotional: true },
          _count: true,
        }),
        prisma.trade.count({ where: { chainId: env.CHAIN_ID } }),
        prisma.trade.findMany({
          where: { chainId: env.CHAIN_ID },
          distinct: ["trader"],
          select: { trader: true },
        }),
      ]);

    const traders24 = await prisma.trade.findMany({
      where: { chainId: env.CHAIN_ID, timestamp: { gte: since24h } },
      distinct: ["trader"],
      select: { trader: true },
    });

    const launchRows = launches.map((l) => {
      const shaped = toFeLaunch(l);
      const stats = toFeMarketStats(shaped, { launchedAt: l.launchedAt });
      const feeUsd = accruedFeeUsd(shaped);
      const boxUsd = feeUsd * (shaped.luckyShare / 100);
      return {
        launch: shaped,
        stats,
        feeUsd,
        boxUsd,
        creatorUsd: feeUsd - boxUsd,
      };
    });

    const volume24h =
      Number(volume24._sum.usdNotional ?? 0) ||
      launchRows.reduce((sum, row) => sum + row.stats.volume24h, 0);
    const volumeAllTime =
      Number(volumeAll._sum.usdNotional ?? 0) || volume24h;
    const feeUsd = launchRows.reduce((sum, row) => sum + row.feeUsd, 0);
    const boxUsd = launchRows.reduce((sum, row) => sum + row.boxUsd, 0);
    const creatorUsd = feeUsd - boxUsd;

    let seasonXp = 0;
    let seasonTrades = 0;
    if (season) {
      const agg = await prisma.seasonWalletStat.aggregate({
        where: { seasonId: season.id },
        _sum: { xp: true, tradeCount: true },
      });
      seasonXp = Number(agg._sum.xp ?? 0n);
      seasonTrades = agg._sum.tradeCount ?? 0;
    }

    const vaultStaked = vaults.reduce((sum, v) => sum + rawToUiAmount(v.totalStaked), 0);
    const vaultRewards = vaults.reduce((sum, v) => sum + rawToUiAmount(v.rewardFunded), 0);
    const vaultStakers = vaults.reduce((sum, v) => sum + v.stakerCount, 0);

    const stakeByLock = FE_STAKING_LOCK_OPTIONS.map((lock) => {
      const enabled = vaults.filter((v) => lockMaskToIds(v.lockMask).includes(lock.id as FeLockId));
      const staked = enabled.reduce((sum, v) => {
        const locks = lockMaskToIds(v.lockMask);
        return sum + rawToUiAmount(v.totalStaked) / Math.max(1, locks.length);
      }, 0);
      return {
        id: lock.id,
        label: lock.label,
        rate: lock.rate,
        staked: Math.round(staked),
        day: Math.round(staked * 0.018),
      };
    });

    const topVaults = [...vaults]
      .sort((a, b) => Number(b.totalStaked) - Number(a.totalStaked))
      .slice(0, 5)
      .map((v) => ({
        id: v.vaultId.toString(),
        symbol: v.launch?.symbol ?? "",
        name: v.launch?.name ?? "",
        staked: rawToUiAmount(v.totalStaked),
        reward: rawToUiAmount(v.rewardFunded),
        stakers: v.stakerCount,
        locks: lockMaskToIds(v.lockMask),
        apr: (() => {
          const rates = FE_STAKING_LOCK_OPTIONS.filter((o) =>
            lockMaskToIds(v.lockMask).includes(o.id as FeLockId),
          ).map((o) => o.rate);
          if (!rates.length) return "—";
          const min = Math.min(...rates);
          const max = Math.max(...rates);
          return min === max ? `${min}%` : `${min}–${max}%`;
        })(),
      }));

    const locksDay = locks.filter((l) => l.createdAt >= sinceDay).length;
    const timeLocks = locks.filter((l) => l.mode === "time").length;
    const vestLocks = locks.filter((l) => l.mode === "vest").length;
    const tokensLocked = locks.reduce((sum, l) => sum + rawToUiAmount(l.amount), 0);
    const claimed = locks.reduce((sum, l) => sum + rawToUiAmount(l.claimed), 0);
    const tokensLockedDay = locks
      .filter((l) => l.createdAt >= sinceDay)
      .reduce((sum, l) => sum + rawToUiAmount(l.amount), 0);
    const claimedDay = locks
      .filter((l) => l.updatedAt >= sinceDay)
      .reduce((sum, l) => sum + rawToUiAmount(l.claimed), 0);
    const lockCreators = new Set(locks.map((l) => l.owner)).size;

    const topLocks = [...locks]
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 5)
      .map((l) => ({
        symbol: l.launch?.symbol ?? l.token.slice(0, 6),
        amount: rawToUiAmount(l.amount),
        mode: l.mode === "vest" ? "Vesting" : "Time-based",
      }));

    const days = lastNDays(SERIES_DAYS);
    const dayStart = new Date(`${days[0]}T00:00:00.000Z`);

    const [tradesByDay, launchesByDay, vaultsByDay, locksByDay] = await Promise.all([
      prisma.$queryRaw<{ day: Date; volume: unknown }[]>`
        SELECT date_trunc('day', timestamp) AS day, COALESCE(SUM("usdNotional"), 0) AS volume
        FROM trades
        WHERE "chainId" = ${env.CHAIN_ID} AND timestamp >= ${dayStart}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw<{ day: Date; count: bigint }[]>`
        SELECT date_trunc('day', "launchedAt") AS day, COUNT(*)::bigint AS count
        FROM launches
        WHERE "chainId" = ${env.CHAIN_ID} AND "launchedAt" >= ${dayStart}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw<{ day: Date; staked: unknown }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM("totalStaked"), 0) AS staked
        FROM staking_vaults
        WHERE "chainId" = ${env.CHAIN_ID} AND "createdAt" >= ${dayStart}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw<{ day: Date; locked: unknown }[]>`
        SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM(amount), 0) AS locked
        FROM dev_locks
        WHERE "chainId" = ${env.CHAIN_ID} AND "createdAt" >= ${dayStart}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    const volumeMap = new Map(
      tradesByDay.map((r) => [dayKey(new Date(r.day)), Number(r.volume)]),
    );
    const launchMap = new Map(
      launchesByDay.map((r) => [dayKey(new Date(r.day)), Number(r.count)]),
    );
    const stakeMap = new Map(
      vaultsByDay.map((r) => [dayKey(new Date(r.day)), rawToUiAmount(String(r.staked))]),
    );
    const lockMap = new Map(
      locksByDay.map((r) => [dayKey(new Date(r.day)), rawToUiAmount(String(r.locked))]),
    );

    const series = {
      days,
      volume: days.map((d) => volumeMap.get(d) ?? 0),
      launches: days.map((d) => launchMap.get(d) ?? 0),
      staking: days.map((d) => stakeMap.get(d) ?? 0),
      devlock: days.map((d) => lockMap.get(d) ?? 0),
    };

    const summary24h = {
      volume: volume24h,
      launches: launches.filter((l) => l.launchedAt && l.launchedAt >= since24h).length || launches.length,
      traders: traders24.length,
      txns: volume24._count,
      volumeDeltaPct: 0,
      launchDeltaPct: 0,
    };

    const summaryAll = {
      volume: volumeAllTime,
      launches: launches.length,
      traders: tradersAll.length,
      txns: txnsAll,
      volumeDeltaPct: 0,
      launchDeltaPct: 0,
    };

    return {
      data: {
        ethUsd: FE_FEES.ETH_USD,
        window,
        summary: window === "all" ? summaryAll : summary24h,
        fees: {
          feeUsd,
          boxUsd,
          creatorUsd,
          boxSharePct: feeUsd > 0 ? (boxUsd / feeUsd) * 100 : 0,
          topCreators: [...launchRows]
            .sort((a, b) => b.creatorUsd - a.creatorUsd)
            .slice(0, 5)
            .map((r) => ({
              symbol: r.launch.symbol,
              address: r.launch.address,
              creatorUsd: r.creatorUsd,
            })),
          topBoxes: [...launchRows]
            .sort((a, b) => b.boxUsd - a.boxUsd)
            .slice(0, 5)
            .map((r) => ({
              symbol: r.launch.symbol,
              address: r.launch.address,
              boxUsd: r.boxUsd,
            })),
          topCurves: [...launchRows]
            .sort((a, b) => b.launch.progress - a.launch.progress)
            .slice(0, 5)
            .map((r) => ({
              symbol: r.launch.symbol,
              address: r.launch.address,
              progress: r.launch.progress,
            })),
        },
        season: {
          seasonId: season?.seasonId ?? null,
          xp: seasonXp,
          trades: seasonTrades,
          graduated: launches.filter((l) => l.phase === "graduated").length,
          creators: new Set(launches.map((l) => l.creator)).size,
        },
        staking: {
          vaultCount: vaults.length,
          staked: vaultStaked,
          rewards: vaultRewards,
          stakers: vaultStakers,
          byLock: stakeByLock,
          topVaults,
        },
        devLock: {
          locks: locks.length,
          locksDay,
          timeLocks,
          vestLocks,
          tokensLocked,
          tokensLockedDay,
          claimed,
          claimedDay,
          feeEth: locks.length * FE_FEES.DEV_LOCK_FEE_ETH,
          feeEthDay: locksDay * FE_FEES.DEV_LOCK_FEE_ETH,
          creators: lockCreators,
          top: topLocks,
        },
        series,
      },
    };
  });
}
