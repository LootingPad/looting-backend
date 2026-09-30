import { createHash } from "node:crypto";
import type { Hex, Log, TransactionReceipt } from "viem";
import { decodeEventLog, formatEther } from "viem";
import { getEthUsd } from "../clients/eth-price.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ensureWallet, normalizeAddress, tierFromXp, xpBuySizeBonus, xpForQualifiedTrade } from "../lib/utils.js";
import { curveBuyEvent, curveSellEvent } from "../pons-adapter/abi.js";
import { allocateTaxToLaunch } from "./reward-router.js";
import { awardXp, ensureActiveSeason } from "./xp.js";

/** Treat residual dust after a "sell all" as a full exit (UI rounds human amounts). */
const EXIT_DUST_WEI = 10n ** 15n;

export type IngestedTrade = {
  tradeId: string;
  direction: "buy" | "sell";
  qualified: boolean;
  boxId?: string;
  boxStatus?: string;
  unlocked?: number;
};

function boxIdFor(tradeId: string, wallet: string, token: string): string {
  return createHash("sha256")
    .update(`box:${env.CHAIN_ID}:${token}:${wallet}:${tradeId}`)
    .digest("hex")
    .slice(0, 32);
}

function usdFromQuote(quoteWei: bigint, ethUsd: number): number {
  const eth = Number(formatEther(quoteWei));
  if (!Number.isFinite(eth) || eth <= 0 || !(ethUsd > 0)) return 0;
  return eth * ethUsd;
}

async function walletTokenBalanceRaw(launchId: string, wallet: string): Promise<bigint> {
  const rows = await prisma.trade.findMany({
    where: {
      launchId,
      trader: wallet,
      confirmationState: { in: ["PENDING", "CONFIRMED", "FINALIZED"] },
    },
    select: { direction: true, tokenAmount: true },
  });
  let bal = 0n;
  for (const row of rows) {
    const amt = BigInt(row.tokenAmount.toFixed(0));
    if (row.direction === "buy") bal += amt;
    else bal -= amt;
  }
  return bal < 0n ? 0n : bal;
}

/**
 * Full exit for box unlock = curve buys covered by curve sells (indexed).
 * Transfer-out alone leaves indexed balance > 0 → NOT unlocked (buy+sell only).
 */
async function isFullyExited(opts: {
  launchId: string;
  token: string;
  wallet: string;
}): Promise<boolean> {
  void opts.token;
  const indexed = await walletTokenBalanceRaw(opts.launchId, opts.wallet);
  return indexed <= EXIT_DUST_WEI;
}

async function holdBonusXp(opts: {
  launchId: string;
  walletId: string;
  exitAt: Date;
}): Promise<number> {
  const firstBuy = await prisma.trade.findFirst({
    where: {
      launchId: opts.launchId,
      walletId: opts.walletId,
      direction: "buy",
      isQualified: true,
      confirmationState: { in: ["PENDING", "CONFIRMED", "FINALIZED"] },
    },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true },
  });
  if (!firstBuy) return 0;
  const heldMs = opts.exitAt.getTime() - firstBuy.timestamp.getTime();
  return heldMs >= 60 * 60 * 1000 ? 5 : 0;
}

async function isFirstBuyOfToken(launchId: string, walletId: string): Promise<boolean> {
  const prior = await prisma.trade.count({
    where: {
      launchId,
      walletId,
      direction: "buy",
      isQualified: true,
      confirmationState: { in: ["PENDING", "CONFIRMED", "FINALIZED"] },
    },
  });
  // Called after current trade insert → count 1 means this is the first.
  return prior <= 1;
}

/** Unlock in_market boxes when the wallet no longer holds the token (incl. dust exits). */
export async function unlockExitedBoxes(opts: {
  launchId: string;
  token: string;
  walletId: string;
  wallet: string;
}): Promise<number> {
  if (!(await isFullyExited({ launchId: opts.launchId, token: opts.token, wallet: opts.wallet }))) {
    return 0;
  }
  const result = await prisma.luckyBox.updateMany({
    where: {
      walletId: opts.walletId,
      launchId: opts.launchId,
      status: "in_market",
    },
    data: { status: "exited" },
  });
  return result.count;
}

/** Reconcile holding boxes for a wallet (Rewards page / confirm catch-up). */
export async function reconcileWalletBoxExits(walletId: string, wallet: string): Promise<number> {
  const holding = await prisma.luckyBox.findMany({
    where: { walletId, status: "in_market" },
    include: { launch: { select: { id: true, token: true } } },
  });
  let unlocked = 0;
  const seen = new Set<string>();
  for (const box of holding) {
    const launchId = box.launchId;
    if (!box.launch || !launchId || seen.has(launchId)) continue;
    seen.add(launchId);
    unlocked += await unlockExitedBoxes({
      launchId,
      token: box.launch.token,
      walletId,
      wallet,
    });
  }
  return unlocked;
}

/**
 * Persist one curve fill for a LOOTING launch and apply XP / Lucky Box rules (spec §8):
 * - qualifying BUY → one Lucky Box (in_market)
 * - full exit → unlock in_market boxes to exited (openable)
 */
export async function ingestCurveFill(input: {
  token: string;
  curve: string;
  trader: string;
  direction: "buy" | "sell";
  tokenAmount: bigint;
  quoteAmount: bigint;
  taxAmount?: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  timestamp: Date;
}): Promise<IngestedTrade | null> {
  const token = normalizeAddress(input.token);
  const trader = normalizeAddress(input.trader);
  const curve = normalizeAddress(input.curve);
  const txHash = input.txHash.toLowerCase();

  const launch = await prisma.launch.findUnique({
    where: { chainId_token: { chainId: env.CHAIN_ID, token } },
  });
  if (!launch || !launch.rewardsEnabled) return null;

  const existing = await prisma.trade.findUnique({
    where: { txHash_logIndex: { txHash, logIndex: input.logIndex } },
  });
  if (existing) {
    return {
      tradeId: existing.id,
      direction: existing.direction === "sell" ? "sell" : "buy",
      qualified: existing.isQualified,
    };
  }

  const user = await ensureWallet(env.CHAIN_ID, trader);
  const ethUsd = await getEthUsd();
  const usd = usdFromQuote(input.quoteAmount, ethUsd);
  let xp = input.direction === "buy" ? xpForQualifiedTrade(usd) : 0;
  if (input.direction === "buy" && xp > 0) {
    xp += xpBuySizeBonus(usd);
  }
  const qualified = input.direction === "buy" && xp > 0;

  const trade = await prisma.trade.create({
    data: {
      chainId: env.CHAIN_ID,
      launchId: launch.id,
      token,
      poolOrCurve: curve,
      trader,
      walletId: user.id,
      txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash.toLowerCase(),
      timestamp: input.timestamp,
      tokenAmount: input.tokenAmount.toString(),
      quoteAmount: input.quoteAmount.toString(),
      direction: input.direction,
      usdNotional: usd,
      sourceContract: curve,
      isQualified: qualified,
      qualificationReason: qualified
        ? "MIN_NOTIONAL"
        : input.direction === "buy"
          ? "BELOW_MIN_NOTIONAL"
          : "SELL",
      confirmationState: "CONFIRMED",
    },
  });

  let boxId: string | undefined;
  let boxStatus: string | undefined;
  let unlocked = 0;

  if (qualified) {
    await ensureActiveSeason();
    let award = xp;
    if (await isFirstBuyOfToken(launch.id, user.id)) {
      award += 3;
    }
    await awardXp({
      chainId: env.CHAIN_ID,
      wallet: trader,
      xp: award,
      tradeIncrement: 1,
    });

    const season = await ensureActiveSeason();
    const stats = await prisma.seasonWalletStat.findUnique({
      where: { seasonId_walletId: { seasonId: season.id, walletId: user.id } },
    });
    const tier = tierFromXp(stats?.xp ?? 0n, {
      bronze: season.bronzeThreshold,
      silver: season.silverThreshold,
      gold: season.goldThreshold,
    });
    const id = boxIdFor(trade.id, trader, token);
    const box = await prisma.luckyBox.upsert({
      where: { boxId: id },
      create: {
        boxId: id,
        walletId: user.id,
        launchId: launch.id,
        seasonId: season.id,
        status: "in_market",
        earnedFromTradeId: trade.id,
        tier,
      },
      update: {},
    });
    boxId = box.boxId;
    boxStatus = box.status;
    await prisma.userWallet.update({
      where: { id: user.id },
      data: { lifetimeBoxCount: { increment: 1 } },
    });
  }

  if (input.direction === "sell") {
    unlocked = await unlockExitedBoxes({
      launchId: launch.id,
      token,
      walletId: user.id,
      wallet: trader,
    });
    if (unlocked > 0) {
      const holdXp = await holdBonusXp({
        launchId: launch.id,
        walletId: user.id,
        exitAt: input.timestamp,
      });
      if (holdXp > 0) {
        await awardXp({ chainId: env.CHAIN_ID, wallet: trader, xp: holdXp });
      }
      // Clean full exit bump
      await awardXp({ chainId: env.CHAIN_ID, wallet: trader, xp: 1 });
    }
  }

  // Best-effort: sweep curve fees → harvest escrow → allocate to this launch.
  if (input.taxAmount && input.taxAmount > 0n) {
    void allocateTaxToLaunch({
      token,
      curve,
      amountWei: input.taxAmount,
    });
  }

  return {
    tradeId: trade.id,
    direction: input.direction,
    qualified,
    boxId,
    boxStatus,
    unlocked,
  };
}

/** Parse CurveBuy / CurveSell from a user trade receipt and ingest LOOTING rewards. */
export async function ingestTradesFromReceipt(opts: {
  token: string;
  wallet: string;
  txHash: Hex;
  receipt: TransactionReceipt;
  timestamp?: Date;
}): Promise<IngestedTrade[]> {
  const token = normalizeAddress(opts.token);
  const wallet = normalizeAddress(opts.wallet);
  const launch = await prisma.launch.findUnique({
    where: { chainId_token: { chainId: env.CHAIN_ID, token } },
  });
  if (!launch?.curve) return [];

  const curve = normalizeAddress(launch.curve);
  const out: IngestedTrade[] = [];
  const ts = opts.timestamp ?? new Date();

  for (const log of opts.receipt.logs) {
    if (log.address.toLowerCase() !== curve) continue;
    if (log.logIndex == null || opts.receipt.blockNumber == null) continue;

    try {
      const buy = decodeEventLog({
        abi: [curveBuyEvent],
        data: log.data,
        topics: log.topics,
      });
      if (buy.eventName === "CurveBuy") {
        const recipient = (buy.args.recipient ?? buy.args.buyer)?.toLowerCase();
        if (!recipient || recipient !== wallet) continue;
        const ingested = await ingestCurveFill({
          token,
          curve,
          trader: wallet,
          direction: "buy",
          tokenAmount: buy.args.tokensOut as bigint,
          quoteAmount: buy.args.quoteIn as bigint,
          taxAmount: buy.args.tax as bigint,
          txHash: opts.txHash,
          logIndex: Number(log.logIndex),
          blockNumber: opts.receipt.blockNumber,
          blockHash: opts.receipt.blockHash ?? "0x",
          timestamp: ts,
        });
        if (ingested) out.push(ingested);
        continue;
      }
    } catch {
      /* not a buy */
    }

    try {
      const sell = decodeEventLog({
        abi: [curveSellEvent],
        data: log.data,
        topics: log.topics,
      });
      if (sell.eventName === "CurveSell") {
        const seller = sell.args.seller?.toLowerCase();
        const trader =
          seller === "0xca11bde05977b3631167028862be2a173976ca11"
            ? sell.args.recipient?.toLowerCase()
            : seller;
        if (!trader || trader !== wallet) continue;
        const ingested = await ingestCurveFill({
          token,
          curve,
          trader: wallet,
          direction: "sell",
          tokenAmount: sell.args.tokensIn as bigint,
          quoteAmount: sell.args.quoteOut as bigint,
          taxAmount: sell.args.tax as bigint,
          txHash: opts.txHash,
          logIndex: Number(log.logIndex),
          blockNumber: opts.receipt.blockNumber,
          blockHash: opts.receipt.blockHash ?? "0x",
          timestamp: ts,
        });
        if (ingested) out.push(ingested);
      }
    } catch {
      /* not a sell */
    }
  }

  return out;
}

/** Indexer: decode a raw log if it belongs to a watched launch curve. */
export async function ingestCurveLog(
  log: Log,
  timestamp: Date,
  curveToToken: Map<string, string>,
): Promise<IngestedTrade | null> {
  const curve = log.address.toLowerCase();
  const token = curveToToken.get(curve);
  if (!token || log.logIndex == null || log.blockNumber == null || !log.transactionHash) return null;

  try {
    const buy = decodeEventLog({
      abi: [curveBuyEvent],
      data: log.data,
      topics: log.topics,
    });
    if (buy.eventName === "CurveBuy") {
      const trader = (buy.args.recipient ?? buy.args.buyer)?.toLowerCase();
      if (!trader) return null;
      return ingestCurveFill({
        token,
        curve,
        trader,
        direction: "buy",
        tokenAmount: buy.args.tokensOut as bigint,
        quoteAmount: buy.args.quoteIn as bigint,
        taxAmount: buy.args.tax as bigint,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash ?? "0x",
        timestamp,
      });
    }
  } catch {
    /* try sell */
  }

  try {
    const sell = decodeEventLog({
      abi: [curveSellEvent],
      data: log.data,
      topics: log.topics,
    });
    if (sell.eventName === "CurveSell") {
      const seller = sell.args.seller?.toLowerCase();
      const trader =
        seller === "0xca11bde05977b3631167028862be2a173976ca11"
          ? sell.args.recipient?.toLowerCase()
          : seller;
      if (!trader) return null;
      return ingestCurveFill({
        token,
        curve,
        trader,
        direction: "sell",
        tokenAmount: sell.args.tokensIn as bigint,
        quoteAmount: sell.args.quoteOut as bigint,
        taxAmount: sell.args.tax as bigint,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash ?? "0x",
        timestamp,
      });
    }
  } catch {
    return null;
  }

  return null;
}

export async function loadCurveTokenMap(): Promise<Map<string, string>> {
  const launches = await prisma.launch.findMany({
    where: {
      chainId: env.CHAIN_ID,
      status: "active",
      rewardsEnabled: true,
      curve: { not: null },
    },
    select: { token: true, curve: true },
  });
  const map = new Map<string, string>();
  for (const row of launches) {
    if (!row.curve) continue;
    map.set(row.curve.toLowerCase(), row.token.toLowerCase());
  }
  return map;
}
