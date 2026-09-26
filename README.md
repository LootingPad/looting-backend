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

## API surface (Spec §22)

| Method | Path |
|---|---|
| GET | `/health` |
| GET | `/api/fees` |
| GET | `/api/launches`, `/api/launches/:token` |
| GET | `/api/creator/:address/launches` |
| GET | `/api/launch/:token/rewards` |
| GET | `/api/seasons/current` |
| GET | `/api/wallet/:address` (+ `/rewards`, `/lucky-boxes`, `/staking-positions`, `/dev-locks`) |
| GET | `/api/staking/events`, `/api/staking/events/:vaultId` |
| GET | `/api/leaderboard/current` |
| GET | `/api/charts/:token?period=1h` |
| GET | `/api/metadata/:token` |
| POST | `/api/launch/prepare\|confirm` |
| POST | `/api/staking/events/prepare\|confirm` |
| POST | `/api/devlock/prepare\|confirm` |
| POST | `/api/swap/quote`, `/api/swap/prepare` |
| POST | `/api/admin/season`, `/reward-table`, `/launch/:token/pause-rewards`, `/token/approve` |

Admin routes require `Authorization: Bearer $ADMIN_API_TOKEN`.

## Indexer

Polls the Phantom HTTP RPC, decodes LOOTING contract events into Postgres, and
stores a checkpoint for reorg rollback. Trade / BUY qualification indexing is
gated by `ENABLE_TRADE_INDEXING=false` until Pons ABIs are verified.

## Response shape

List/detail JSON for launches, staking, wallet, leaderboard, and lucky boxes matches the
frontend mock UI types in `apps/web` (`Launch`, `StakingEvent`, `StakingPosition`, `DevLock`,
leaderboard rows, `LuckyBox`). Amounts are UI numbers (`raw / 1e18`). Launch detail includes a
`stats` object (`age`, `txns`, `volume24h`, `traders`, `change6h`, `change24h`, `ath`, `boxUsd`).
`GET /api/fees` returns the FE fee constants (`DEV_LOCK_FEE_ETH`, `CREATE_STAKING_FEE_ETH`, …).

## Known limits

- DEX Screener is not integrated (Mobula covers charts + metadata).
- Uniswap prepare uses the V3 SwapRouter02 path; V4 Universal Router encoding is deferred.
- Keeper buyback route builder for `FeeSplitter.buyback` waits on the LOOTING token + adapter.
- Redis is deferred until Railway; caches are in-process TTL maps.
- Staking `claimable` and leaderboard `rewards` USD are placeholders (`0` / `$0`) until on-chain
  accrual and USD reward totals are indexed.
- Frontend is still mock-only; wire `NEXT_PUBLIC_API_URL` when ready.
