import type { TrenchPair } from "@prisma/client";
import type { Address } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { curveAbi, curveBuyEvent, curveSellEvent, factoryAbi, phaseName } from "./abi.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export type TrenchPairResponse = {
  token: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  logo: string;
  description: string;
  socials: {
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    farcaster: string;
  };
  deployer: string;
  curve: string;
  pairToken: string;
  launchConfigId: string;
  graduationThreshold: string;
  creatorFeeRecipient: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: string;
  taxPercent: number;
  mcap: string;
  athMcap: string;
  txns: number;
  volume: string;
  bundlers: number;
  holders: number;
  bondingPercentage: number;
  quoteDecimals: number;
  txHash: string;
  blockNumber: string;
  logIndex: number;
  launchedAt: string;
};

type Fill = {
  curve: string;
  blockNumber: bigint;
  logIndex: number;
  kind: "buy" | "sell";
  wallet: string;
  quote: bigint;
  tokens: bigint;
};

export function toStoredPair(row: TrenchPair): TrenchPairResponse {
  return {
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.totalSupply,
    logo: row.logo,
    description: row.description,
    socials: {
      twitter: row.twitter,
      telegram: row.telegram,
      discord: row.discord,
      website: row.website,
      farcaster: row.farcaster,
    },
    deployer: row.deployer,
    curve: row.curve,
    pairToken: row.pairToken,
    launchConfigId: row.launchConfigId,
    graduationThreshold: "0",
    creatorFeeRecipient: row.deployer,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: "NotGraduated",
    taxPercent: 0,
    mcap: "0",
    athMcap: "0",
    txns: 0,
    volume: "0",
    bundlers: 0,
    holders: 0,
    bondingPercentage: 0,
    quoteDecimals: row.pairToken === ZERO ? 18 : 18,
    txHash: row.txHash,
    blockNumber: row.blockNumber.toString(),
    logIndex: row.logIndex,
    launchedAt: row.launchedAt.toISOString(),
  };
}

export function formatAmount(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function asReserves(value: unknown): readonly [bigint, bigint] {
  if (Array.isArray(value)) return [value[0] as bigint, value[1] as bigint];
  const named = value as { quoteReserve?: bigint; tokenReserve?: bigint };
  if (named.quoteReserve != null && named.tokenReserve != null) {
    return [named.quoteReserve, named.tokenReserve];
  }
  const tuple = value as readonly [bigint, bigint];
  return [tuple[0], tuple[1]];
}

export function bonding(raised: bigint, threshold: bigint, phase: string): number {
  if (phase === "PoolCreated" || phase === "Swept") return 100;
  if (threshold <= 0n || raised <= 0n) return 0;
  const bps = raised >= threshold ? 10_000n : (raised * 10_000n) / threshold;
  return Math.min(100, Number(bps) / 100);
}

function peakMcap(supply: bigint, phantom: bigint, fills: Fill[]): bigint {
  if (supply <= 0n || phantom <= 0n) return 0n;
  const k = phantom * supply;
  let tokenReserve = supply;
  let peak = phantom;
  const ordered = [...fills].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  for (const fill of ordered) {
    tokenReserve += fill.kind === "buy" ? -fill.tokens : fill.tokens;
    if (tokenReserve <= 0n) continue;
    const mcap = (k * supply) / (tokenReserve * tokenReserve);
    if (mcap > peak) peak = mcap;
  }
  return peak;
}

async function loadFills(
  curves: Address[],
  fromBlock: bigint,
  toBlock: bigint,
  opts?: { newestFirst?: boolean; deadline?: number },
): Promise<Fill[]> {
  if (curves.length === 0 || fromBlock > toBlock) return [];
  const client = getPublicClient();
  const span = 99n;
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let from = fromBlock; from <= toBlock; from = from + span + 1n) {
    const to = from + span > toBlock ? toBlock : from + span;
    ranges.push({ from, to });
  }
  if (opts?.newestFirst) ranges.reverse();

  const fills: Fill[] = [];
  const width = opts?.deadline ? 4 : 12;
  for (let offset = 0; offset < ranges.length; offset += width) {
    if (opts?.deadline && Date.now() > opts.deadline) break;
    const slice = ranges.slice(offset, offset + width);
    const batches = await Promise.all(
      slice.flatMap((range) => {
        const groups: Address[][] = [];
        for (let i = 0; i < curves.length; i += 15) groups.push(curves.slice(i, i + 15));
        return groups.map(async (address) => {
          try {
            const [buys, sells] = await Promise.all([
              client.getLogs({
                address,
                event: curveBuyEvent,
                fromBlock: range.from,
                toBlock: range.to,
              }),
              client.getLogs({
                address,
                event: curveSellEvent,
                fromBlock: range.from,
                toBlock: range.to,
              }),
            ]);
            return { buys, sells };
          } catch {
            return { buys: [], sells: [] };
          }
        });
      }),
    );
    for (const batch of batches) {
      for (const log of batch.buys) {
        if (log.blockNumber == null || log.logIndex == null || log.args.quoteIn == null || log.args.tokensOut == null) {
          continue;
        }
        const wallet = (log.args.recipient ?? log.args.buyer)?.toLowerCase();
        if (!wallet) continue;
        fills.push({
          curve: log.address.toLowerCase(),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          kind: "buy",
          wallet,
          quote: log.args.quoteIn,
          tokens: log.args.tokensOut,
        });
      }
      for (const log of batch.sells) {
        if (log.blockNumber == null || log.logIndex == null || log.args.quoteOut == null || log.args.tokensIn == null) {
          continue;
        }
        const seller = log.args.seller?.toLowerCase();
        const wallet = seller === "0xca11bde05977b3631167028862be2a173976ca11" ? log.args.recipient?.toLowerCase() : seller;
        if (!wallet) continue;
        fills.push({
          curve: log.address.toLowerCase(),
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          kind: "sell",
          wallet,
          quote: log.args.quoteOut,
          tokens: log.args.tokensIn,
        });
      }
    }
  }
  return fills;
}

function tradeStats(fills: Fill[]) {
  const balances = new Map<string, bigint>();
  const buyersByBlock = new Map<string, Set<string>>();
  let volume = 0n;
  for (const fill of fills) {
    volume += fill.quote;
    const next = (balances.get(fill.wallet) ?? 0n) + (fill.kind === "buy" ? fill.tokens : -fill.tokens);
    if (next <= 0n) balances.delete(fill.wallet);
    else balances.set(fill.wallet, next);
    if (fill.kind === "buy") {
      const key = fill.blockNumber.toString();
      const buyers = buyersByBlock.get(key) ?? new Set<string>();
      buyers.add(fill.wallet);
      buyersByBlock.set(key, buyers);
    }
  }
  const bundlers = new Set<string>();
  for (const buyers of buyersByBlock.values()) {
    if (buyers.size < 2) continue;
    for (const buyer of buyers) bundlers.add(buyer);
  }
  return { txns: fills.length, volume, holders: balances.size, bundlers: bundlers.size };
}

const curveFills = new Map<string, Fill[]>();

type CurveHistory = {
  fills: Map<string, Fill>;
  /** Oldest block already scanned, inclusive. Null until the first pass. */
  oldest: bigint | null;
  newest: bigint;
};

const curveHistory = new Map<string, CurveHistory>();

function mergeFills(hist: CurveHistory, fills: Fill[]) {
  for (const fill of fills) {
    hist.fills.set(`${fill.blockNumber}:${fill.logIndex}:${fill.kind}`, fill);
  }
}

/** Walk trade logs back to the launch block and keep every fill for the chart. */
async function extendHistory(curve: Address, launchBlock: bigint): Promise<Fill[]> {
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  lastHead = { block: head, at: Date.now() };
  const key = curve.toLowerCase();
  let hist = curveHistory.get(key);
  if (!hist) {
    hist = { fills: new Map(), oldest: null, newest: launchBlock - 1n };
    curveHistory.set(key, hist);
  }
  const deadline = Date.now() + 25_000;
  if (hist.newest < head) {
    const next = hist.newest + 1n < launchBlock ? launchBlock : hist.newest + 1n;
    const from = head - next > 2_400n ? head - 2_400n : next;
    const loaded = await loadFills([curve], from, head);
    mergeFills(hist, loaded);
    hist.newest = head;
    if (hist.oldest == null || from < hist.oldest) hist.oldest = from;
  }
  while (hist.oldest != null && hist.oldest > launchBlock && Date.now() < deadline) {
    const to = hist.oldest - 1n;
    const from = to - 8_000n < launchBlock ? launchBlock : to - 8_000n;
    const loaded = await loadFills([curve], from, to);
    mergeFills(hist, loaded);
    hist.oldest = from;
  }
  curveFills.set(key, [...hist.fills.values()]);
  return [...hist.fills.values()];
}
let lastHead: { block: bigint; at: number } | null = null;

export async function readTrenchPairs(rows: TrenchPair[], opts?: { deadline?: number }): Promise<TrenchPairResponse[]> {
  if (rows.length === 0) return [];
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  lastHead = { block: head, at: Date.now() };
  const quoteTokens = [
    ...new Set(rows.map((row) => row.pairToken).filter((token) => token !== ZERO)),
  ] as Address[];

  const [curveRows, decimalRows, fills] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: rows.flatMap((row) => {
        const curve = row.curve as Address;
        const token = row.token as Address;
        return [
          {
            address: env.PONS_V2_FACTORY as Address,
            abi: factoryAbi,
            functionName: "getLaunchedToken" as const,
            args: [token] as const,
          },
          { address: curve, abi: curveAbi, functionName: "feeBps" as const },
          { address: curve, abi: curveAbi, functionName: "creatorTaxBps" as const },
          { address: curve, abi: curveAbi, functionName: "phantomQuote" as const },
          { address: curve, abi: curveAbi, functionName: "getReserves" as const },
          { address: curve, abi: curveAbi, functionName: "realQuoteReserve" as const },
          { address: curve, abi: curveAbi, functionName: "graduationThreshold" as const },
        ];
      }),
    }),
    quoteTokens.length === 0
      ? Promise.resolve([])
      : client.multicall({
          allowFailure: true,
          contracts: quoteTokens.map((address) => ({
            address,
            abi: curveAbi,
            functionName: "decimals" as const,
          })),
        }),
    loadFills(
      rows.map((row) => row.curve as Address),
      rows.reduce((min, row) => (row.blockNumber < min ? row.blockNumber : min), rows[0]!.blockNumber),
      head,
      opts?.deadline ? { newestFirst: true, deadline: opts.deadline } : undefined,
    ).then((loaded) => {
      const grouped = new Map<string, Fill[]>();
      for (const fill of loaded) {
        const list = grouped.get(fill.curve) ?? [];
        list.push(fill);
        grouped.set(fill.curve, list);
      }
      for (const row of rows) {
        const curve = row.curve.toLowerCase();
        curveFills.set(curve, grouped.get(curve) ?? []);
      }
      return loaded;
    }),
  ]);

  const decimalsByToken = new Map<string, number>();
  quoteTokens.forEach((token, index) => {
    const row = decimalRows[index];
    if (row && row.status === "success") decimalsByToken.set(token.toLowerCase(), Number(row.result));
  });

  const fillsByCurve = new Map<string, Fill[]>();
  for (const fill of fills) {
    const list = fillsByCurve.get(fill.curve) ?? [];
    list.push(fill);
    fillsByCurve.set(fill.curve, list);
  }

  return rows.map((row, index) => {
    const base = index * 7;
    const launched = curveRows[base];
    const fee = curveRows[base + 1];
    const creator = curveRows[base + 2];
    const phantom = curveRows[base + 3];
    const reserves = curveRows[base + 4];
    const raised = curveRows[base + 5];
    const threshold = curveRows[base + 6];
    const quoteDecimals = decimalsByToken.get(row.pairToken) ?? 18;
    const supply = BigInt(row.totalSupply);
    const curveFills = fillsByCurve.get(row.curve) ?? [];
    const stats = tradeStats(curveFills);

    let phase = "NotGraduated";
    let creatorFeeRecipient = row.deployer;
    let creatorTaxBps = 0;
    let buybackEnabled = false;
    let graduationThreshold = "0";
    if (launched?.status === "success") {
      const record = launched.result as {
        phase: number;
        creatorFeeRecipient: Address;
        creatorTaxBps: number;
        buybackEnabled: boolean;
        graduationThreshold: bigint;
      };
      phase = phaseName(record.phase);
      creatorFeeRecipient = record.creatorFeeRecipient.toLowerCase();
      creatorTaxBps = record.creatorTaxBps;
      buybackEnabled = record.buybackEnabled;
      graduationThreshold = record.graduationThreshold.toString();
    }

    let mcapRaw = 0n;
    if (reserves?.status === "success") {
      const [quoteReserve, tokenReserve] = asReserves(reserves.result);
      if (tokenReserve > 0n && supply > 0n) mcapRaw = (quoteReserve * supply) / tokenReserve;
    }
    const phantomRaw = phantom?.status === "success" ? (phantom.result as bigint) : 0n;
    const athRaw = (() => {
      const peak = peakMcap(supply, phantomRaw, curveFills);
      return peak > mcapRaw ? peak : mcapRaw;
    })();
    const raisedRaw = raised?.status === "success" ? (raised.result as bigint) : 0n;
    const thresholdRaw =
      threshold?.status === "success" ? (threshold.result as bigint) : BigInt(graduationThreshold);
    const feeBps = fee?.status === "success" ? Number(fee.result) : 0;
    void feeBps;
    const curveTaxBps = creator?.status === "success" ? Number(creator.result) : creatorTaxBps;

    return {
      token: row.token,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      totalSupply: row.totalSupply,
      logo: row.logo,
      description: row.description,
      socials: {
        twitter: row.twitter,
        telegram: row.telegram,
        discord: row.discord,
        website: row.website,
        farcaster: row.farcaster,
      },
      deployer: row.deployer,
      curve: row.curve,
      pairToken: row.pairToken,
      launchConfigId: row.launchConfigId,
      graduationThreshold,
      creatorFeeRecipient,
      creatorTaxBps,
      buybackEnabled,
      phase,
      taxPercent: curveTaxBps / 100,
      mcap: formatAmount(mcapRaw, quoteDecimals),
      athMcap: formatAmount(athRaw, quoteDecimals),
      txns: stats.txns,
      volume: formatAmount(stats.volume, quoteDecimals),
      bundlers: stats.bundlers,
      holders: stats.holders,
      bondingPercentage: bonding(raisedRaw, thresholdRaw, phase),
      quoteDecimals,
      txHash: row.txHash,
      blockNumber: row.blockNumber.toString(),
      logIndex: row.logIndex,
      launchedAt: row.launchedAt.toISOString(),
    };
  });
}

export type TrenchHolderRow = { address: string; amount: string; share: number };
export type TrenchTradeRow = {
  id: string;
  side: "buy" | "sell";
  wallet: string;
  tokens: string;
  quote: string;
  blockNumber: string;
  time: number;
};

export type TrenchCandle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type TrenchTick = { t: number; p: number; v: number };

function decimalAmount(value: bigint, decimals: number): number {
  if (value <= 0n) return 0;
  const scale = 1_000_000_000_000n;
  const base = 10n ** BigInt(Math.max(0, decimals));
  return Number((value * scale) / base) / 1e12;
}

function tradePrice(quote: bigint, tokens: bigint, tokenDecimals: number, quoteDecimals: number): number {
  if (quote <= 0n || tokens <= 0n) return 0;
  const scale = 1_000_000_000_000n;
  const num = quote * 10n ** BigInt(Math.max(0, tokenDecimals)) * scale;
  const den = tokens * 10n ** BigInt(Math.max(0, quoteDecimals));
  if (den <= 0n) return 0;
  return Number(num / den) / 1e12;
}

const CANDLE_STEPS = [5_000, 15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

/** OHLC in quote units from curve fills. Empty stretches keep the last close. */
function buildCandles(
  fills: Fill[],
  row: TrenchPair,
  pair: TrenchPairResponse,
  headBlock: bigint,
  headTimeMs: number,
): TrenchCandle[] {
  const launchMs = row.launchedAt.getTime();
  const endMs = Math.max(headTimeMs, launchMs + 1_000);
  const spanBlocks = Number(headBlock - row.blockNumber);
  const msPerBlock = spanBlocks > 0 ? Math.max(50, (endMs - launchMs) / spanBlocks) : 100;
  const blockMs = (block: bigint) => launchMs + Number(block - row.blockNumber) * msPerBlock;
  const supply = Number(row.totalSupply) / 10 ** Math.max(0, row.decimals);
  const spot = supply > 0 ? Number(pair.mcap) / supply : 0;
  const span = Math.max(endMs - launchMs, 60_000);
  const bucket = CANDLE_STEPS.find((step) => span / step <= 90) ?? CANDLE_STEPS[CANDLE_STEPS.length - 1]!;
  const ordered = [...fills].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  const bars = new Map<number, TrenchCandle>();
  let prev = spot;
  for (const fill of ordered) {
    const price = tradePrice(fill.quote, fill.tokens, row.decimals, pair.quoteDecimals);
    if (!(price > 0)) continue;
    const t = Math.floor(blockMs(fill.blockNumber) / bucket) * bucket;
    const bar = bars.get(t);
    const volume = decimalAmount(fill.quote, pair.quoteDecimals);
    if (!bar) {
      const open = prev > 0 ? prev : price;
      bars.set(t, { t, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: volume });
    } else {
      bar.h = Math.max(bar.h, price);
      bar.l = Math.min(bar.l, price);
      bar.c = price;
      bar.v += volume;
    }
    prev = price;
  }
  if (bars.size === 0) {
    if (!(spot > 0)) return [];
    return [{ t: Math.floor(endMs / bucket) * bucket, o: spot, h: spot, l: spot, c: spot, v: 0 }];
  }
  const candles = [...bars.values()].sort((a, b) => a.t - b.t);
  const live = candles[candles.length - 1];
  if (live && spot > 0) {
    live.h = Math.max(live.h, spot);
    live.l = Math.min(live.l, spot);
    live.c = spot;
  }
  return candles.slice(-90);
}

/** Trade prints in quote units, newest last, so the chart can rebuild any timeframe. */
const BLOCK_MS = 100;

function buildTicks(fills: Fill[], row: TrenchPair, pair: TrenchPairResponse): TrenchTick[] {
  const launchMs = row.launchedAt.getTime();
  const ordered = [...fills].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  const ticks: TrenchTick[] = [];
  for (const fill of ordered) {
    const price = tradePrice(fill.quote, fill.tokens, row.decimals, pair.quoteDecimals);
    if (!(price > 0)) continue;
    ticks.push({
      t: launchMs + Number(fill.blockNumber - row.blockNumber) * BLOCK_MS,
      p: price,
      v: decimalAmount(fill.quote, pair.quoteDecimals),
    });
  }
  return ticks;
}

/** One token: live pair plus the wallets and fills behind those numbers. */
export async function readTrenchTokenDetail(row: TrenchPair): Promise<{
  pair: TrenchPairResponse;
  holders: TrenchHolderRow[];
  trades: TrenchTradeRow[];
  candles: TrenchCandle[];
  ticks: TrenchTick[];
}> {
  const [pairs, fills] = await Promise.all([
    readTrenchPairs([row], { deadline: Date.now() + 4_000 }),
    extendHistory(row.curve as Address, row.blockNumber),
  ]);
  const pair = pairs[0] ?? toStoredPair(row);
  const balances = new Map<string, bigint>();
  for (const fill of fills) {
    const next = (balances.get(fill.wallet) ?? 0n) + (fill.kind === "buy" ? fill.tokens : -fill.tokens);
    if (next <= 0n) balances.delete(fill.wallet);
    else balances.set(fill.wallet, next);
  }
  const supply = BigInt(row.totalSupply);
  const holders = [...balances.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .slice(0, 50)
    .map(([address, amount]) => ({
      address,
      amount: formatAmount(amount, row.decimals),
      share: supply > 0n ? Number((amount * 10_000n) / supply) / 100 : 0,
    }));
  const trades = [...fills]
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? 1 : -1;
      return b.logIndex - a.logIndex;
    })
    .slice(0, 40)
    .map((fill) => ({
      id: `${fill.blockNumber}-${fill.logIndex}`,
      side: fill.kind,
      wallet: fill.wallet,
      tokens: formatAmount(fill.tokens, row.decimals),
      quote: formatAmount(fill.quote, pair.quoteDecimals),
      blockNumber: fill.blockNumber.toString(),
      time: row.launchedAt.getTime() + Number(fill.blockNumber - row.blockNumber) * BLOCK_MS,
    }));
  const head = lastHead ?? { block: row.blockNumber, at: Date.now() };
  const candles = buildCandles(fills, row, pair, head.block, head.at);
  const ticks = buildTicks(fills, row, pair);
  return { pair, holders, trades, candles, ticks };
}
