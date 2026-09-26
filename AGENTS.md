# AGENTS.md

`../looting/LOOTING_PRODUCT_SPEC.md` is the canonical product source. If code and
spec disagree, fix the spec first (or document the deviation under README Known
limits).

## Rules

- Never assume frontend state is authoritative for XP or eligibility.
- Never classify a BUY from wallet balance alone.
- Backend must never hold user funds. Swaps are prepare → wallet signs → broadcast.
- Never store secrets in git. `.env` is gitignored; `.env.example` holds no keys.
- Isolate any future Pons ABI usage in a `pons-adapter` module.
- XP, seasons, tiers, leaderboards, anti-sybil, and list endpoints belong here —
  not in contracts.
- Indexer awards XP / boxes only after confirmation/finality thresholds.
- Prefer idempotency keys on prepare/confirm and reward jobs.

## Local checks before PR

```bash
npm run typecheck
npx prisma validate
```
