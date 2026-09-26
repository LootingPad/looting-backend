import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { registerAdminRoutes } from "./modules/admin.js";
import { registerAnalyticsRoutes } from "./modules/analytics.js";
import { registerChartRoutes, registerMetadataRoutes } from "./modules/charts.js";
import {
  registerRewardTableRoutes,
  registerStakingConfigRoutes,
} from "./modules/config-public.js";
import { registerFeeClaimRoutes } from "./modules/fee-claims.js";
import { registerFeeRoutes } from "./modules/fees.js";
import { registerHealthRoutes } from "./modules/health.js";
import { registerLaunchRoutes } from "./modules/launches.js";
import { registerLeaderboardRoutes } from "./modules/leaderboard.js";
import { registerLuckyBoxRoutes } from "./modules/lucky-boxes.js";
import { registerPrepareRoutes, registerSwapRoutes } from "./modules/prepare.js";
import { registerSeasonRoutes } from "./modules/seasons.js";
import {
  registerDevLockClaimRoutes,
  registerStakingActionRoutes,
} from "./modules/staking-actions.js";
import { registerStakingRoutes } from "./modules/staking.js";
import { registerWalletRoutes } from "./modules/wallet.js";

async function main() {
  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
  });

  await registerHealthRoutes(app);
  await registerFeeRoutes(app);
  await registerFeeClaimRoutes(app);
  await registerLaunchRoutes(app);
  await registerWalletRoutes(app);
  await registerSeasonRoutes(app);
  await registerLeaderboardRoutes(app);
  await registerStakingRoutes(app);
  await registerStakingConfigRoutes(app);
  await registerStakingActionRoutes(app);
  await registerDevLockClaimRoutes(app);
  await registerLuckyBoxRoutes(app);
  await registerRewardTableRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerChartRoutes(app);
  await registerMetadataRoutes(app);
  await registerPrepareRoutes(app);
  await registerSwapRoutes(app);
  await registerAdminRoutes(app);


  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const error = err as { statusCode?: number; message?: string };
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? "INTERNAL" : "REQUEST_ERROR",
      message: error.message ?? "unknown",
    });
  });

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`LOOTING API listening on :${env.PORT} (chain ${env.CHAIN_ID})`);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
