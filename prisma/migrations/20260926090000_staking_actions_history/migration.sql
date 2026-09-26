DO $$ BEGIN ALTER TYPE "PendingActionKind" ADD VALUE 'staking_stake'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "PendingActionKind" ADD VALUE 'staking_unstake'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "PendingActionKind" ADD VALUE 'staking_claim'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "PendingActionKind" ADD VALUE 'devlock_claim'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "PendingActionKind" ADD VALUE 'lucky_box_open'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "staking_activities" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "vaultId" TEXT NOT NULL,
    "vaultDbId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lockId" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "reward" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staking_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staking_activities_walletAddress_at_idx" ON "staking_activities"("walletAddress", "at");
CREATE INDEX IF NOT EXISTS "staking_activities_vaultId_at_idx" ON "staking_activities"("vaultId", "at");
