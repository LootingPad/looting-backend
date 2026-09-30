import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { toFeLeaderboardRow, type FeLeaderboardRow } from "../lib/fe-shape.js";

function isMissLabel(label: string) {
  const t = label.trim().toLowerCase();
  return t === "" || t === "no reward" || t === "—" || t === "-";
}

type Agg = {
  walletId: string;
  wallet: string;
  boxesOpened: number;
  rewardsWon: number;
  ethWei: bigint;
};

function formatEthWon(wei: bigint): string {
  if (wei <= 0n) return "—";
  // wei → ETH with up to 6 decimals, trim trailing zeros
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return `${neg ? "-" : ""}${body} ETH`;
}

function toRow(agg: Agg): FeLeaderboardRow {
  return toFeLeaderboardRow({
    wallet: agg.wallet,
    tier: "bronze",
    xp: 0,
    tradeCount: agg.boxesOpened,
    rewardsUsd: 0,
    boxesOpened: agg.boxesOpened,
    rewardsWon: agg.rewardsWon,
    ethWon: formatEthWon(agg.ethWei),
    rewardsLabel:
      agg.rewardsWon > 0
        ? `${agg.rewardsWon} won${agg.ethWei > 0n ? ` · ${formatEthWon(agg.ethWei)}` : ""}`
        : "0 won",
  });
}

async function loadRewardLeaderboard(): Promise<Agg[]> {
  const [openedBoxes, rewardRows] = await Promise.all([
    prisma.luckyBox.groupBy({
      by: ["walletId"],
      where: { openedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.reward.findMany({
      where: { luckyBoxId: { not: null } },
      select: {
        walletId: true,
        rewardType: true,
        token: true,
        amount: true,
        wallet: { select: { wallet: true } },
      },
    }),
  ]);

  const byWallet = new Map<string, Agg>();

  for (const r of rewardRows) {
    let row = byWallet.get(r.walletId);
    if (!row) {
      row = {
        walletId: r.walletId,
        wallet: r.wallet.wallet,
        boxesOpened: 0,
        rewardsWon: 0,
        ethWei: 0n,
      };
      byWallet.set(r.walletId, row);
    }
    if (isMissLabel(r.rewardType)) continue;
    row.rewardsWon += 1;
    if (r.token?.toUpperCase() === "ETH" && r.amount != null) {
      try {
        row.ethWei += BigInt(String(r.amount));
      } catch {
        /* ignore bad decimal */
      }
    }
  }

  const missingIds = openedBoxes.map((b) => b.walletId).filter((id) => !byWallet.has(id));
  if (missingIds.length > 0) {
    const wallets = await prisma.userWallet.findMany({
      where: { id: { in: missingIds } },
      select: { id: true, wallet: true },
    });
    for (const w of wallets) {
      byWallet.set(w.id, {
        walletId: w.id,
        wallet: w.wallet,
        boxesOpened: 0,
        rewardsWon: 0,
        ethWei: 0n,
      });
    }
  }

  for (const b of openedBoxes) {
    const row = byWallet.get(b.walletId);
    if (!row) continue;
    row.boxesOpened = b._count._all;
  }

  return [...byWallet.values()]
    .filter((r) => r.boxesOpened > 0 || r.rewardsWon > 0)
    .sort((a, b) => {
      if (b.rewardsWon !== a.rewardsWon) return b.rewardsWon - a.rewardsWon;
      if (b.ethWei !== a.ethWei) return b.ethWei > a.ethWei ? 1 : -1;
      return b.boxesOpened - a.boxesOpened;
    });
}

export async function registerLeaderboardRoutes(app: FastifyInstance) {
  app.get("/api/leaderboard/current", async (req) => {
    const q = req.query as { limit?: string; offset?: string; wallet?: string };
    const limit = Math.min(Number(q.limit ?? 20), 100);
    const offset = Number(q.offset ?? 0);

    const ranked = await loadRewardLeaderboard();
    const page = ranked.slice(offset, offset + limit).map(toRow);

    let you: FeLeaderboardRow | null = null;
    if (q.wallet) {
      const wallet = q.wallet.trim().toLowerCase();
      const mine = ranked.find((r) => r.wallet.toLowerCase() === wallet);
      if (mine) you = toRow(mine);
    }

    return {
      seasonId: null,
      mode: "lucky-box-rewards",
      data: page,
      you,
      limit,
      offset,
      message:
        ranked.length === 0
          ? "Rankings fill in as wallets open Lucky Boxes and win rewards."
          : undefined,
    };
  });
}
