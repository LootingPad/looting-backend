# LOOTING Backend

TypeScript API + indexer for the LOOTING launchpad. Canonical product source:
`../looting/LOOTING_PRODUCT_SPEC.md` (especially §§18, 21, 22, 24, 38).

Contracts stay authoritative for custody. This service never holds user funds —
`prepare` builds calldata, the wallet signs, `confirm` waits for finality and
mirrors state into Postgres.

## Stack

- Fastify + TypeScript
- Prisma + PostgreSQL
- viem → Phantom Robinhood RPC (`chainId` 4663)
- Mobula for charts (OHLCV) and token metadata
- Uniswap V3 SwapRouter02 quote/prepare on Robinhood (V4 Universal Router path deferred)

## Quick start

```bash
cp .env.example .env   # set MOBULA_API_KEY and ADMIN_API_TOKEN
docker compose up -d
npm install
npx prisma migrate dev --name init
npm run dev            # API on :8080
npm run dev:indexer    # separate process
```

## Env / Railway

`.env.example` is Railway-ready: paste the same keys into a Railway service later.
Do **not** commit `.env`. If a Mobula key was shared in chat, rotate it.

Contract addresses come from `../looting-contracts/deployments/<chainId>.json`
after deploy (`LAUNCH_REGISTRY_ADDRESS`, `DEV_LOCK_ADDRESS`, `STAKING_FACTORY_ADDRESS`).
Until those are set, prepare endpoints return `CONTRACTS_NOT_CONFIGURED`.

### Deploy two services (API + indexer)

`INDEXER_ENABLED=true` does **not** start the worker by itself. The API
(`npm start`) and indexer (`npm run start:indexer`) are separate processes.

1. **API service** (already live): start command
   `npx prisma migrate deploy && npm start` — see `railway.toml`.
2. **Indexer service**: New → same GitHub repo → copy all Variables from API →
   override **Start Command** to `npm run start:indexer` (no public domain).
3. Deploy logs must show `[indexer] starting on chain 4663`.

Activate a season (once):

```bash
./scripts/activate-season.sh
```

## API surface (Spec §22)

| Method | Path |
|---|---|
| GET | `/health` |
| GET | `/api/fees` (includes `ETH_USD`, `stakingLocks`) |
| GET | `/api/launches` (each row includes `stats`) |
| GET | `/api/launches/:token` |
| GET | `/api/launches/:token/trades` |
| GET | `/api/launches/:token/holders` |
| GET | `/api/creator/:address/launches` |
| GET | `/api/launch/:token/rewards` |
| GET | `/api/seasons/current` |
| GET | `/api/wallet/:address` |
| GET | `/api/wallet/:address/rewards` |
| GET | `/api/wallet/:address/lucky-boxes` |
| GET | `/api/wallet/:address/staking-positions` (live `claimable`) |
| GET | `/api/wallet/:address/staking-history` |
| GET | `/api/wallet/:address/dev-locks` (live `claimable`) |
| GET | `/api/wallet/:address/trades` |
| GET | `/api/wallet/:address/fee-claims` (estimates; router not deployed) |
| GET | `/api/staking/events`, `/api/staking/events/:vaultId` |
| GET | `/api/staking/config` |
| GET | `/api/leaderboard/current` |
| GET | `/api/analytics?window=24h\|all` |
| GET | `/api/reward-table` (auto-seeds default sealed table) |
| GET | `/api/charts/:token?period=1h` |
| GET | `/api/metadata/:token` |
| POST | `/api/launch/prepare\|confirm` |
| POST | `/api/staking/events/prepare\|confirm` |
| POST | `/api/staking/stake/prepare\|confirm` |
| POST | `/api/staking/unstake/prepare\|confirm` |
| POST | `/api/staking/claim/prepare\|confirm` |
| POST | `/api/devlock/prepare\|confirm` |
| POST | `/api/devlock/claim/prepare\|confirm` |
| POST | `/api/lucky-boxes/:boxId/open` |
| POST | `/api/lucky-boxes/:boxId/claim` |
| POST | `/api/fees/claim/prepare` → `503 FEE_ROUTER_NOT_DEPLOYED` |
| POST | `/api/swap/quote`, `/api/swap/prepare` |
| POST | `/api/admin/season`, `/reward-table`, `/launch/:token/pause-rewards`, `/token/approve` |

Admin routes require `Authorization: Bearer $ADMIN_API_TOKEN`.

Stake prepare may also return `approveTx` when ERC-20 allowance is insufficient.

## Indexer

Polls the Phantom HTTP RPC, decodes LOOTING contract events into Postgres, and
stores a checkpoint for reorg rollback. Writes `staking_activities` on
Stake / Unstake / Claim. Trade / BUY qualification indexing is gated by
`ENABLE_TRADE_INDEXING=false` until Pons ABIs are verified.

## Known limits

- DEX Screener is not integrated (Mobula covers charts + metadata).
- Uniswap prepare uses the V3 SwapRouter02 path; V4 Universal Router encoding is deferred.
- Keeper buyback route builder for `FeeSplitter.buyback` waits on the LOOTING token + adapter.
- Redis is deferred until Railway; caches are in-process TTL maps.
- Leaderboard `rewards` USD is still `$0` until reward USD totals are indexed.
- Holders are derived from indexed trade flows, not ERC-20 balance snapshots.
- Lucky Box open is DB + sealed-table hash (no `LootingLuckyBox` contract yet); claim does not move tokens.
- Creator/holder trading-fee claims wait on `LootingRewardRouter`.
- Frontend still uses mocks; wire `NEXT_PUBLIC_API_URL` when ready.
