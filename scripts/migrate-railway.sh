#!/usr/bin/env bash
# Apply pending Prisma migrations using DATABASE_URL from .env (Railway public proxy).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env — set DATABASE_URL to the Railway Postgres public URL."
  exit 1
fi

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
if [[ -z "${DATABASE_URL}" ]]; then
  echo "DATABASE_URL is empty in .env"
  exit 1
fi
export DATABASE_URL

echo "Running: npx prisma migrate deploy"
node -e "const u=new URL(process.env.DATABASE_URL); console.log('Target:', u.hostname + ':' + (u.port||'5432') + '/' + u.pathname.replace(/^\//,''))"
npx prisma migrate deploy
echo "Migrate OK."
