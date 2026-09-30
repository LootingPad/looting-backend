/** Serialize DB / indexer rows into frontend mock UI shapes (apps/web). */

export const FE_FEES = {
  DEV_LOCK_FEE_ETH: 0.003,
  CREATE_STAKING_FEE_ETH: 0.003,
  CREATOR_FEE_SHARE: 0.8,
  PROTOCOL_BURN_SHARE: 0.2,
  /** Display FX for ETH↔USD in Analytics / Shell until an oracle is wired. */
  ETH_USD: 3500,
  LOOTING_PRICE_USD: 0.0024,
  /** Flat platform fee taken on every curve buy and sell. */
  TRADE_FEE_USD: 0.056,
} as const;

/** APR display options for staking UI (Create Staking / Analytics). */
export const FE_STAKING_LOCK_OPTIONS = [
  { id: "flex" as const, label: "Flexible", rate: 8 },
  { id: "30" as const, label: "30 days", rate: 14 },
  { id: "90" as const, label: "90 days", rate: 22 },
];

const UI_DECIMALS = 18n;
const UI_SCALE = 10n ** UI_DECIMALS;

export type FeLockId = "flex" | "30" | "90";
export type FeTier = "Gold" | "Silver" | "Bronze";
export type FeBoxStatus = "unopened" | "opened" | "claimed" | "holding" | "ineligible";
export type FeLaunchPhase = "curve" | "graduated";
export type FeDevLockMode = "time" | "vest";
export type FeCadence = "day" | "week" | "month";

export type FeLaunch = {
  address: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  marketCap: number;
  progress: number;
  change1h: number;
  priceUsd: number;
  luckyShare: number;
  creatorTax: number;
  phase: FeLaunchPhase;
  draft?: boolean;
  /** http(s) / ipfs / LOOTING /api/media/:id URI when known. */
  logoUrl?: string;
};

export type FeMarketStats = {
  age: string;
  txns: number;
  volume24h: number;
  traders: number;
  change6h: number;
  change24h: number;
  ath: number;
  boxUsd: number;
};

export type FeStakingEvent = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  creator: string;
  reward: number;
  staked: number;
  stakers: number;
  marketCap: number;
  volume24h: number;
  durationDays: number;
  locks: FeLockId[];
  ends: number;
};

export type FeStakingPosition = {
  id: string;
  eventId: string;
  address: string;
  symbol: string;
  name: string;
  amount: number;
  lock: FeLockId;
  claimable: number;
  started: number;
};

export type FeDevLock = {
  id: string;
  address: string;
  symbol: string;
  name: string;
  mode: FeDevLockMode;
  amount: number;
  claimed: number;
  start: number;
  cliff: number;
  unlock: number;
  cadence: FeCadence;
};

export type FeLeaderboardRow = {
  wallet: string;
  tier: FeTier;
  xp: number;
  trades: number;
  rewards: string;
};

export type FeLuckyBox = {
  id: string;
  token: string;
  status: FeBoxStatus;
  reward?: string;
  tx?: string;
  claimedAt?: string;
};

export type FeWallet = FeLeaderboardRow & {
  seasonXp: number;
  lifetimeXp: number;
  lifetimeTradeCount: number;
  lifetimeBoxCount: number;
  luckyBoxesAvailable: number;
  rank: number | null;
  seasonId: string | null;
};

export type FeTradeSide = "Buy" | "Sell";

/** Terminal trade tape row. */
export type FeTokenTrade = {
  id: string;
  side: FeTradeSide;
  address: string;
  amount: number;
  eth: number;
  time: string;
  timestamp: string;
  usd?: number;
  txHash?: string;
};

/** Account trade history row (includes launch card fields). */
export type FeWalletTrade = {
  id: string;
  side: FeTradeSide;
  amount: number;
  eth: number;
  xp: number;
  time: string;
  timestamp: string;
  launch: FeLaunch;
  txHash?: string;
};

/** Terminal holders table row. */
export type FeHolder = {
  rank: number;
  address: string;
  amount: number;
  share: number;
  entry: number;
};

export function toFeHolder(row: FeHolder): FeHolder {
  return {
    rank: row.rank,
    address: row.address,
    amount: row.amount,
    share: Number(row.share.toFixed(4)),
    entry: row.entry,
  };
}

export type MarketEnrichment = {
  priceUsd?: number;
  marketCap?: number;
  volume24h?: number;
  change1h?: number;
  change6h?: number;
  change24h?: number;
  ath?: number;
};

type Decimalish = string | number | bigint | { toString(): string };

/** Convert raw 18-decimal token amount to a UI number. */
export function rawToUiAmount(raw: Decimalish): number {
  const asBig = typeof raw === "bigint" ? raw : BigInt(String(raw).split(".")[0] || "0");
  const whole = asBig / UI_SCALE;
  const frac = asBig % UI_SCALE;
  return Number(whole) + Number(frac) / Number(UI_SCALE);
}

/** bit0 = flex, bit1 = 30d, bit2 = 90d (contracts). */
export function lockMaskToIds(mask: number): FeLockId[] {
  const locks: FeLockId[] = [];
  if (mask & 0b001) locks.push("flex");
  if (mask & 0b010) locks.push("30");
  if (mask & 0b100) locks.push("90");
  return locks;
}

export function lockIdToFe(lockId: number): FeLockId {
  if (lockId === 1) return "30";
  if (lockId === 2) return "90";
  return "flex";
}

export function tierToFe(tier: string): FeTier {
  const t = tier.toLowerCase();
  if (t === "gold") return "Gold";
  if (t === "silver") return "Silver";
  return "Bronze";
}

export function boxStatusToFe(status: string): FeBoxStatus {
  switch (status) {
    case "claimed":
      return "claimed";
    case "in_market":
      return "holding";
    case "exited":
      return "unopened";
    case "not_eligible":
      return "ineligible";
    case "unclaimed":
    default:
      return "unopened";
  }
}

function formatAge(from: Date | null | undefined, now = Date.now()): string {
  if (!from) return "0m";
  const ms = Math.max(0, now - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Relative age string for trade timestamps (matches FE mock `2m` / `3h` / `1d`). */
export function formatRelativeTime(from: Date, now = Date.now()): string {
  const ms = Math.max(0, now - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function directionToSide(direction: string): FeTradeSide {
  const d = direction.toLowerCase();
  if (d === "sell" || d === "exit" || d === "ask") return "Sell";
  return "Buy";
}

function quoteToEth(quoteRaw: Decimalish, usdNotional: number | null | undefined): number {
  const quoteUi = rawToUiAmount(quoteRaw);
  if (quoteUi > 0) return quoteUi;
  if (usdNotional != null && usdNotional > 0) return usdNotional / FE_FEES.ETH_USD;
  return 0;
}

export function toFeTokenTrade(trade: {
  id: string;
  trader: string;
  direction: string;
  tokenAmount: Decimalish;
  quoteAmount: Decimalish;
  usdNotional: Decimalish | null;
  timestamp: Date;
  txHash: string;
}): FeTokenTrade {
  const usd =
    trade.usdNotional == null ? undefined : Number(String(trade.usdNotional));
  return {
    id: trade.id,
    side: directionToSide(trade.direction),
    address: trade.trader,
    amount: rawToUiAmount(trade.tokenAmount),
    eth: quoteToEth(trade.quoteAmount, usd),
    time: formatRelativeTime(trade.timestamp),
    timestamp: trade.timestamp.toISOString(),
    usd,
    txHash: trade.txHash,
  };
}

export function toFeWalletTrade(
  trade: {
    id: string;
    direction: string;
    tokenAmount: Decimalish;
    quoteAmount: Decimalish;
    usdNotional: Decimalish | null;
    timestamp: Date;
    txHash: string;
    isQualified: boolean;
  },
  launch: FeLaunch,
  xp: number,
): FeWalletTrade {
  const usd =
    trade.usdNotional == null ? undefined : Number(String(trade.usdNotional));
  return {
    id: trade.id,
    side: directionToSide(trade.direction),
    amount: rawToUiAmount(trade.tokenAmount),
    eth: quoteToEth(trade.quoteAmount, usd),
    xp: trade.isQualified ? xp : 0,
    time: formatRelativeTime(trade.timestamp),
    timestamp: trade.timestamp.toISOString(),
    launch,
    txHash: trade.txHash,
  };
}

function formatRewardsUsd(usd: number): string {
  const n = Math.max(0, Math.round(usd));
  return `$${n}`;
}

export function toFeLaunch(
  launch: {
    token: string;
    creator: string;
    phase: string;
    luckyBoxBps: number;
    totalCreatorFeeBps: number;
    name: string | null;
    symbol: string | null;
    description: string | null;
    imageUrl?: string | null;
  },
  market?: MarketEnrichment | null,
  draft?: boolean,
): FeLaunch {
  const creatorTax = launch.totalCreatorFeeBps / 100;
  const luckyShare =
    launch.totalCreatorFeeBps > 0
      ? (launch.luckyBoxBps / launch.totalCreatorFeeBps) * 100
      : 0;
  const phase: FeLaunchPhase = launch.phase === "graduated" ? "graduated" : "curve";
  const logoUrl = (launch.imageUrl ?? "").trim() || undefined;
  const out: FeLaunch = {
    address: launch.token,
    name: launch.name ?? "",
    symbol: launch.symbol ?? "",
    description: launch.description ?? "",
    creator: launch.creator,
    marketCap: market?.marketCap ?? 0,
    progress: phase === "graduated" ? 100 : 0,
    change1h: market?.change1h ?? 0,
    priceUsd: market?.priceUsd ?? 0,
    luckyShare,
    creatorTax,
    phase,
  };
  if (logoUrl) out.logoUrl = logoUrl;
  if (draft !== undefined) out.draft = draft;
  return out;
}

export function toFeMarketStats(
  launch: FeLaunch,
  opts?: {
    launchedAt?: Date | null;
    txns?: number;
    traders?: number;
    volume24h?: number;
    change6h?: number;
    change24h?: number;
    ath?: number;
  },
): FeMarketStats {
  const volume24h = opts?.volume24h ?? 0;
  const ath = opts?.ath ?? Math.max(launch.marketCap, 0);
  const boxUsd =
    launch.marketCap *
    (launch.creatorTax / 100) *
    (0.35 + launch.progress / 200) *
    (launch.luckyShare / 100);
  return {
    age: formatAge(opts?.launchedAt ?? null),
    txns: opts?.txns ?? 0,
    volume24h,
    traders: opts?.traders ?? 0,
    change6h: opts?.change6h ?? 0,
    change24h: opts?.change24h ?? launch.change1h * 2.4,
    ath,
    boxUsd,
  };
}

export function toFeStakingEvent(
  vault: {
    vaultId: bigint | { toString(): string };
    stakeToken: string;
    creator: string;
    rewardFunded: Decimalish;
    totalStaked: Decimalish;
    stakerCount: number;
    endsAt: Date;
    lockMask: number;
    createdAt: Date;
  },
  meta?: {
    name?: string | null;
    symbol?: string | null;
    marketCap?: number;
    volume24h?: number;
  },
): FeStakingEvent {
  const durationMs = Math.max(0, vault.endsAt.getTime() - vault.createdAt.getTime());
  return {
    id: vault.vaultId.toString(),
    address: vault.stakeToken,
    symbol: meta?.symbol ?? "",
    name: meta?.name ?? "",
    creator: vault.creator,
    reward: rawToUiAmount(vault.rewardFunded),
    staked: rawToUiAmount(vault.totalStaked),
    stakers: vault.stakerCount,
    marketCap: meta?.marketCap ?? 0,
    volume24h: meta?.volume24h ?? 0,
    durationDays: Math.max(1, Math.round(durationMs / 86_400_000)),
    locks: lockMaskToIds(vault.lockMask),
    ends: vault.endsAt.getTime(),
  };
}

export function toFeStakingPosition(
  position: {
    id: string;
    lockId: number;
    amount: Decimalish;
    lockStartedAt: Date | null;
  },
  vault: {
    vaultId: bigint | { toString(): string };
    stakeToken: string;
  },
  meta?: { name?: string | null; symbol?: string | null; claimable?: number },
): FeStakingPosition {
  return {
    id: position.id,
    eventId: vault.vaultId.toString(),
    address: vault.stakeToken,
    symbol: meta?.symbol ?? "",
    name: meta?.name ?? "",
    amount: rawToUiAmount(position.amount),
    lock: lockIdToFe(position.lockId),
    claimable: meta?.claimable ?? 0,
    started: position.lockStartedAt?.getTime() ?? 0,
  };
}

export function toFeDevLock(
  lock: {
    lockId: bigint | { toString(): string };
    token: string;
    mode: string;
    amount: Decimalish;
    claimed: Decimalish;
    startAt: Date;
    cliffAt: Date;
    unlockAt: Date;
    cadence: string;
  },
  meta?: { name?: string | null; symbol?: string | null },
): FeDevLock {
  const mode: FeDevLockMode = lock.mode === "vest" ? "vest" : "time";
  const cadence: FeCadence =
    lock.cadence === "week" ? "week" : lock.cadence === "month" ? "month" : "day";
  return {
    id: lock.lockId.toString(),
    address: lock.token,
    symbol: meta?.symbol ?? "",
    name: meta?.name ?? "",
    mode,
    amount: rawToUiAmount(lock.amount),
    claimed: rawToUiAmount(lock.claimed),
    start: lock.startAt.getTime(),
    cliff: lock.cliffAt.getTime(),
    unlock: lock.unlockAt.getTime(),
    cadence,
  };
}

export function toFeLeaderboardRow(row: {
  wallet: string;
  tier: string;
  xp: Decimalish;
  tradeCount: number;
  rewardsUsd?: number;
}): FeLeaderboardRow {
  const xp =
    typeof row.xp === "number"
      ? row.xp
      : typeof row.xp === "bigint"
        ? Number(row.xp)
        : Number(String(row.xp));
  return {
    wallet: row.wallet,
    tier: tierToFe(row.tier),
    xp,
    trades: row.tradeCount,
    rewards: formatRewardsUsd(row.rewardsUsd ?? 0),
  };
}

export function toFeLuckyBox(
  box: {
    boxId: string;
    status: string;
    claimedAt: Date | null;
    rewards?: Array<{
      amount: Decimalish | null;
      token: string | null;
      swapTxHash: string | null;
      status: string;
      rewardType?: string;
    }>;
  },
  tokenSymbol: string,
): FeLuckyBox {
  const claimedReward = box.rewards?.find((r) => r.status === "claimed" || r.swapTxHash);
  const out: FeLuckyBox = {
    id: box.boxId,
    token: tokenSymbol,
    status: boxStatusToFe(box.status),
  };
  if (claimedReward?.amount != null) {
    const amt = rawToUiAmount(claimedReward.amount);
    const sym = claimedReward.token ? claimedReward.token.slice(0, 6) : tokenSymbol;
    out.reward = `${amt} ${sym}`;
  } else if (
    claimedReward?.rewardType &&
    claimedReward.rewardType !== "none" &&
    claimedReward.rewardType !== "table" &&
    claimedReward.rewardType !== "pending"
  ) {
    out.reward = claimedReward.rewardType;
  }
  if (claimedReward?.swapTxHash) out.tx = claimedReward.swapTxHash;
  if (box.claimedAt) out.claimedAt = box.claimedAt.toISOString();
  return out;
}

export function toFeWallet(input: {
  wallet: string;
  tier: string;
  seasonXp: Decimalish;
  tradeCount: number;
  lifetimeXp: Decimalish;
  lifetimeTradeCount: number;
  lifetimeBoxCount: number;
  luckyBoxesAvailable: number;
  rank: number | null;
  seasonId: string | null;
  rewardsUsd?: number;
}): FeWallet {
  const row = toFeLeaderboardRow({
    wallet: input.wallet,
    tier: input.tier,
    xp: input.seasonXp,
    tradeCount: input.tradeCount,
    rewardsUsd: input.rewardsUsd,
  });
  const seasonXp =
    typeof input.seasonXp === "number"
      ? input.seasonXp
      : typeof input.seasonXp === "bigint"
        ? Number(input.seasonXp)
        : Number(String(input.seasonXp));
  const lifetimeXp =
    typeof input.lifetimeXp === "number"
      ? input.lifetimeXp
      : typeof input.lifetimeXp === "bigint"
        ? Number(input.lifetimeXp)
        : Number(String(input.lifetimeXp));
  return {
    ...row,
    seasonXp,
    lifetimeXp,
    lifetimeTradeCount: input.lifetimeTradeCount,
    lifetimeBoxCount: input.lifetimeBoxCount,
    luckyBoxesAvailable: input.luckyBoxesAvailable,
    rank: input.rank,
    seasonId: input.seasonId,
  };
}
