/**
 * Dev-only seed so Explore / Analytics aren't empty before indexer fills the DB.
 * Run: npx tsx scripts/seed-demo-launches.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663);

const demos = [
  {
    token: "0xa1b2c3d4e5f678901234567890abcdef12345601",
    creator: "0x4c91aa7700de12bb3318e774c0ff21aa00000000",
    name: "Night Vault",
    symbol: "VAULT",
    description: "Demo launch for local FE wiring.",
    luckyBoxBps: 20,
    totalCreatorFeeBps: 100,
    creatorBps: 80,
    phase: "curve" as const,
    progressHoursAgo: 2,
  },
  {
    token: "0xa1b2c3d4e5f678901234567890abcdef12345602",
    creator: "0x4c91aa7700de12bb3318e774c0ff21aa00000000",
    name: "Gold Thread",
    symbol: "THREAD",
    description: "Demo curve token.",
    luckyBoxBps: 50,
    totalCreatorFeeBps: 100,
    creatorBps: 50,
    phase: "curve" as const,
    progressHoursAgo: 8,
  },
  {
    token: "0xa1b2c3d4e5f678901234567890abcdef12345603",
    creator: "0x19bb221100de44a90112ab90ff33c1aa00000000",
    name: "Harbor",
    symbol: "HARBOR",
    description: "Demo graduated launch.",
    luckyBoxBps: 20,
    totalCreatorFeeBps: 100,
    creatorBps: 80,
    phase: "graduated" as const,
    progressHoursAgo: 48,
  },
  {
    token: "0xa1b2c3d4e5f678901234567890abcdef12345604",
    creator: "0x7712bb09331100aa77c144c01aa98e1100000000",
    name: "Paper Lantern",
    symbol: "LANTERN",
    description: "Fresh demo curve.",
    luckyBoxBps: 30,
    totalCreatorFeeBps: 100,
    creatorBps: 70,
    phase: "curve" as const,
    progressHoursAgo: 0.5,
  },
  {
    token: "0xa1b2c3d4e5f678901234567890abcdef12345605",
    creator: "0x00117b6daa10afbe91c02d4418c77e9000000000",
    name: "Copper Key",
    symbol: "KEY",
    description: "Demo almost-graduate.",
    luckyBoxBps: 20,
    totalCreatorFeeBps: 100,
    creatorBps: 80,
    phase: "curve" as const,
    progressHoursAgo: 14,
  },
];

async function main() {
  const before = await prisma.launch.count({ where: { chainId: CHAIN_ID } });
  console.log(`launches before: ${before}`);

  for (const d of demos) {
    const launchedAt = new Date(Date.now() - d.progressHoursAgo * 3600_000);
    await prisma.launch.upsert({
      where: { chainId_token: { chainId: CHAIN_ID, token: d.token } },
      create: {
        chainId: CHAIN_ID,
        token: d.token,
        creator: d.creator,
        name: d.name,
        symbol: d.symbol,
        description: d.description,
        luckyBoxBps: d.luckyBoxBps,
        totalCreatorFeeBps: d.totalCreatorFeeBps,
        creatorBps: d.creatorBps,
        phase: d.phase,
        status: "active",
        rewardsEnabled: true,
        launchedAt,
      },
      update: {
        name: d.name,
        symbol: d.symbol,
        description: d.description,
        phase: d.phase,
        launchedAt,
        luckyBoxBps: d.luckyBoxBps,
        totalCreatorFeeBps: d.totalCreatorFeeBps,
        creatorBps: d.creatorBps,
      },
    });
  }

  // Ensure active season exists for leaderboard/analytics.
  const existing = await prisma.season.findFirst({ where: { status: "active" } });
  if (!existing) {
    const startsAt = new Date();
    const endsAt = new Date(Date.now() + 90 * 24 * 3600_000);
    await prisma.season.create({
      data: {
        seasonId: "s1",
        startsAt,
        endsAt,
        status: "active",
        configHash: "demo-seed",
      },
    });
    console.log("created active season s1");
  } else {
    console.log(`season already active: ${existing.seasonId}`);
  }

  const after = await prisma.launch.count({ where: { chainId: CHAIN_ID } });
  console.log(`launches after: ${after}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
