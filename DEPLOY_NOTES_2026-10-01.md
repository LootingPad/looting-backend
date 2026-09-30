# Deploy notes — 2026-10-01 (Lucky Box / Terminal / Rewards)

Session fixes for next Railway / local deploy. Covers **looting-backend** + **main-code** (web).

## Deploy order

1. Deploy **looting-backend** (tsx watch picks up locally; prod = rebuild + restart).
2. Deploy **main-code** `apps/web` (Next).
3. Smoke: open token page → buy/sell → Rewards open/claim → check pool **Left** updates within ~3s.

No new env keys required for these changes. Existing: `LOOTING_REWARD_ROUTER`, `LOOTING_LUCKY_BOX_ETH_MODULE`, `WETH_ADDRESS`, `UNI_V3_*`, `ETH_USD` via fees.

---

## Backend (`looting-backend`)

### Holders / Open position (fills)

- **Bug:** balances from curve fills deleted the wallet when a sell landed before buys in unsorted history → ghost holders after full exit.
- **Fix:** sort fills chronologically; keep running totals; drop `<= 0` only at the end (`src/pons-adapter/live.ts`).
- Holders now include **`entryQuote`** (avg cost in quote/ETH per token) for PnL.

### Lucky Box settle (ERC-20)

- **Prefer prize token** when amount ≥ `0.0001 ETH` and Uniswap V3 quote works (tries fees 3000 / 500 / 10000 / 100).
- **Fallback ETH** if dust, no route, or swap fails after pull (`src/services/lucky-box-prize.ts`, `src/clients/uniswap.ts`).
- Open API returns **actual** paid `reward` / `kind` / `prizeSymbol` (not only table roll label) so FE does not show POSN when paid as ETH.
- Friendly 503 messages (no raw viem dumps).

### Wallet lucky boxes + pool

- `GET /api/wallet/:address/lucky-boxes` now returns:
  - `token` = launch **address**, `symbol` = ticker
  - `boxPoolEth` / `boxPoolUsd` = live `RewardRouter.luckyBoxClaimable(token)`
- Used by Rewards table column **Left** and header sum.

### Docs

- README Known limits updated for ERC-20 prefer-token + ETH fallback (no longer “503 seal forever on quote fail”).

---

## Frontend (`main-code` / `apps/web`)

### Terminal (`Terminal.tsx`)

- Open position: gate on live `balanceOf` + dust; optimistic clear after sell; don’t resurrect holder during fill lag.
- PnL entry from `entryQuote` / trades (`avgEntryFromTrades`).
- Lucky Box fee button → **`/rewards`** when wallet has boxes for that token (no inline open).

### Rewards (`Rewards.tsx`)

- Match boxes by token **address** (or symbol fallback).
- Remove “Pool spend…” copy; prize display uses compact decimals (`0.0⁴2 ETH`).
- Share card: smoother black gradient; drop “Season 01”.
- After open/claim: refresh boxes + analytics; poll both every **3s**.
- Table column **Left** = remaining pool on that token (same value for all rows of the same coin — expected).
- Header **Left** = sum of unique token pools on the user’s box list (remaining on-chain, not “unclaimed count”).

### Format (`lib/format.ts`)

- `formatCompactDecimal`: `0.0000205` → `0.0⁴2` (1 sig digit).

### Types / trenches

- `Holder.entryQuote`; `LuckyBox.symbol`, `boxPoolEth`, `boxPoolUsd`.
- `trenchHolders` maps `entryQuote` → USD entry when ETH/USD set.

---

## Product reminders (don’t “fix” leftover pool)

- Pool is **per launch token**, not one global pot.
- Each open pays a **random share** of `fairShare = pool / outstandingBoxes` — not the whole pool.
- After all of a wallet’s boxes are claimed, **Left** can still be &gt; 0; that remainder stays for the next openers / larger rolls.

---

## Quick test checklist

- [ ] Sell 100% → Open position card disappears; wallet gone from holders.
- [ ] Share / position PnL shows non-zero % when entry known.
- [ ] Rewards: Open box; ERC-20 without liquidity → ETH prize + Collect.
- [ ] Table **Left** matches token page Lucky Box pool ballpark; header **Left** = unique-token sum.
- [ ] After claim, status → Claimed; **Left** decreases within a few seconds (not necessarily to $0).
- [ ] Fee card button on token page navigates to `/rewards` when boxes exist.

## Files touched (high signal)

**BE:** `src/pons-adapter/live.ts`, `src/services/lucky-box-prize.ts`, `src/clients/uniswap.ts`, `src/modules/lucky-boxes.ts`, `src/modules/wallet.ts`, `src/lib/fe-shape.ts`, `README.md`

**FE:** `apps/web/src/components/Terminal.tsx`, `apps/web/src/components/Rewards.tsx`, `apps/web/src/lib/format.ts`, `apps/web/src/lib/trenches.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/app/globals.css`
