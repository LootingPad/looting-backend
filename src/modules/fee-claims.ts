import type { FastifyInstance } from "fastify";
import { encodeFunctionData, formatEther, getAddress, parseAbi, type Address, type Hex } from "viem";
import { getEthUsd } from "../clients/eth-price.js";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { accruedFeeUsdFromLaunch, toFeLaunch } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import { allocateTaxToLaunch } from "../services/reward-router.js";

const rewardRouterAbi = parseAbi([
  "function claimCreator(address token) returns (uint256 amount)",
  "function creatorClaimable(address token) view returns (uint256)",
]);

/**
 * Creator tax (Pons creatorFeeRecipient = RewardRouter):
 * - Accrues on RewardRouter after sweep+harvest+allocate
 * - Claim prepares `claimCreator(token)` — ETH pays to registry.creator
 * Lucky Box pool payouts go through the Rewards open flow.
 */
export async function registerFeeClaimRoutes(app: FastifyInstance) {
  app.get("/api/wallet/:address/fee-claims", async (req, reply) => {
    const { address } = req.params as { address: string };
    let wallet: string;
    try {
      wallet = normalizeAddress(address);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const created = await prisma.launch.findMany({
      where: { chainId: env.CHAIN_ID, creator: wallet, status: "active" },
    });

    const routerMode = Boolean(env.LOOTING_REWARD_ROUTER);
    const ethUsd = await getEthUsd();

    const volumes = await prisma.trade.groupBy({
      by: ["launchId"],
      where: {
        chainId: env.CHAIN_ID,
        launchId: { in: created.map((l) => l.id) },
        confirmationState: { in: ["CONFIRMED", "FINALIZED", "PENDING"] },
      },
      _sum: { usdNotional: true },
    });
    const volumeByLaunch = new Map(
      volumes.map((row) => [row.launchId, Number(row._sum.usdNotional ?? 0)]),
    );

    let liveByToken = new Map<string, bigint>();
    if (routerMode && created.length > 0 && env.LOOTING_REWARD_ROUTER) {
      try {
        const client = getPublicClient();
        const router = getAddress(env.LOOTING_REWARD_ROUTER) as Address;
        const rows = await client.multicall({
          allowFailure: true,
          contracts: created.map((l) => ({
            address: router,
            abi: rewardRouterAbi,
            functionName: "creatorClaimable" as const,
            args: [getAddress(l.token) as Address] as const,
          })),
        });
        liveByToken = new Map(
          created.map((l, i) => {
            const row = rows[i];
            const wei =
              row?.status === "success" && typeof row.result === "bigint" ? row.result : 0n;
            return [l.token.toLowerCase(), wei] as const;
          }),
        );
      } catch {
        liveByToken = new Map();
      }
    }

    const creator = created.map((l) => {
      const shaped = toFeLaunch(l);
      const liveWei = liveByToken.get(l.token.toLowerCase()) ?? 0n;
      const liveEth = liveWei > 0n ? Number(formatEther(liveWei)) : 0;
      const volumeUsd = volumeByLaunch.get(l.id) ?? 0;
      const feeUsd = accruedFeeUsdFromLaunch(shaped, volumeUsd);
      const creatorUsd = feeUsd * (1 - shaped.luckyShare / 100);
      const estimatedEth = liveEth > 0 ? liveEth : ethUsd > 0 ? creatorUsd / ethUsd : 0;
      return {
        token: shaped.address,
        symbol: shaped.symbol,
        name: shaped.name,
        estimatedUsd: liveEth > 0 && ethUsd > 0 ? liveEth * ethUsd : creatorUsd,
        estimatedEth,
        claimableWei: liveWei.toString(),
        claimable: liveWei > 0n,
        mode: routerMode ? ("reward_router" as const) : ("auto_settled" as const),
      };
    });

    return {
      data: {
        available: creator.some((row) => row.claimable),
        reason: routerMode ? "REWARD_ROUTER" : "AUTO_SETTLED",
        message: routerMode
          ? "Creator fees accrue on LootingRewardRouter after curve sweep. Claim pulls ETH to your creator wallet."
          : "Creator fees settle to your wallet on every trade (legacy).",
        creator,
        holder: [],
        totalCreatorEth: creator.reduce((sum, row) => sum + row.estimatedEth, 0),
        totalHolderEth: 0,
        rewardRouter: env.LOOTING_REWARD_ROUTER || null,
      },
    };
  });

  app.post("/api/fees/claim/prepare", async (req, reply) => {
    const body = (req.body ?? {}) as {
      wallet?: string;
      token?: string;
      kind?: "creator" | "pool" | "holder";
    };
    const kind = body.kind ?? "creator";

    if (kind === "pool" || kind === "holder") {
      return reply.code(503).send({
        error: "FEE_ROUTER_NOT_DEPLOYED",
        message:
          "Lucky Box pool payouts go through the Rewards open flow once the lucky-box module is live.",
      });
    }

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet ?? "");
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS", message: "Connect a wallet first." });
    }

    let token: string | undefined;
    if (body.token?.trim()) {
      try {
        token = normalizeAddress(body.token);
      } catch {
        return reply.code(400).send({ error: "INVALID_TOKEN" });
      }
    }

    type LaunchRow = { token: string; curve: string | null; creator: string };
    const launches: LaunchRow[] = [];
    if (token) {
      const launch = await prisma.launch.findUnique({
        where: { chainId_token: { chainId: env.CHAIN_ID, token } },
        select: { token: true, curve: true, creator: true },
      });
      if (!launch) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "Launch not found in LOOTING registry." });
      }
      if (launch.creator !== wallet) {
        return reply.code(403).send({ error: "NOT_CREATOR", message: "Only the creator can claim." });
      }
      launches.push(launch);
    } else {
      const rows = await prisma.launch.findMany({
        where: { chainId: env.CHAIN_ID, creator: wallet, status: "active" },
        take: 50,
        select: { token: true, curve: true, creator: true },
      });
      if (rows.length === 0) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "No creator launches to claim." });
      }
      launches.push(...rows);
    }

    if (!env.LOOTING_REWARD_ROUTER) {
      return {
        data: {
          mode: "auto_settled",
          calls: [],
          tokens: launches.map((l) => l.token),
          message: "Creator fees settle to your wallet on every trade. Marked as received.",
        },
      };
    }

    // Settle pending curve tax into creatorClaimable before building the wallet call.
    for (const launch of launches) {
      try {
        await allocateTaxToLaunch({ token: launch.token, curve: launch.curve });
      } catch (err) {
        console.warn("[fee-claims] settle before claim failed", launch.token, err);
      }
    }

    const router = getAddress(env.LOOTING_REWARD_ROUTER) as Address;
    const client = getPublicClient();
    const claimables = await client.multicall({
      allowFailure: true,
      contracts: launches.map((l) => ({
        address: router,
        abi: rewardRouterAbi,
        functionName: "creatorClaimable" as const,
        args: [getAddress(l.token) as Address] as const,
      })),
    });

    const payable = launches.filter((_, i) => {
      const row = claimables[i];
      return row?.status === "success" && typeof row.result === "bigint" && row.result > 0n;
    });

    if (payable.length === 0) {
      return reply.code(409).send({
        error: "NOTHING_CLAIMABLE",
        message:
          "No creator fee is claimable right now. New trade tax may still be settling — try again in a few seconds.",
      });
    }

    const calls = payable.map((l) => ({
      to: router,
      data: encodeFunctionData({
        abi: rewardRouterAbi,
        functionName: "claimCreator",
        args: [getAddress(l.token) as Address],
      }) as Hex,
      value: "0",
    }));

    const totalWei = payable.reduce((sum, _, i) => {
      const idx = launches.findIndex((l) => l.token === payable[i]!.token);
      const row = claimables[idx];
      const wei = row?.status === "success" && typeof row.result === "bigint" ? row.result : 0n;
      return sum + wei;
    }, 0n);

    return {
      data: {
        mode: "reward_router",
        calls,
        tokens: payable.map((l) => l.token),
        claimableWei: totalWei.toString(),
        claimableEth: formatEther(totalWei),
        message: "Confirm in wallet to claim creator fees from LootingRewardRouter.",
      },
    };
  });
}
