-- CreateTable
CREATE TABLE "reward_prize_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_prize_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reward_prize_tokens_token_key" ON "reward_prize_tokens"("token");

-- CreateIndex
CREATE INDEX "reward_prize_tokens_approved_idx" ON "reward_prize_tokens"("approved");
