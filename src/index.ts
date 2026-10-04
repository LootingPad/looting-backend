import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import {
  startPonsapiLiveFeed,
  stopPonsapiLiveFeed,
} from "./pons-adapter/live-feed.js";
import { registerAdminRoutes } from "./modules/admin.js";
import { registerAnalyticsRoutes } from "./modules/analytics.js";
import { registerChartRoutes, registerMetadataRoutes } from "./modules/charts.js";
import {
  registerRewardTableRoutes,
  registerStakingConfigRoutes,
} from "./modules/config-public.js";
import { registerLootingTokenRoutes } from "./modules/site-config.js";
import { registerFeeClaimRoutes } from "./modules/fee-claims.js";
import { registerFeeRoutes } from "./modules/fees.js";
import { registerFeedRoutes } from "./modules/feed.js";
import { registerHealthRoutes } from "./modules/health.js";
import { registerLaunchRoutes } from "./modules/launches.js";
import { registerLeaderboardRoutes } from "./modules/leaderboard.js";
import { registerLuckyBoxRoutes } from "./modules/lucky-boxes.js";
import { registerMediaRoutes } from "./modules/media.js";
import { registerPrepareRoutes, registerSwapRoutes } from "./modules/prepare.js";
import { registerSeasonRoutes } from "./modules/seasons.js";
import {
  registerDevLockClaimRoutes,
  registerStakingActionRoutes,
} from "./modules/staking-actions.js";
import { registerStakingRoutes } from "./modules/staking.js";
import { registerCurveTradeRoutes } from "./modules/curve-trade.js";
import { registerTrenchRoutes } from "./modules/trenches.js";
import { registerWalletRoutes } from "./modules/wallet.js";
import { startTrenchIndexer } from "./pons-adapter/indexer.js";

async function main() {
  const app = Fastify({
    logger: true,
    // Launch logos arrive as base64 data URLs (~1.5 MB raw → ~2 MB encoded).
    bodyLimit: 2_500_000,
  });

  const corsOrigins = env.CORS_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((origin) =>
      /^https?:\/\/(www\.)?lootingpad\.com$/i.test(origin)
        ? "https://looting-web-production.up.railway.app"
        : origin,
    );
  for (const extra of [
    "https://looting-web-production.up.railway.app",
    "https://looting-admin-production.up.railway.app",
  ]) {
    if (!corsOrigins.includes("*") && !corsOrigins.includes(extra)) corsOrigins.push(extra);
  }

  await app.register(cors, {
    origin: corsOrigins,
  });

  await registerHealthRoutes(app);
  await registerFeeRoutes(app);
  await registerFeeClaimRoutes(app);
  await registerMediaRoutes(app);
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
  await registerLootingTokenRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerFeedRoutes(app);
  await registerChartRoutes(app);
  await registerMetadataRoutes(app);
  await registerPrepareRoutes(app);
  await registerSwapRoutes(app);
  await registerCurveTradeRoutes(app);
  await registerAdminRoutes(app);
  await registerTrenchRoutes(app);
  startTrenchIndexer();


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
    stopPonsapiLiveFeed();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`LOOTING API listening on :${env.PORT} (chain ${env.CHAIN_ID})`);
  startPonsapiLiveFeed(app.log);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
