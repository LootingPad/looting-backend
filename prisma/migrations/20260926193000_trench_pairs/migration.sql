CREATE TABLE "trench_pairs" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "totalSupply" TEXT NOT NULL,
    "logo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "twitter" TEXT NOT NULL DEFAULT '',
    "telegram" TEXT NOT NULL DEFAULT '',
    "discord" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "farcaster" TEXT NOT NULL DEFAULT '',
    "deployer" TEXT NOT NULL,
    "curve" TEXT NOT NULL,
    "pairToken" TEXT NOT NULL,
    "launchConfigId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "launchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trench_pairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trench_pairs_chainId_token_key" ON "trench_pairs"("chainId", "token");
CREATE INDEX "trench_pairs_chainId_blockNumber_idx" ON "trench_pairs"("chainId", "blockNumber");
