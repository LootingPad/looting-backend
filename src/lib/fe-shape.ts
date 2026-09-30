/** Serialize DB / indexer rows into frontend mock UI shapes (apps/web). */

export const FE_FEES = {
  DEV_LOCK_FEE_ETH: 0.003,
  CREATE_STAKING_FEE_ETH: 0.003,
  CREATOR_FEE_SHARE: 0.8,
  PROTOCOL_BURN_SHARE: 0.2,
  /**
   * Placeholder only — `/api/fees` and analytics overwrite with live spot from
   * `getEthUsd()`. Never treat this constant as a market price.
   */
  ETH_USD: 0,
  /** $LOOTING CA not live — stay 0 rather than inventing a quote. */
  LOOTING_PRICE_USD: 0,
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

export type ExploreStage = "new" | "almost" | "migrate" | "all";

/** Explore / launch-list card shaped for the web app. */
export type FeLaunchCard = FeLaunch & {
  stats: FeMarketStats;
  sparkline?: number[];
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
  /** Boxes opened (leaderboard) or trade count (legacy wallet profile). */
  trades: number;
  rewards: string;
  boxesOpened?: number;
  rewardsWon?: number;
  ethWon?: string;
};

export type FeLuckyBox = {
  id: string;
  /** Launch token contract address (lowercase). */
  token: string;
  /** Ticker for display ($A7968). */
  symbol?: string;
  status: FeBoxStatus;
  /** Sealed-table outcome label (e.g. "25 LOOTING"). */
  reward?: string;
  /** ETH budget spent from the launch box pool (wei string). */
  creditedWei?: string;
  /** Human ETH amount for the rolled budget, when > 0. */
  payoutEth?: string;
  /** USD value of the ETH budget (spot). */
  payoutUsd?: number;
  /** Live RewardRouter lucky-box pool for this launch (ETH). */
  boxPoolEth?: number;
  /** Live RewardRouter lucky-box pool for this launch (USD). */
  boxPoolUsd?: number;
  /** ERC-20 amount received after swap (human units), when known. */
  prizeAmount?: number;
  /** Display symbol for the prize asset (NVDA, ETH, …). */
  prizeSymbol?: string;
  prizeKind?: "miss" | "eth" | "erc20";
  prizeToken?: string | null;
  /** True when winner still needs to claimEthPrize. */
  claimableOnChain?: boolean;
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

function quoteToEth(
  quoteRaw: Decimalish,
  usdNotional: number | null | undefined,
  ethUsd: number,
): number {
  const quoteUi = rawToUiAmount(quoteRaw);
  if (quoteUi > 0) return quoteUi;
  if (usdNotional != null && usdNotional > 0 && ethUsd > 0) return usdNotional / ethUsd;
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
}, ethUsd = 0): FeTokenTrade {
  const usd =
    trade.usdNotional == null ? undefined : Number(String(trade.usdNotional));
  return {
    id: trade.id,
    side: directionToSide(trade.direction),
    address: trade.trader,
    amount: rawToUiAmount(trade.tokenAmount),
    eth: quoteToEth(trade.quoteAmount, usd, ethUsd),
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
  ethUsd = 0,
): FeWalletTrade {
  const usd =
    trade.usdNotional == null ? undefined : Number(String(trade.usdNotional));
  return {
    id: trade.id,
    side: directionToSide(trade.direction),
    amount: rawToUiAmount(trade.tokenAmount),
    eth: quoteToEth(trade.quoteAmount, usd, ethUsd),
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
  return {
    age: formatAge(opts?.launchedAt ?? null),
    txns: opts?.txns ?? 0,
    volume24h,
    traders: opts?.traders ?? 0,
    change6h: opts?.change6h ?? 0,
    change24h: opts?.change24h ?? 0,
    ath,
    boxUsd: luckyBoxUsdFromLaunch(launch, volume24h),
  };
}

/** Prefer volume×tax (real accrual). No mcap invent — return 0 until volume is indexed. */
export function feePoolsFromVolumeUsd(
  volumeUsd: number,
  creatorTaxPercent: number,
  luckySharePercent: number,
  creatorFeeShare = FE_FEES.CREATOR_FEE_SHARE,
) {
  const tax = Math.max(0, creatorTaxPercent) / 100;
  const accruedUsd = Math.max(0, volumeUsd) * tax;
  const share = Math.min(1, Math.max(0, creatorFeeShare));
  const creatorSideUsd = accruedUsd * share;
  const lucky = Math.min(100, Math.max(0, luckySharePercent)) / 100;
  return {
    accruedUsd,
    burnUsd: accruedUsd * (1 - share),
    creatorUsd: creatorSideUsd * (1 - lucky),
    poolUsd: creatorSideUsd * lucky,
  };
}

export function luckyBoxUsdFromLaunch(launch: FeLaunch, volumeUsd = 0): number {
  if (!(volumeUsd > 0) || !(launch.creatorTax > 0)) return 0;
  return feePoolsFromVolumeUsd(volumeUsd, launch.creatorTax, launch.luckyShare).poolUsd;
}

export function accruedFeeUsdFromLaunch(launch: FeLaunch, volumeUsd = 0): number {
  if (!(volumeUsd > 0) || !(launch.creatorTax > 0)) return 0;
  return feePoolsFromVolumeUsd(volumeUsd, launch.creatorTax, launch.luckyShare).accruedUsd;
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
  boxesOpened?: number;
  rewardsWon?: number;
  ethWon?: string;
  rewardsLabel?: string;
}): FeLeaderboardRow {
  const xp =
    typeof row.xp === "number"
      ? row.xp
      : typeof row.xp === "bigint"
        ? Number(row.xp)
        : Number(String(row.xp));
  const boxesOpened = row.boxesOpened ?? row.tradeCount;
  const rewardsWon = row.rewardsWon ?? 0;
  return {
    wallet: row.wallet,
    tier: tierToFe(row.tier),
    xp,
    trades: boxesOpened,
    rewards: row.rewardsLabel ?? formatRewardsUsd(row.rewardsUsd ?? 0),
    boxesOpened,
    rewardsWon,
    ethWon: row.ethWon,
  };
}

function formatPayoutEth(amount: Decimalish | null | undefined): string | undefined {
  if (amount == null) return undefined;
  const eth = rawToUiAmount(amount);
  if (!Number.isFinite(eth) || eth <= 0) return undefined;
  if (eth < 0.000001) return `${eth.toExponential(2)} ETH`;
  const fixed = eth >= 0.01 ? eth.toFixed(4) : eth.toFixed(6);
  return `${fixed.replace(/\.?0+$/, "")} ETH`;
}

function formatTokenRaw(raw: Decimalish, decimals: number): number {
  const s = String(raw);
  try {
    const v = BigInt(s.split(".")[0] || "0");
    const scale = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
    return Number(v) / Number(scale);
  } catch {
    return 0;
  }
}

function inferPrizeKind(token: string | null | undefined, rewardType?: string): FeLuckyBox["prizeKind"] {
  if (!token && rewardType && /no reward|miss|empty|—/i.test(rewardType)) return "miss";
  if (!token) return "miss";
  if (token === "ETH" || token.toUpperCase() === "ETH") return "eth";
  if (token.startsWith("0x")) return "erc20";
  return "eth";
}

export function toFeLuckyBox(
  box: {
    boxId: string;
    status: string;
    openedAt?: Date | null;
    claimedAt: Date | null;
    rewards?: Array<{
      amount: Decimalish | null;
      token: string | null;
      swapTxHash: string | null;
      swapOutput?: Decimalish | null;
      status: string;
      rewardType?: string;
    }>;
  },
  launch: { token?: string | null; symbol?: string | null } | string,
  opts?: {
    ethUsd?: number;
    prizeLabel?: string | null;
    prizeDecimals?: number;
    boxPoolEth?: number;
    boxPoolUsd?: number;
  },
): FeLuckyBox {
  const rewards = box.rewards ?? [];
  const pending = rewards.find((r) => r.status === "pending" || r.status === "swapping");
  const settled = rewards.find((r) => r.status === "claimed" || r.status === "failed");
  const row = pending ?? settled ?? rewards[rewards.length - 1];

  let status = boxStatusToFe(box.status);
  if (pending) status = "opened";
  else if (box.openedAt || box.status === "claimed") status = "claimed";

  const tokenAddress =
    typeof launch === "string" ? "" : (launch.token ?? "").toLowerCase();
  const symbol =
    typeof launch === "string" ? launch : (launch.symbol ?? "").trim() || tokenAddress.slice(0, 6);

  const out: FeLuckyBox = {
    id: box.boxId,
    // Prefer address so Terminal can match launch.address; fall back to symbol for older callers.
    token: tokenAddress || symbol,
    symbol: symbol || undefined,
    status,
  };

  if (row?.rewardType && row.rewardType !== "none" && row.rewardType !== "table") {
    out.reward = row.rewardType;
  }

  const ethUsd = opts?.ethUsd && opts.ethUsd > 0 ? opts.ethUsd : 0;
  if (row?.amount != null) {
    const wei = String(row.amount);
    if (wei !== "0") {
      out.creditedWei = wei;
      out.payoutEth = formatPayoutEth(row.amount);
      const eth = rawToUiAmount(row.amount);
      if (ethUsd > 0 && eth > 0) out.payoutUsd = eth * ethUsd;
    }
  }

  out.prizeKind = inferPrizeKind(row?.token, row?.rewardType);
  out.prizeToken = row?.token ?? null;

  if (out.prizeKind === "eth") {
    out.prizeSymbol = "ETH";
    if (row?.amount != null) out.prizeAmount = rawToUiAmount(row.amount);
  } else if (out.prizeKind === "erc20") {
    out.prizeSymbol = opts?.prizeLabel?.trim() || out.reward || "TOKEN";
    if (row?.swapOutput != null) {
      out.prizeAmount = formatTokenRaw(row.swapOutput, opts?.prizeDecimals ?? 18);
    }
  }

  out.claimableOnChain = Boolean(pending && (row?.token === "ETH" || out.prizeKind === "eth"));

  if (row?.swapTxHash) out.tx = row.swapTxHash;
  if (box.claimedAt) out.claimedAt = box.claimedAt.toISOString();
  if (opts?.boxPoolEth != null && Number.isFinite(opts.boxPoolEth)) out.boxPoolEth = opts.boxPoolEth;
  if (opts?.boxPoolUsd != null && Number.isFinite(opts.boxPoolUsd)) out.boxPoolUsd = opts.boxPoolUsd;
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
