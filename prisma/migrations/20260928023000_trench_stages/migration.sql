ALTER TABLE "trench_pairs" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'new';
ALTER TABLE "trench_pairs" ADD COLUMN "bondingPercentage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "trench_pairs" ADD COLUMN "chainPhase" TEXT NOT NULL DEFAULT 'NotGraduated';
ALTER TABLE "trench_pairs" ADD COLUMN "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "trench_pairs_chainId_stage_bondingPercentage_idx" ON "trench_pairs"("chainId", "stage", "bondingPercentage");
CREATE INDEX "trench_pairs_chainId_stage_stageChangedAt_idx" ON "trench_pairs"("chainId", "stage", "stageChangedAt");
