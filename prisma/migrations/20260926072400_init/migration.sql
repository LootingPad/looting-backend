-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('upcoming', 'active', 'ended');

-- CreateEnum
CREATE TYPE "LaunchPhase" AS ENUM ('curve', 'graduated');

-- CreateEnum
CREATE TYPE "LaunchStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ConfirmationState" AS ENUM ('PENDING', 'CONFIRMED', 'FINALIZED', 'REORGED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LuckyBoxStatus" AS ENUM ('unclaimed', 'in_market', 'claimed', 'not_eligible', 'exited');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('pending', 'swapping', 'claimed', 'failed');

-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('active', 'ended', 'paused');

-- CreateEnum
CREATE TYPE "DevLockMode" AS ENUM ('time', 'vest');

-- CreateEnum
CREATE TYPE "DevLockCadence" AS ENUM ('day', 'week', 'month');

-- CreateEnum
CREATE TYPE "DevLockStatus" AS ENUM ('active', 'claimed', 'closed');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('bronze', 'silver', 'gold');

-- CreateEnum
CREATE TYPE "PendingActionKind" AS ENUM ('launch', 'staking_create', 'devlock_create', 'swap');

-- CreateTable
CREATE TABLE "users_wallets" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "wallet" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifetimeXp" BIGINT NOT NULL DEFAULT 0,
    "lifetimeTradeCount" INTEGER NOT NULL DEFAULT 0,
    "lifetimeBoxCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'upcoming',
    "configHash" TEXT NOT NULL,
    "bronzeThreshold" INTEGER NOT NULL DEFAULT 0,
    "silverThreshold" INTEGER NOT NULL DEFAULT 1000,
    "goldThreshold" INTEGER NOT NULL DEFAULT 5000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_wallet_stats" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "xp" BIGINT NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "boxesEarned" INTEGER NOT NULL DEFAULT 0,
    "boxesOpened" INTEGER NOT NULL DEFAULT 0,
    "tier" "Tier" NOT NULL DEFAULT 'bronze',
    "rank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_wallet_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launches" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "curve" TEXT,
    "pair" TEXT,
    "creator" TEXT NOT NULL,
    "creatorFeeRouter" TEXT,
    "creatorBps" INTEGER NOT NULL DEFAULT 0,
    "luckyBoxBps" INTEGER NOT NULL DEFAULT 0,
    "totalCreatorFeeBps" INTEGER NOT NULL DEFAULT 0,
    "holderShareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quoteAsset" TEXT,
    "launchTxHash" TEXT,
    "launchBlock" BIGINT,
    "launchedAt" TIMESTAMP(3),
    "phase" "LaunchPhase" NOT NULL DEFAULT 'curve',
    "status" "LaunchStatus" NOT NULL DEFAULT 'active',
    "rewardsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "configHash" TEXT,
    "name" TEXT,
    "symbol" TEXT,
    "imageUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "launchId" TEXT,
    "token" TEXT NOT NULL,
    "poolOrCurve" TEXT,
    "trader" TEXT NOT NULL,
    "walletId" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "tokenAmount" DECIMAL(78,0) NOT NULL,
    "quoteAmount" DECIMAL(78,0) NOT NULL,
    "direction" TEXT NOT NULL,
    "effectivePrice" DECIMAL(78,18),
    "usdNotional" DECIMAL(36,18),
    "sourceContract" TEXT,
    "isQualified" BOOLEAN NOT NULL DEFAULT false,
    "qualificationReason" TEXT,
    "confirmationState" "ConfirmationState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_boxes" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "launchId" TEXT,
    "seasonId" TEXT,
    "tier" "Tier" NOT NULL DEFAULT 'bronze',
    "status" "LuckyBoxStatus" NOT NULL DEFAULT 'unclaimed',
    "rewardConfigHash" TEXT,
    "earnedFromTradeId" TEXT,
    "openedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lucky_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "launchId" TEXT,
    "luckyBoxId" TEXT,
    "rewardType" TEXT NOT NULL,
    "token" TEXT,
    "amount" DECIMAL(78,0),
    "swapInput" DECIMAL(78,0),
    "swapOutput" DECIMAL(78,0),
    "swapTxHash" TEXT,
    "status" "RewardStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_treasury_ledger" (
    "id" TEXT NOT NULL,
    "launchId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "direction" TEXT NOT NULL,
    "txHash" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_treasury_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staking_vaults" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "vaultId" BIGINT NOT NULL,
    "vaultAddress" TEXT NOT NULL,
    "stakeToken" TEXT NOT NULL,
    "launchId" TEXT,
    "creator" TEXT NOT NULL,
    "rewardFunded" DECIMAL(78,0) NOT NULL,
    "rewardRemaining" DECIMAL(78,0) NOT NULL,
    "totalStaked" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "stakerCount" INTEGER NOT NULL DEFAULT 0,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "lockMask" INTEGER NOT NULL,
    "aprFlexBps" INTEGER NOT NULL DEFAULT 0,
    "apr30Bps" INTEGER NOT NULL DEFAULT 0,
    "apr90Bps" INTEGER NOT NULL DEFAULT 0,
    "createTxHash" TEXT,
    "createBlock" BIGINT,
    "feePaidWei" DECIMAL(78,0),
    "status" "VaultStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_vaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staking_positions" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "lockId" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "rewardsClaimed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lockStartedAt" TIMESTAMP(3),
    "lockEndsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dev_locks" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "lockId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "launchId" TEXT,
    "mode" "DevLockMode" NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "claimed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "startAt" TIMESTAMP(3) NOT NULL,
    "cliffAt" TIMESTAMP(3) NOT NULL,
    "unlockAt" TIMESTAMP(3) NOT NULL,
    "cadence" "DevLockCadence" NOT NULL DEFAULT 'day',
    "createTxHash" TEXT,
    "status" "DevLockStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dev_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_actions" (
    "id" TEXT NOT NULL,
    "kind" "PendingActionKind" NOT NULL,
    "wallet" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "idempotency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_table_configs" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_table_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_wallets_wallet_idx" ON "users_wallets"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "users_wallets_chainId_wallet_key" ON "users_wallets"("chainId", "wallet");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_seasonId_key" ON "seasons"("seasonId");

-- CreateIndex
CREATE INDEX "season_wallet_stats_seasonId_rank_idx" ON "season_wallet_stats"("seasonId", "rank");

-- CreateIndex
CREATE INDEX "season_wallet_stats_seasonId_xp_idx" ON "season_wallet_stats"("seasonId", "xp");

-- CreateIndex
CREATE UNIQUE INDEX "season_wallet_stats_seasonId_walletId_key" ON "season_wallet_stats"("seasonId", "walletId");

-- CreateIndex
CREATE INDEX "launches_creator_idx" ON "launches"("creator");

-- CreateIndex
CREATE INDEX "launches_status_phase_idx" ON "launches"("status", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "launches_chainId_token_key" ON "launches"("chainId", "token");

-- CreateIndex
CREATE INDEX "trades_token_trader_idx" ON "trades"("token", "trader");

-- CreateIndex
CREATE INDEX "trades_confirmationState_blockNumber_idx" ON "trades"("confirmationState", "blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "trades_txHash_logIndex_key" ON "trades"("txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_boxes_boxId_key" ON "lucky_boxes"("boxId");

-- CreateIndex
CREATE INDEX "lucky_boxes_walletId_status_idx" ON "lucky_boxes"("walletId", "status");

-- CreateIndex
CREATE INDEX "rewards_walletId_status_idx" ON "rewards"("walletId", "status");

-- CreateIndex
CREATE INDEX "reward_treasury_ledger_launchId_idx" ON "reward_treasury_ledger"("launchId");

-- CreateIndex
CREATE INDEX "staking_vaults_stakeToken_idx" ON "staking_vaults"("stakeToken");

-- CreateIndex
CREATE INDEX "staking_vaults_status_endsAt_idx" ON "staking_vaults"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "staking_vaults_chainId_vaultId_key" ON "staking_vaults"("chainId", "vaultId");

-- CreateIndex
CREATE UNIQUE INDEX "staking_vaults_chainId_vaultAddress_key" ON "staking_vaults"("chainId", "vaultAddress");

-- CreateIndex
CREATE INDEX "staking_positions_walletAddress_idx" ON "staking_positions"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "staking_positions_vaultId_walletAddress_lockId_key" ON "staking_positions"("vaultId", "walletAddress", "lockId");

-- CreateIndex
CREATE INDEX "dev_locks_owner_idx" ON "dev_locks"("owner");

-- CreateIndex
CREATE INDEX "dev_locks_token_idx" ON "dev_locks"("token");

-- CreateIndex
CREATE UNIQUE INDEX "dev_locks_chainId_lockId_key" ON "dev_locks"("chainId", "lockId");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_checkpoints_name_key" ON "indexer_checkpoints"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pending_actions_idempotency_key" ON "pending_actions"("idempotency");

-- CreateIndex
CREATE INDEX "pending_actions_wallet_kind_status_idx" ON "pending_actions"("wallet", "kind", "status");

-- AddForeignKey
ALTER TABLE "season_wallet_stats" ADD CONSTRAINT "season_wallet_stats_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_wallet_stats" ADD CONSTRAINT "season_wallet_stats_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "users_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "users_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_boxes" ADD CONSTRAINT "lucky_boxes_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "users_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_boxes" ADD CONSTRAINT "lucky_boxes_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_boxes" ADD CONSTRAINT "lucky_boxes_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_boxes" ADD CONSTRAINT "lucky_boxes_earnedFromTradeId_fkey" FOREIGN KEY ("earnedFromTradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "users_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_luckyBoxId_fkey" FOREIGN KEY ("luckyBoxId") REFERENCES "lucky_boxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_treasury_ledger" ADD CONSTRAINT "reward_treasury_ledger_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_vaults" ADD CONSTRAINT "staking_vaults_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_positions" ADD CONSTRAINT "staking_positions_vaultId_fkey" FOREIGN KEY ("vaultId") REFERENCES "staking_vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staking_positions" ADD CONSTRAINT "staking_positions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "users_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dev_locks" ADD CONSTRAINT "dev_locks_launchId_fkey" FOREIGN KEY ("launchId") REFERENCES "launches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
