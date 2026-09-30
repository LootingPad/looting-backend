import type { FastifyInstance } from "fastify";
import { formatEther, parseAbi, type Address } from "viem";
import { getEthUsd } from "../clients/eth-price.js";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  toFeDevLock,
  toFeLaunch,
  toFeLuckyBox,
  toFeStakingPosition,
  toFeWallet,
  toFeWalletTrade,
  lockIdToFe,
  rawToUiAmount,
} from "../lib/fe-shape.js";
import { readDevLockClaimable, readPendingRewards } from "../lib/actions.js";
import { normalizeAddress, xpForQualifiedTrade } from "../lib/utils.js";
import { reconcileWalletBoxExits } from "../services/trade-rewards.js";
import { getCurrentSeason } from "../services/xp.js";

const rewardRouterViewAbi = parseAbi([
  "function luckyBoxClaimable(address token) view returns (uint256)",
]);

async function liveBoxPoolsByToken(tokens: string[], ethUsd: number): Promise<Map<string, { eth: number; usd: number }>> {
  const out = new Map<string, { eth: number; usd: number }>();
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => /^0x[a-f0-9]{40}$/.test(t)))];
  if (unique.length === 0 || !env.LOOTING_REWARD_ROUTER) return out;
  try {
    const client = getPublicClient();
    const router = env.LOOTING_REWARD_ROUTER as Address;
    const rows = await client.multicall({
      allowFailure: true,
      contracts: unique.map((token) => ({
        address: router,
        abi: rewardRouterViewAbi,
        functionName: "luckyBoxClaimable" as const,
        args: [token as Address] as const,
      })),
    });
    unique.forEach((token, i) => {
      const row = rows[i];
      const wei = row?.status === "success" && typeof row.result === "bigint" ? row.result : 0n;
      const eth = Number(formatEther(wei));
      const safeEth = Number.isFinite(eth) && eth > 0 ? eth : 0;
      out.set(token, {
        eth: safeEth,
        usd: safeEth > 0 && ethUsd > 0 ? safeEth * ethUsd : 0,
      });
    });
  } catch {
    /* leave empty — FE hides pool cell */
  }
  return out;
}

export async function registerWalletRoutes(app: FastifyInstance) {
  app.get("/api/wallet/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    const season = await getCurrentSeason();
    let seasonXp = 0n;
    let tier = "bronze";
    let rank: number | null = null;
    let tradeCount = 0;

    if (user && season) {
      const stats = await prisma.seasonWalletStat.findUnique({
        where: { seasonId_walletId: { seasonId: season.id, walletId: user.id } },
      });
      if (stats) {
        seasonXp = stats.xp;
        tier = stats.tier;
        rank = stats.rank;
        tradeCount = stats.tradeCount;
      }
    }

    const boxesAvailable = user
      ? await prisma.luckyBox.count({
          where: { walletId: user.id, status: { in: ["unclaimed", "in_market"] } },
        })
      : 0;

    return {
      data: toFeWallet({
        wallet,
        tier,
        seasonXp,
        tradeCount: tradeCount || (user?.lifetimeTradeCount ?? 0),
        lifetimeXp: user?.lifetimeXp ?? 0n,
        lifetimeTradeCount: user?.lifetimeTradeCount ?? 0,
        lifetimeBoxCount: user?.lifetimeBoxCount ?? 0,
        luckyBoxesAvailable: boxesAvailable,
        rank,
        seasonId: season?.seasonId ?? null,
      }),
    };
  });

  app.get("/api/wallet/:address/rewards", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    if (!user) return { data: [] };

    const rewards = await prisma.reward.findMany({
      where: { walletId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return {
      data: rewards.map((r) => ({
        id: r.id,
        rewardType: r.rewardType,
        token: r.token,
        amount: r.amount?.toString() ?? null,
        status: r.status,
        swapTxHash: r.swapTxHash,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.get("/api/wallet/:address/lucky-boxes", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const user = await prisma.userWallet.findUnique({
      where: { chainId_wallet: { chainId: env.CHAIN_ID, wallet } },
    });
    if (!user) return { data: [] };

    // Catch sells that never hit /api/trade/confirm (or left dust after "sell all").
    await reconcileWalletBoxExits(user.id, wallet);

    const boxes = await prisma.luckyBox.findMany({
      where: { walletId: user.id },
      include: { launch: true, rewards: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const ethUsd = await getEthUsd().catch(() => 0);
    const prizeTokens = [
      ...new Set(
        boxes
          .flatMap((b) => b.rewards.map((r) => r.token))
          .filter((t): t is string => typeof t === "string" && t !== "ETH" && t.startsWith("0x"))
          .map((t) => t.toLowerCase()),
      ),
    ];
    const prizeRows =
      prizeTokens.length > 0
        ? await prisma.rewardPrizeToken.findMany({ where: { token: { in: prizeTokens } } })
        : [];
    const prizeByToken = new Map(prizeRows.map((r) => [r.token.toLowerCase(), r]));
    const poolByToken = await liveBoxPoolsByToken(
      boxes.map((b) => b.launch?.token ?? "").filter(Boolean),
      ethUsd,
    );

    return {
      data: boxes.map((b) => {
        const latest = b.rewards[b.rewards.length - 1];
        const meta =
          latest?.token && latest.token !== "ETH"
            ? prizeByToken.get(latest.token.toLowerCase())
            : undefined;
        const pool = b.launch?.token ? poolByToken.get(b.launch.token.toLowerCase()) : undefined;
        return toFeLuckyBox(
          b,
          { token: b.launch?.token, symbol: b.launch?.symbol },
          {
            ethUsd,
            prizeLabel: meta?.label ?? (latest?.token === "ETH" ? "ETH" : null),
            prizeDecimals: meta?.decimals ?? 18,
            boxPoolEth: pool?.eth,
            boxPoolUsd: pool?.usd,
          },
        );
      }),
    };
  });

  app.get("/api/wallet/:address/staking-positions", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const positions = await prisma.stakingPosition.findMany({
      where: { walletAddress: wallet },
      include: { vault: { include: { launch: true } } },
      orderBy: { updatedAt: "desc" },
    });

    const data = await Promise.all(
      positions.map(async (p) => {
        const claimable = await readPendingRewards(p.vault.vaultAddress, wallet, p.lockId);
        return toFeStakingPosition(p, p.vault, {
          name: p.vault.launch?.name,
          symbol: p.vault.launch?.symbol,
          claimable,
        });
      }),
    );

    return { data };
  });

  app.get("/api/wallet/:address/staking-history", async (req, reply) => {
    const { address } = req.params as { address: string };
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const offset = Number(q.offset ?? 0);

    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const rows = await prisma.stakingActivity.findMany({
      where: { chainId: env.CHAIN_ID, walletAddress: wallet },
      orderBy: { at: "desc" },
      take: limit,
      skip: offset,
    });

    const vaultIds = [...new Set(rows.map((r) => r.vaultId))];
    const numericIds = vaultIds.filter((id) => /^\d+$/.test(id)).map((id) => BigInt(id));
    const addressIds = vaultIds.map((id) => id.toLowerCase());
    const vaults =
      vaultIds.length === 0
        ? []
        : await prisma.stakingVault.findMany({
            where: {
              chainId: env.CHAIN_ID,
              OR: [
                ...(numericIds.length ? [{ vaultId: { in: numericIds } }] : []),
                ...(addressIds.length ? [{ vaultAddress: { in: addressIds } }] : []),
              ],
            },
            include: { launch: true },
          });
    const byVaultId = new Map(vaults.map((v) => [v.vaultId.toString(), v]));
    const byAddress = new Map(vaults.map((v) => [v.vaultAddress, v]));

    return {
      data: rows.map((r) => {
        const vault = byVaultId.get(r.vaultId) ?? byAddress.get(r.vaultId.toLowerCase());
        return {
          id: r.id,
          eventId: vault?.vaultId.toString() ?? r.vaultId,
          address: vault?.stakeToken ?? "",
          symbol: vault?.launch?.symbol ?? "",
          name: vault?.launch?.name ?? "",
          kind: r.kind as "stake" | "claim" | "unstake",
          lock: lockIdToFe(r.lockId),
          amount: rawToUiAmount(r.amount),
          reward: rawToUiAmount(r.reward),
          at: r.at.getTime(),
          txHash: r.txHash,
        };
      }),
      limit,
      offset,
    };
  });

  app.get("/api/wallet/:address/dev-locks", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const locks = await prisma.devLock.findMany({
      where: { chainId: env.CHAIN_ID, owner: wallet },
      include: { launch: true },
      orderBy: { createdAt: "desc" },
    });

    const data = await Promise.all(
      locks.map(async (l) => {
        const shaped = toFeDevLock(l, {
          name: l.launch?.name,
          symbol: l.launch?.symbol,
        });
        const claimable = await readDevLockClaimable(l.lockId);
        return { ...shaped, claimable };
      }),
    );

    return { data };
  });

  app.get("/api/wallet/:address/trades", async (req, reply) => {
    const { address } = req.params as { address: string };
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const offset = Number(q.offset ?? 0);

    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const trades = await prisma.trade.findMany({
      where: {
        trader: wallet,
        chainId: env.CHAIN_ID,
        confirmationState: { in: ["CONFIRMED", "FINALIZED", "PENDING"] },
      },
      include: { launch: true },
      orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }],
      take: limit,
      skip: offset,
    });

    const ethUsd = await getEthUsd();
    return {
      data: trades.map((t) => {
        const usd = t.usdNotional == null ? 0 : Number(String(t.usdNotional));
        const launch = t.launch
          ? toFeLaunch(t.launch)
          : toFeLaunch({
              token: t.token,
              creator: "",
              phase: "curve",
              luckyBoxBps: 0,
              totalCreatorFeeBps: 0,
              name: null,
              symbol: null,
              description: null,
            });
        return toFeWalletTrade(t, launch, xpForQualifiedTrade(usd), ethUsd);
      }),
      limit,
      offset,
    };
  });
}
