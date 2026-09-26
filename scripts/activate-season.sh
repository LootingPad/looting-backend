#!/usr/bin/env bash
# One-shot: create / activate season s1 on whatever DATABASE_URL is in .env
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)
HASH=$(printf '%s' '{"seasonId":"s1","bronze":0,"silver":1000,"gold":5000}' | shasum -a 256 | awk '{print $1}')
npx prisma db execute --schema prisma/schema.prisma --stdin <<SQL
UPDATE "seasons" SET status = 'ended' WHERE status = 'active';
INSERT INTO "seasons" ("id","seasonId","startsAt","endsAt","status","configHash","bronzeThreshold","silverThreshold","goldThreshold","createdAt","updatedAt")
VALUES (
  gen_random_uuid()::text,
  's1',
  '${START}'::timestamptz,
  '${END}'::timestamptz,
  'active',
  '${HASH}',
  0, 1000, 5000,
  NOW(), NOW()
)
ON CONFLICT ("seasonId") DO UPDATE SET
  "startsAt" = EXCLUDED."startsAt",
  "endsAt" = EXCLUDED."endsAt",
  status = 'active',
  "configHash" = EXCLUDED."configHash",
  "bronzeThreshold" = 0,
  "silverThreshold" = 1000,
  "goldThreshold" = 5000,
  "updatedAt" = NOW();
SQL
echo "season s1 active until $END"
