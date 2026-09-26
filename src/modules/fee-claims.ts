import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { FE_FEES, toFeLaunch } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";

function feeAccrualWeight(progress: number) {
  return 0.35 + progress / 200;
}

/**
 * Creator / holder trading-fee claims need LootingRewardRouter (not shipped).
 * Expose estimated claimable from launch economics so the FE can render the claim UI
 * disabled with an honest reason instead of inventing paid claims.
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

    const holderEligible = await prisma.launch.findMany({
      where: {
        chainId: env.CHAIN_ID,
        holderShareEnabled: true,
        status: "active",
      },
      take: 100,
    });

    const creator = created.map((l) => {
      const shaped = toFeLaunch(l);
      const feeUsd =
        shaped.marketCap * (shaped.creatorTax / 100) * feeAccrualWeight(shaped.progress);
      const creatorUsd = feeUsd * (1 - shaped.luckyShare / 100) * FE_FEES.CREATOR_FEE_SHARE;
      return {
        token: shaped.address,
        symbol: shaped.symbol,
        name: shaped.name,
        estimatedUsd: creatorUsd,
        estimatedEth: creatorUsd / FE_FEES.ETH_USD,
        claimable: false,
      };
    });

    // Without balance indexer we cannot prove holder share; return empty with flag.
    const holder = holderEligible.length
      ? holderEligible.slice(0, 0).map((l) => {
          const shaped = toFeLaunch(l);
          return {
            token: shaped.address,
            symbol: shaped.symbol,
            name: shaped.name,
            estimatedUsd: 0,
            estimatedEth: 0,
            claimable: false,
          };
        })
      : [];

    return {
      data: {
        available: false,
        reason: "FEE_ROUTER_NOT_DEPLOYED",
        message:
          "Creator/holder trading-fee claims require LootingRewardRouter. Estimates are display-only.",
        creator,
        holder,
        totalCreatorEth: creator.reduce((sum, row) => sum + row.estimatedEth, 0),
        totalHolderEth: 0,
      },
    };
  });

  app.post("/api/fees/claim/prepare", async (_req, reply) => {
    return reply.code(503).send({
      error: "FEE_ROUTER_NOT_DEPLOYED",
      message:
        "Creator/holder fee claim prepare is unavailable until LootingRewardRouter is deployed.",
    });
  });
}
