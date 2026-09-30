import type { FastifyInstance } from "fastify";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { FE_FEES, toFeLaunch } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";

function feeAccrualWeight(progress: number) {
  return 0.35 + progress / 200;
}

const rewardRouterAbi = parseAbi([
  "function claimCreator(address token) returns (uint256 amount)",
  "function creatorClaimable(address token) view returns (uint256)",
]);

/**
 * Creator tax (Pons creatorFeeRecipient = RewardRouter):
 * - Accrues on RewardRouter after sweep+harvest+allocate
 * - Claim prepares `claimCreator(token)` to the registry creator wallet
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

    const creator = created.map((l) => {
      const shaped = toFeLaunch(l);
      const feeUsd =
        shaped.marketCap * (shaped.creatorTax / 100) * feeAccrualWeight(shaped.progress);
      const creatorUsd = feeUsd * (1 - shaped.luckyShare / 100);
      return {
        token: shaped.address,
        symbol: shaped.symbol,
        name: shaped.name,
        estimatedUsd: creatorUsd,
        estimatedEth: creatorUsd / FE_FEES.ETH_USD,
        claimable: creatorUsd > 0,
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

    const tokens: string[] = [];
    if (token) {
      const launch = await prisma.launch.findUnique({
        where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      });
      if (launch && launch.creator !== wallet) {
        return reply.code(403).send({ error: "NOT_CREATOR", message: "Only the creator can claim." });
      }
      tokens.push(token);
    } else {
      const launches = await prisma.launch.findMany({
        where: { chainId: env.CHAIN_ID, creator: wallet, status: "active" },
        take: 50,
      });
      if (launches.length === 0) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "No creator launches to claim." });
      }
      tokens.push(...launches.map((l) => l.token));
    }

    if (!env.LOOTING_REWARD_ROUTER) {
      return {
        data: {
          mode: "auto_settled",
          calls: [],
          tokens,
          message: "Creator fees settle to your wallet on every trade. Marked as received.",
        },
      };
    }

    const router = getAddress(env.LOOTING_REWARD_ROUTER) as Address;
    const calls = tokens.map((t) => ({
      to: router,
      data: encodeFunctionData({
        abi: rewardRouterAbi,
        functionName: "claimCreator",
        args: [getAddress(t) as Address],
      }) as Hex,
      value: "0",
    }));

    return {
      data: {
        mode: "reward_router",
        calls,
        tokens,
        message: "Confirm in wallet to claim creator fees from LootingRewardRouter.",
      },
    };
  });
}
