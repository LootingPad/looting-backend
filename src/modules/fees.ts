import type { FastifyInstance } from "fastify";
import { getEthUsd } from "../clients/eth-price.js";
import { FE_FEES, FE_STAKING_LOCK_OPTIONS } from "../lib/fe-shape.js";

export async function registerFeeRoutes(app: FastifyInstance) {
  app.get("/api/fees", async () => {
    const ethUsd = await getEthUsd();
    return {
      data: {
        ...FE_FEES,
        ETH_USD: ethUsd,
        stakingLocks: FE_STAKING_LOCK_OPTIONS,
      },
    };
  });
}
