import type { FastifyInstance } from "fastify";
import { FE_FEES, FE_STAKING_LOCK_OPTIONS } from "../lib/fe-shape.js";

export async function registerFeeRoutes(app: FastifyInstance) {
  app.get("/api/fees", async () => ({
    data: {
      ...FE_FEES,
      stakingLocks: FE_STAKING_LOCK_OPTIONS,
    },
  }));
}
