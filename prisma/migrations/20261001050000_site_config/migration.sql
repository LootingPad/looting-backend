-- CreateTable
CREATE TABLE "site_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lootingTokenAddress" TEXT NOT NULL DEFAULT '',
    "symbol" TEXT NOT NULL DEFAULT 'LOOTING',
    "name" TEXT NOT NULL DEFAULT 'LOOTING',
    "tagline" TEXT NOT NULL DEFAULT '',
    "blurb" TEXT NOT NULL DEFAULT '',
    "burnAllocationPct" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "asOfLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_configs_pkey" PRIMARY KEY ("id")
);
