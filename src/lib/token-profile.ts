import { formatUnits, getAddress, parseAbi, parseAbiItem, type Address } from "viem";
import { getEthUsd } from "../clients/eth-price.js";
import { env } from "../config/env.js";
import { getPublicClient } from "../clients/rpc.js";
import { curveBuyEvent, curveSellEvent, tokenAbi } from "../pons-adapter/abi.js";

const erc20MetaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const BURN_ADDRESSES = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
] as const;

/** Live price samples built from on-chain spot / Pons trades (no Mobula). */
const liveCandleBuf = new Map<string, Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>>();

function asTokenString(value: unknown): string {
  if (typeof value === "string") return value.replace(/\0/g, "").trim();
  if (typeof value === "object" && value && "toString" in value) {
    return String(value).replace(/\0/g, "").trim();
  }
  return "";
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Turn ipfs:// / ar:// into a browser-loadable https URL. */
export function browserLogoUrl(logo: string): string {
  const value = logo.trim();
  if (!value) return "";
  const ipfs = value.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (ipfs) {
    const cid = ipfs[1].replace(/^\/+/, "");
    return `https://ipfs.filebase.io/ipfs/${cid}`;
  }
  const ar = value.match(/^ar:\/\/(.+)$/i);
  if (ar) return `https://arweave.net/${ar[1]}`;
  if (/^https?:\/\//i.test(value)) return value;
  const viaIpfs = value.match(/\/ipfs\/([^/?#]+)/i);
  if (viaIpfs && !/^https?:\/\//i.test(value)) {
    return `https://ipfs.filebase.io/ipfs/${viaIpfs[1]}`;
  }
  return value;
}

export type TokenSocials = {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
};

export type TokenProfile = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  description: string;
  totalSupply: number | null;
  socials: TokenSocials;
};

export type LootingLiveMarket = {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  liquidity: number | null;
  change24h: number | null;
  holders: number | null;
  circulating: number | null;
  totalSupply: number | null;
  burned: number | null;
  burnedUsd: number | null;
  asOf: string;
};

export type LootingCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

type PonsTokenDetail = {
  priceUsd?: number;
  priceEth?: number;
  mcapUsd?: number;
  fdvUsd?: number;
  circulatingSupply?: string | number;
  burnedRaw?: string | number;
  supplyRaw?: string | number;
  holders?: number | string | null;
  holderCount?: number | string | null;
  holdersCount?: number | string | null;
  logo?: string | null;
  name?: string;
  symbol?: string;
  description?: string;
  graduated?: boolean;
  pool?: string | null;
  pairedToken?: string | null;
  pairedPrincipalEth?: number | string | null;
  launchBlock?: number | string | null;
  launchedAt?: string | null;
  quoteSymbol?: string | null;
  curve?: string | null;
  socials?: {
    twitter?: string | null;
    telegram?: string | null;
    discord?: string | null;
    website?: string | null;
    farcaster?: string | null;
  } | null;
  reserves?: { quote?: number; realQuote?: number; phantomQuote?: number };
};

const poolMetaAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/** Cached launch→now pool price series (slot0 samples). */
const historyCache = new Map<string, { at: number; candles: LootingCandle[] }>();
const HISTORY_TTL_MS = 90_000;
const HISTORY_SAMPLES = 200;
const HISTORY_CONCURRENCY = 12;

/** Cached 24h pool swap volume from on-chain Swap logs. */
const volumeCache = new Map<string, { at: number; volumeUsd: number; change24h: number | null }>();
const VOLUME_TTL_MS = 60_000;
/** Cached holder count from bonding-curve fills. */
const holdersCache = new Map<string, { at: number; holders: number }>();
const HOLDERS_TTL_MS = 60_000;
const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const LOG_CHUNK = 40_000n;
const LOG_CONCURRENCY = 4;

type PonsTrade = {
  priceUsd?: number;
  amountUsd?: number;
  timestamp?: number | string;
  blockTimestamp?: number | string;
  createdAt?: string;
  time?: number | string;
};

function ponsBase() {
  return (env.PONSAPI_BASE_URL || "https://api.ponsapi.dev").replace(/\/$/, "");
}

function ponsKey() {
  return env.PONSAPI_API_KEY?.trim() || "";
}

async function ponsGet<T>(path: string, query?: Record<string, string | number>): Promise<T | null> {
  const key = ponsKey();
  if (!key) return null;
  try {
    const url = new URL(path, `${ponsBase()}/`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Accept: "application/json", "x-api-key": key },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function readChainMeta(token: Address): Promise<{
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  description: string;
  socials: TokenSocials;
  totalSupplyRaw: bigint | null;
}> {
  const client = getPublicClient();
  const [symbolRes, nameRes, decimalsRes, supplyRes, infoRes] = await Promise.allSettled([
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "totalSupply" }),
    client.readContract({ address: token, abi: tokenAbi, functionName: "getTokenInfo" }),
  ]);

  const symbol = symbolRes.status === "fulfilled" ? asTokenString(symbolRes.value) : "";
  const name = nameRes.status === "fulfilled" ? asTokenString(nameRes.value) : "";
  const decimals =
    decimalsRes.status === "fulfilled" && typeof decimalsRes.value === "number"
      ? decimalsRes.value
      : 18;
  const totalSupplyRaw =
    supplyRes.status === "fulfilled" && typeof supplyRes.value === "bigint" ? supplyRes.value : null;

  let logo = "";
  let description = "";
  let socials: TokenSocials = {
    twitter: "",
    telegram: "",
    discord: "",
    website: "",
    farcaster: "",
  };
  if (infoRes.status === "fulfilled") {
    const info = infoRes.value as readonly [
      Address,
      string,
      string,
      {
        twitter?: string;
        telegram?: string;
        discord?: string;
        website?: string;
        farcaster?: string;
      },
    ];
    logo = (info[1] ?? "").trim();
    description = (info[2] ?? "").trim();
    const s = info[3] ?? {};
    socials = {
      twitter: asTokenString(s.twitter),
      telegram: asTokenString(s.telegram),
      discord: asTokenString(s.discord),
      website: asTokenString(s.website),
      farcaster: asTokenString(s.farcaster),
    };
  }

  return { symbol, name, decimals, logo, description, socials, totalSupplyRaw };
}

async function readBurned(token: Address, decimals: number): Promise<number | null> {
  const client = getPublicClient();
  try {
    const balances = await Promise.all(
      BURN_ADDRESSES.map((addr) =>
        client.readContract({
          address: token,
          abi: erc20MetaAbi,
          functionName: "balanceOf",
          args: [addr as Address],
        }),
      ),
    );
    let sum = 0n;
    for (const bal of balances) sum += bal;
    if (sum <= 0n) return 0;
    return Number(formatUnits(sum, decimals));
  } catch {
    return null;
  }
}

async function fetchPonsTokenDetail(address: string): Promise<PonsTokenDetail | null> {
  return ponsGet<PonsTokenDetail>(`/v1/tokens/${address}`);
}

const WETH_SYMBOLS = new Set(["WETH", "ETH", "WBNB", "BNB"]);
const STABLE_SYMBOLS = new Set(["USDG", "USDC", "USDT", "DAI", "USD", "USDB", "USDE"]);

/** Uniswap V3: token1 per token0 from sqrtPriceX96, decimal-adjusted. */
function token1PerToken0(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return 0;
  return ratio * ratio * 10 ** (dec0 - dec1);
}

function usdFromPoolSpot(opts: {
  sqrtPriceX96: bigint;
  token0: Address;
  token1: Address;
  dec0: number;
  dec1: number;
  sym0: string;
  sym1: string;
  target: string;
  ethUsd: number;
}): number {
  const t1PerT0 = token1PerToken0(opts.sqrtPriceX96, opts.dec0, opts.dec1);
  if (!(t1PerT0 > 0)) return 0;
  const t0 = opts.token0.toLowerCase();
  const t1 = opts.token1.toLowerCase();
  const s0 = opts.sym0.toUpperCase();
  const s1 = opts.sym1.toUpperCase();

  // Stable quote pools (e.g. USDG/VRAX): price is already USD.
  if (t1 === opts.target && STABLE_SYMBOLS.has(s0)) return 1 / t1PerT0;
  if (t0 === opts.target && STABLE_SYMBOLS.has(s1)) return t1PerT0;

  // WETH quote pools.
  if (!(opts.ethUsd > 0)) return 0;
  if (t1 === opts.target && WETH_SYMBOLS.has(s0)) return (1 / t1PerT0) * opts.ethUsd;
  if (t0 === opts.target && WETH_SYMBOLS.has(s1)) return t1PerT0 * opts.ethUsd;
  return 0;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

/**
 * Real launch→now USD series from on-chain Uniswap V3 slot0 samples.
 * Uses current ETH/USD to convert (shape is on-chain PONS/ETH; level matches live spot).
 */
async function samplePoolHistoryCandles(opts: {
  pool: string;
  token: string;
  launchBlock: bigint;
  spotUsd?: number | null;
}): Promise<LootingCandle[]> {
  const cacheKey = `${opts.token}:${opts.pool}:${opts.launchBlock.toString()}`;
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.candles;

  const client = getPublicClient();
  const pool = getAddress(opts.pool) as Address;
  const target = getAddress(opts.token).toLowerCase();
  const latest = await client.getBlockNumber();
  const from = opts.launchBlock > latest ? latest : opts.launchBlock;
  if (latest <= from) return [];

  const [token0, token1, ethUsd, launchBlock, headBlock] = await Promise.all([
    client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token0" }),
    client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token1" }),
    getEthUsd(),
    client.getBlock({ blockNumber: from }),
    client.getBlock({ blockNumber: latest }),
  ]);
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "decimals" }),
    client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "decimals" }),
    client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "symbol" }),
    client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "symbol" }),
  ]);

  const launchMs = Number(launchBlock.timestamp) * 1000;
  const headMs = Number(headBlock.timestamp) * 1000;
  const spanBlocks = latest - from;
  const samples = Math.max(2, Math.min(HISTORY_SAMPLES, Number(spanBlocks) + 1));
  const blocks: bigint[] = [];
  for (let i = 0; i < samples; i += 1) {
    const b = from + (spanBlocks * BigInt(i)) / BigInt(samples - 1);
    blocks.push(b > latest ? latest : b);
  }
  // Dedupe consecutive identical blocks.
  const unique: bigint[] = [];
  for (const b of blocks) {
    if (unique.length === 0 || unique[unique.length - 1] !== b) unique.push(b);
  }

  const prices = await mapPool(unique, HISTORY_CONCURRENCY, async (blockNumber) => {
    try {
      const slot0 = await client.readContract({
        address: pool,
        abi: poolMetaAbi,
        functionName: "slot0",
        blockNumber,
      });
      const usd = usdFromPoolSpot({
        sqrtPriceX96: slot0[0],
        token0,
        token1,
        dec0,
        dec1,
        sym0: asTokenString(sym0),
        sym1: asTokenString(sym1),
        target,
        ethUsd,
      });
      return usd > 0 ? usd : null;
    } catch {
      return null;
    }
  });

  const candles: LootingCandle[] = [];
  let prev: number | null = null;
  for (let i = 0; i < unique.length; i += 1) {
    const block = unique[i]!;
    let price = prices[i];
    if (price == null || !(price > 0)) {
      if (prev == null) continue;
      price = prev;
    }
    const t =
      spanBlocks > 0n
        ? launchMs + Number(((block - from) * BigInt(Math.max(0, headMs - launchMs))) / spanBlocks)
        : headMs;
    const last = candles[candles.length - 1];
    if (last && last.t === t) {
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
    } else {
      candles.push({ t, o: prev ?? price, h: Math.max(prev ?? price, price), l: Math.min(prev ?? price, price), c: price, v: 0 });
    }
    prev = price;
  }

  if (candles.length > 0 && opts.spotUsd != null && opts.spotUsd > 0) {
    const last = candles[candles.length - 1]!;
    last.c = opts.spotUsd;
    last.h = Math.max(last.h, opts.spotUsd);
    last.l = Math.min(last.l, opts.spotUsd);
    last.t = Math.max(last.t, Date.now());
  }

  if (candles.length > 0) historyCache.set(cacheKey, { at: Date.now(), candles });
  return candles;
}

/** Bonding-curve fills → USD candles (covers launch → graduation before pool exists). */
async function sampleCurveHistoryCandles(opts: {
  curve: string;
  launchBlock: bigint;
  quoteSymbol?: string | null;
  tokenDecimals: number;
  quoteDecimals?: number | null;
  ethUsd: number;
}): Promise<LootingCandle[]> {
  const cacheKey = `curve:${opts.curve}:${opts.launchBlock.toString()}`;
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.candles;

  const client = getPublicClient();
  const curve = getAddress(opts.curve) as Address;
  const latest = await client.getBlockNumber();
  const from = opts.launchBlock > latest ? latest : opts.launchBlock;
  if (latest <= from) return [];

  const [launchBlock, headBlock] = await Promise.all([
    client.getBlock({ blockNumber: from }),
    client.getBlock({ blockNumber: latest }),
  ]);
  const launchMs = Number(launchBlock.timestamp) * 1000;
  const headMs = Number(headBlock.timestamp) * 1000;
  const spanBlocks = latest - from;
  const quoteSym = (opts.quoteSymbol || "WETH").toUpperCase();
  const quoteIsStable = STABLE_SYMBOLS.has(quoteSym);
  const quoteDecimals = opts.quoteDecimals ?? (quoteIsStable ? 6 : 18);
  const tokenDecimals = opts.tokenDecimals || 18;

  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let start = from; start <= latest; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
    ranges.push({ from: start, to: end });
  }

  const batches = await mapPool(ranges, LOG_CONCURRENCY, async (range) => {
    try {
      const [buys, sells] = await Promise.all([
        client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: range.from, toBlock: range.to }),
        client.getLogs({ address: curve, event: curveSellEvent, fromBlock: range.from, toBlock: range.to }),
      ]);
      return [...buys, ...sells];
    } catch {
      const mid = range.from + (range.to - range.from) / 2n;
      try {
        const [a1, a2, b1, b2] = await Promise.all([
          client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: range.from, toBlock: mid }),
          client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: mid + 1n, toBlock: range.to }),
          client.getLogs({ address: curve, event: curveSellEvent, fromBlock: range.from, toBlock: mid }),
          client.getLogs({ address: curve, event: curveSellEvent, fromBlock: mid + 1n, toBlock: range.to }),
        ]);
        return [...a1, ...a2, ...b1, ...b2];
      } catch {
        return [];
      }
    }
  });

  type Fill = { block: bigint; logIndex: number; priceUsd: number; volUsd: number };
  const fills: Fill[] = [];
  for (const log of batches.flat()) {
    const block = log.blockNumber;
    if (block == null) continue;
    const args = log.args as {
      quoteIn?: bigint;
      tokensOut?: bigint;
      tokensIn?: bigint;
      quoteOut?: bigint;
    };
    let quote = 0n;
    let tokens = 0n;
    if (typeof args.quoteIn === "bigint" && typeof args.tokensOut === "bigint") {
      quote = args.quoteIn;
      tokens = args.tokensOut;
    } else if (typeof args.quoteOut === "bigint" && typeof args.tokensIn === "bigint") {
      quote = args.quoteOut;
      tokens = args.tokensIn;
    }
    if (quote <= 0n || tokens <= 0n) continue;
    const quoteAmt = Number(formatUnits(quote, quoteDecimals));
    const tokenAmt = Number(formatUnits(tokens, tokenDecimals));
    if (!(quoteAmt > 0) || !(tokenAmt > 0)) continue;
    let priceUsd = quoteAmt / tokenAmt;
    let volUsd = quoteAmt;
    if (!quoteIsStable) {
      if (!(opts.ethUsd > 0)) continue;
      priceUsd *= opts.ethUsd;
      volUsd *= opts.ethUsd;
    }
    if (!(priceUsd > 0)) continue;
    fills.push({ block, logIndex: log.logIndex ?? 0, priceUsd, volUsd });
  }

  fills.sort((a, b) => {
    if (a.block !== b.block) return a.block < b.block ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  if (fills.length === 0) return [];

  const targetBars = 120;
  const bucketBlocks = spanBlocks / BigInt(Math.max(1, targetBars));
  const step = bucketBlocks > 0n ? bucketBlocks : 1n;
  const bars = new Map<number, LootingCandle>();
  let prev = 0;
  for (const fill of fills) {
    const bucketBlock = from + ((fill.block - from) / step) * step;
    const t =
      spanBlocks > 0n
        ? launchMs + Number(((bucketBlock - from) * BigInt(Math.max(0, headMs - launchMs))) / spanBlocks)
        : headMs;
    const open = prev > 0 ? prev : fill.priceUsd;
    const existing = bars.get(t);
    if (!existing) {
      bars.set(t, {
        t,
        o: open,
        h: Math.max(open, fill.priceUsd),
        l: Math.min(open, fill.priceUsd),
        c: fill.priceUsd,
        v: fill.volUsd,
      });
    } else {
      existing.h = Math.max(existing.h, fill.priceUsd);
      existing.l = Math.min(existing.l, fill.priceUsd);
      existing.c = fill.priceUsd;
      existing.v += fill.volUsd;
    }
    prev = fill.priceUsd;
  }

  const candles = [...bars.values()].sort((a, b) => a.t - b.t);
  if (candles.length > 0) historyCache.set(cacheKey, { at: Date.now(), candles });
  return candles;
}

function mergeCandles(a: LootingCandle[], b: LootingCandle[]): LootingCandle[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const cut = b[0]!.t;
  const head = a.filter((c) => c.t < cut);
  return [...head, ...b].sort((x, y) => x.t - y.t);
}

function absUnits(value: bigint, decimals: number): number {
  const abs = value < 0n ? -value : value;
  return Number(formatUnits(abs, decimals));
}

async function estimateBlocksForMs(ms: number): Promise<bigint> {
  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const sample = latest > 100_000n ? 100_000n : latest > 10n ? latest / 2n : 1n;
  const [head, older] = await Promise.all([
    client.getBlock({ blockNumber: latest }),
    client.getBlock({ blockNumber: latest - sample }),
  ]);
  const elapsed = Math.max(1, (Number(head.timestamp) - Number(older.timestamp)) * 1000);
  const msPerBlock = elapsed / Number(sample);
  return BigInt(Math.max(1, Math.ceil(ms / Math.max(50, msPerBlock))));
}

function holdersFromPons(pons: PonsTokenDetail | null): number | null {
  if (!pons) return null;
  for (const raw of [pons.holders, pons.holderCount, pons.holdersCount]) {
    const n = num(raw);
    if (n != null && n >= 0) return Math.round(n);
  }
  return null;
}

/**
 * Approximate current holders from bonding-curve buy/sell net balances
 * (same approach as pons-adapter trenches board).
 */
async function countCurveHolders(curveAddr: string, launchBlock: bigint): Promise<number | null> {
  const key = curveAddr.toLowerCase();
  const hit = holdersCache.get(key);
  if (hit && Date.now() - hit.at < HOLDERS_TTL_MS) return hit.holders;

  try {
    const client = getPublicClient();
    const curve = getAddress(curveAddr) as Address;
    const latest = await client.getBlockNumber();
    const from = launchBlock > latest ? latest : launchBlock;
    if (latest < from) return null;

    const ranges: Array<{ from: bigint; to: bigint }> = [];
    for (let start = from; start <= latest; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
      ranges.push({ from: start, to: end });
    }

    const batches = await mapPool(ranges, LOG_CONCURRENCY, async (range) => {
      try {
        const [buys, sells] = await Promise.all([
          client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: range.from, toBlock: range.to }),
          client.getLogs({ address: curve, event: curveSellEvent, fromBlock: range.from, toBlock: range.to }),
        ]);
        return { buys, sells };
      } catch {
        const mid = range.from + (range.to - range.from) / 2n;
        try {
          const [b1, b2, s1, s2] = await Promise.all([
            client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: range.from, toBlock: mid }),
            client.getLogs({ address: curve, event: curveBuyEvent, fromBlock: mid + 1n, toBlock: range.to }),
            client.getLogs({ address: curve, event: curveSellEvent, fromBlock: range.from, toBlock: mid }),
            client.getLogs({ address: curve, event: curveSellEvent, fromBlock: mid + 1n, toBlock: range.to }),
          ]);
          return { buys: [...b1, ...b2], sells: [...s1, ...s2] };
        } catch {
          return { buys: [], sells: [] };
        }
      }
    });

    type Fill = { block: bigint; logIndex: number; wallet: string; tokens: bigint; kind: "buy" | "sell" };
    const fills: Fill[] = [];
    for (const batch of batches) {
      for (const log of batch.buys) {
        if (log.blockNumber == null) continue;
        const args = log.args as { buyer?: Address; tokensOut?: bigint };
        if (!args.buyer || typeof args.tokensOut !== "bigint" || args.tokensOut <= 0n) continue;
        fills.push({
          block: log.blockNumber,
          logIndex: log.logIndex ?? 0,
          wallet: args.buyer.toLowerCase(),
          tokens: args.tokensOut,
          kind: "buy",
        });
      }
      for (const log of batch.sells) {
        if (log.blockNumber == null) continue;
        const args = log.args as { seller?: Address; tokensIn?: bigint };
        if (!args.seller || typeof args.tokensIn !== "bigint" || args.tokensIn <= 0n) continue;
        fills.push({
          block: log.blockNumber,
          logIndex: log.logIndex ?? 0,
          wallet: args.seller.toLowerCase(),
          tokens: args.tokensIn,
          kind: "sell",
        });
      }
    }

    fills.sort((a, b) => {
      if (a.block !== b.block) return a.block < b.block ? -1 : 1;
      return a.logIndex - b.logIndex;
    });

    const balances = new Map<string, bigint>();
    for (const fill of fills) {
      const cur = balances.get(fill.wallet) ?? 0n;
      const next = fill.kind === "buy" ? cur + fill.tokens : cur - fill.tokens;
      balances.set(fill.wallet, next);
    }
    let holders = 0;
    for (const amount of balances.values()) {
      if (amount > 0n) holders += 1;
    }
    holdersCache.set(key, { at: Date.now(), holders });
    return holders;
  } catch {
    return null;
  }
}

/** Resolve chart start block: launchBlock, or launchedAt → approx block, clamped to chain head. */
async function resolveHistoryStartBlock(pons: PonsTokenDetail | null): Promise<bigint | null> {
  if (pons?.launchBlock != null) {
    try {
      const n = BigInt(String(pons.launchBlock));
      if (n > 0n) return n;
    } catch {
      /* fall through */
    }
  }
  const launchedAt = pons?.launchedAt ? Date.parse(pons.launchedAt) : NaN;
  if (!Number.isFinite(launchedAt) || launchedAt <= 0) return null;

  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const head = await client.getBlock({ blockNumber: latest });
  const headMs = Number(head.timestamp) * 1000;
  const ageMs = Math.max(0, headMs - launchedAt);
  const blocksBack = await estimateBlocksForMs(ageMs);
  let guess = latest > blocksBack ? latest - blocksBack : 0n;

  // Refine with a few binary-ish reads around the estimate.
  for (let i = 0; i < 8; i += 1) {
    try {
      const block = await client.getBlock({ blockNumber: guess });
      const ts = Number(block.timestamp) * 1000;
      const deltaMs = launchedAt - ts;
      if (Math.abs(deltaMs) < 30_000) break;
      const step = await estimateBlocksForMs(Math.abs(deltaMs));
      guess = deltaMs > 0 ? guess + step : guess > step ? guess - step : 0n;
      if (guess > latest) guess = latest;
    } catch {
      break;
    }
  }
  return guess;
}

async function getLogsChunked(
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Array<{ args: { amount0?: bigint; amount1?: bigint } }>> {
  const client = getPublicClient();
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    ranges.push({ from: start, to: end });
  }

  const batches = await mapPool(ranges, LOG_CONCURRENCY, async (range) => {
    try {
      return await client.getLogs({
        address: pool,
        event: SWAP_EVENT,
        fromBlock: range.from,
        toBlock: range.to,
      });
    } catch {
      // Retry once with half range on RPC limit / transient fail.
      const mid = range.from + (range.to - range.from) / 2n;
      try {
        const [a, b] = await Promise.all([
          client.getLogs({ address: pool, event: SWAP_EVENT, fromBlock: range.from, toBlock: mid }),
          client.getLogs({ address: pool, event: SWAP_EVENT, fromBlock: mid + 1n, toBlock: range.to }),
        ]);
        return [...a, ...b];
      } catch {
        return [];
      }
    }
  });
  return batches.flat();
}

/**
 * 24h USD volume from Uniswap V3 Swap logs (quote/WETH notional) + 24h change from slot0.
 */
async function readPoolVolume24h(
  poolRaw: string,
  tokenAddress: string,
  priceUsd: number | null,
): Promise<{ volumeUsd: number | null; change24h: number | null }> {
  const pool = getAddress(poolRaw) as Address;
  const token = getAddress(tokenAddress).toLowerCase();
  const cacheKey = pool.toLowerCase();
  const hit = volumeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < VOLUME_TTL_MS) {
    return { volumeUsd: hit.volumeUsd, change24h: hit.change24h };
  }

  try {
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const blocks24h = await estimateBlocksForMs(24 * 60 * 60 * 1000);
    const fromBlock = latest > blocks24h ? latest - blocks24h : 0n;

    const [token0, token1, ethUsd] = await Promise.all([
      client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token0" }),
      client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token1" }),
      getEthUsd(),
    ]);
    const [dec0, dec1, sym0, sym1] = await Promise.all([
      client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "decimals" }),
      client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "decimals" }),
      client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "symbol" }),
      client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "symbol" }),
    ]);
    const s0 = asTokenString(sym0).toUpperCase();
    const s1 = asTokenString(sym1).toUpperCase();
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    const [logs, slotThen] = await Promise.all([
      getLogsChunked(pool, fromBlock, latest),
      client
        .readContract({ address: pool, abi: poolMetaAbi, functionName: "slot0", blockNumber: fromBlock })
        .catch(() => null),
    ]);

    let volumeUsd = 0;
    for (const log of logs) {
      const a0 = log.args.amount0;
      const a1 = log.args.amount1;
      if (typeof a0 !== "bigint" || typeof a1 !== "bigint") continue;
      if (STABLE_SYMBOLS.has(s0)) {
        volumeUsd += absUnits(a0, dec0);
      } else if (STABLE_SYMBOLS.has(s1)) {
        volumeUsd += absUnits(a1, dec1);
      } else if (WETH_SYMBOLS.has(s0) && ethUsd > 0) {
        volumeUsd += absUnits(a0, dec0) * ethUsd;
      } else if (WETH_SYMBOLS.has(s1) && ethUsd > 0) {
        volumeUsd += absUnits(a1, dec1) * ethUsd;
      } else if (priceUsd != null && priceUsd > 0) {
        if (t0 === token) volumeUsd += absUnits(a0, dec0) * priceUsd;
        else if (t1 === token) volumeUsd += absUnits(a1, dec1) * priceUsd;
      }
    }

    let change24h: number | null = null;
    if (slotThen && priceUsd != null && priceUsd > 0) {
      const thenUsd = usdFromPoolSpot({
        sqrtPriceX96: slotThen[0],
        token0,
        token1,
        dec0,
        dec1,
        sym0: s0,
        sym1: s1,
        target: token,
        ethUsd,
      });
      if (thenUsd > 0) {
        change24h = Number((((priceUsd - thenUsd) / thenUsd) * 100).toFixed(2));
      }
    }

    if (volumeUsd > 0) {
      volumeCache.set(cacheKey, { at: Date.now(), volumeUsd, change24h });
      return { volumeUsd, change24h };
    }
    return { volumeUsd: null, change24h };
  } catch {
    return { volumeUsd: null, change24h: null };
  }
}

/** Graduated Uniswap-style pool TVL from on-chain ERC-20 balances (no aggregator). */
async function readPoolLiquidityUsd(
  poolRaw: string,
  tokenAddress: string,
  priceUsd: number | null,
): Promise<number | null> {
  try {
    const pool = getAddress(poolRaw) as Address;
    const token = getAddress(tokenAddress) as Address;
    const client = getPublicClient();
    const [token0, token1] = await Promise.all([
      client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token0" }),
      client.readContract({ address: pool, abi: poolMetaAbi, functionName: "token1" }),
    ]);

    const [bal0, bal1, dec0, dec1, sym0, sym1] = await Promise.all([
      client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "balanceOf", args: [pool] }),
      client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "balanceOf", args: [pool] }),
      client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "decimals" }),
      client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "decimals" }),
      client.readContract({ address: token0, abi: erc20MetaAbi, functionName: "symbol" }),
      client.readContract({ address: token1, abi: erc20MetaAbi, functionName: "symbol" }),
    ]);

    const amt0 = Number(formatUnits(bal0, dec0));
    const amt1 = Number(formatUnits(bal1, dec1));
    if (!Number.isFinite(amt0) || !Number.isFinite(amt1)) return null;

    const ethUsd = await getEthUsd();
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const target = token.toLowerCase();
    const s0 = asTokenString(sym0).toUpperCase();
    const s1 = asTokenString(sym1).toUpperCase();

    let usd = 0;
    const side = (addr: string, amount: number, symbol: string) => {
      if (!(amount > 0)) return;
      if (addr === target && priceUsd != null && priceUsd > 0) {
        usd += amount * priceUsd;
        return;
      }
      if (WETH_SYMBOLS.has(symbol) && ethUsd > 0) {
        usd += amount * ethUsd;
      }
    };
    side(t0, amt0, s0);
    side(t1, amt1, s1);
    return usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

async function fetchPonsTrades(address: string): Promise<PonsTrade[]> {
  const body = await ponsGet<{ trades?: PonsTrade[] }>(`/v1/tokens/${address}/trades`, {
    minutes: 24 * 60,
  });
  return Array.isArray(body?.trades) ? body.trades : [];
}

function tradeTs(t: PonsTrade): number {
  const candidates = [t.timestamp, t.blockTimestamp, t.time, t.createdAt];
  for (const raw of candidates) {
    if (raw == null) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw < 1e12 ? raw * 1000 : raw;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function tradesToVolumeAndChange(trades: PonsTrade[]): { volume24h: number; change24h: number | null } {
  let volume24h = 0;
  const prices: number[] = [];
  const chronological = [...trades].sort((a, b) => tradeTs(a) - tradeTs(b));
  for (const t of chronological) {
    const usd = Number(t.amountUsd);
    if (Number.isFinite(usd)) volume24h += Math.abs(usd);
    const p = Number(t.priceUsd);
    if (p > 0) prices.push(p);
  }
  let change24h: number | null = null;
  if (prices.length >= 2) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    if (first > 0) change24h = Number((((last - first) / first) * 100).toFixed(2));
  }
  return { volume24h, change24h };
}

function tradesToCandles(trades: PonsTrade[], bucketMs = 60 * 60 * 1000): LootingCandle[] {
  const bars = new Map<number, LootingCandle>();
  const chronological = [...trades].sort((a, b) => tradeTs(a) - tradeTs(b));
  for (const t of chronological) {
    const price = Number(t.priceUsd);
    if (!(price > 0)) continue;
    let ts = tradeTs(t);
    if (!(ts > 0)) ts = Date.now();
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const vol = Math.abs(Number(t.amountUsd) || 0);
    const existing = bars.get(bucket);
    if (!existing) {
      bars.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, v: vol });
    } else {
      existing.h = Math.max(existing.h, price);
      existing.l = Math.min(existing.l, price);
      existing.c = price;
      existing.v += vol;
    }
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}

function pushLiveCandle(token: string, price: number, volume = 0): LootingCandle[] {
  if (!(price > 0) || !Number.isFinite(price)) return liveCandleBuf.get(token) ?? [];
  const now = Date.now();
  const arr = liveCandleBuf.get(token) ?? [];
  const last = arr[arr.length - 1];
  if (last && now - last.t < 8_000) {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.v += volume;
    liveCandleBuf.set(token, arr);
    return arr;
  }
  arr.push({ t: now, o: price, h: price, l: price, c: price, v: volume });
  if (arr.length > 720) arr.splice(0, arr.length - 720);
  liveCandleBuf.set(token, arr);
  return arr;
}

/** On-chain profile for admin autofill / public $LOOTING page (Pons meta as logo fallback). */
export async function resolveTokenProfile(rawAddress: string): Promise<TokenProfile> {
  const address = getAddress(rawAddress.trim()).toLowerCase();
  const token = getAddress(address) as Address;
  const chain = await readChainMeta(token);

  let logo = chain.logo;
  let symbol = chain.symbol;
  let name = chain.name;
  let description = chain.description;
  const socials: TokenSocials = { ...chain.socials };

  const pons = await fetchPonsTokenDetail(address);
  if (pons) {
    if (!logo && pons.logo) logo = pons.logo;
    if (!symbol && pons.symbol) symbol = pons.symbol;
    if (!name && pons.name) name = pons.name;
    if (!description && pons.description) description = pons.description;
    const ps = pons.socials;
    if (ps) {
      if (!socials.twitter && ps.twitter) socials.twitter = asTokenString(ps.twitter);
      if (!socials.telegram && ps.telegram) socials.telegram = asTokenString(ps.telegram);
      if (!socials.discord && ps.discord) socials.discord = asTokenString(ps.discord);
      if (!socials.website && ps.website) socials.website = asTokenString(ps.website);
      if (!socials.farcaster && ps.farcaster) socials.farcaster = asTokenString(ps.farcaster);
    }
  }

  const totalSupply =
    chain.totalSupplyRaw != null ? Number(formatUnits(chain.totalSupplyRaw, chain.decimals)) : null;

  return {
    address,
    symbol: symbol || "TOKEN",
    name: name || symbol || "Token",
    decimals: chain.decimals,
    logo: browserLogoUrl(logo) || logo,
    description,
    totalSupply: Number.isFinite(totalSupply) ? totalSupply : null,
    socials,
  };
}

/**
 * Live market for /looting — RPC supply/burn + Pons on-chain indexed spot.
 * No Mobula / DexScreener (product Explore uses the same Pons path).
 */
export async function loadLootingLiveMarket(rawAddress: string): Promise<LootingLiveMarket | null> {
  const address = getAddress(rawAddress.trim()).toLowerCase();
  const token = getAddress(address) as Address;
  const chain = await readChainMeta(token);
  const totalSupply =
    chain.totalSupplyRaw != null ? Number(formatUnits(chain.totalSupplyRaw, chain.decimals)) : null;
  const burnedOnChain = await readBurned(token, chain.decimals);

  const [pons, trades] = await Promise.all([fetchPonsTokenDetail(address), fetchPonsTrades(address)]);

  let burned = burnedOnChain;
  if ((burned == null || burned === 0) && pons?.burnedRaw != null) {
    try {
      burned = Number(formatUnits(BigInt(String(pons.burnedRaw)), chain.decimals));
    } catch {
      burned = num(pons.burnedRaw) ?? burned;
    }
  }

  let circulating: number | null =
    totalSupply != null && burned != null ? Math.max(0, totalSupply - burned) : totalSupply;
  if (pons?.circulatingSupply != null) {
    const circ = num(pons.circulatingSupply);
    if (circ != null) circulating = circ;
  }

  const priceUsd = num(pons?.priceUsd) ?? null;
  const marketCap =
    num(pons?.mcapUsd) ??
    (priceUsd != null && circulating != null ? priceUsd * circulating : null);
  let fdv = num(pons?.fdvUsd) ?? null;
  if (fdv == null && priceUsd != null && totalSupply != null) fdv = priceUsd * totalSupply;
  if (fdv == null && marketCap != null) fdv = marketCap;

  const fromTrades = tradesToVolumeAndChange(trades);
  let volume24h = fromTrades.volume24h > 0 ? fromTrades.volume24h : null;
  let change24h = fromTrades.change24h;

  // Liquidity: graduated pool balances on-chain, else curve realQuote × ETH/USD.
  let liquidity: number | null = null;
  if (pons?.pool) {
    const [liq, vol] = await Promise.all([
      readPoolLiquidityUsd(pons.pool, address, priceUsd),
      volume24h == null
        ? readPoolVolume24h(pons.pool, address, priceUsd)
        : Promise.resolve({ volumeUsd: volume24h, change24h }),
    ]);
    liquidity = liq;
    if (volume24h == null && vol.volumeUsd != null) volume24h = vol.volumeUsd;
    if (change24h == null && vol.change24h != null) change24h = vol.change24h;
  }
  if (liquidity == null) {
    const realQuote = num(pons?.reserves?.realQuote) ?? num(pons?.reserves?.quote) ?? num(pons?.pairedPrincipalEth);
    const priceEth = num(pons?.priceEth);
    if (realQuote != null && realQuote > 0 && priceUsd != null && priceEth != null && priceEth > 0) {
      const ethUsd = priceUsd / priceEth;
      if (Number.isFinite(ethUsd) && ethUsd > 0) liquidity = realQuote * ethUsd;
    } else if (realQuote != null && realQuote > 0) {
      liquidity = realQuote;
    }
  }

  const burnedUsd =
    priceUsd != null && burned != null && Number.isFinite(burned) ? priceUsd * burned : null;

  let holders = holdersFromPons(pons);
  if (holders == null && pons?.curve) {
    const startBlock = await resolveHistoryStartBlock(pons);
    if (startBlock != null && startBlock > 0n) {
      holders = await countCurveHolders(pons.curve, startBlock);
    }
  }

  return {
    priceUsd,
    marketCap,
    fdv,
    volume24h,
    liquidity,
    change24h,
    holders,
    circulating,
    totalSupply: Number.isFinite(totalSupply) ? totalSupply : null,
    burned,
    burnedUsd,
    asOf: new Date().toISOString(),
  };
}

/** OHLCV for /looting — curve fills + pool slot0 from launch→now. */
export async function loadLootingCandles(
  rawAddress: string,
  priceUsd?: number | null,
): Promise<LootingCandle[]> {
  const address = getAddress(rawAddress.trim()).toLowerCase();
  const pons = await fetchPonsTokenDetail(address);
  const pool = pons?.pool?.trim();
  const curve = pons?.curve?.trim();
  const startBlock = await resolveHistoryStartBlock(pons);
  const ethUsd = await getEthUsd();
  const chain = await readChainMeta(getAddress(address) as Address);

  let curveCandles: LootingCandle[] = [];
  let poolCandles: LootingCandle[] = [];

  if (curve && startBlock != null && startBlock > 0n) {
    try {
      curveCandles = await sampleCurveHistoryCandles({
        curve,
        launchBlock: startBlock,
        quoteSymbol: pons?.quoteSymbol,
        tokenDecimals: chain.decimals,
        ethUsd,
      });
    } catch {
      curveCandles = [];
    }
  }

  if (pool && startBlock != null && startBlock > 0n) {
    try {
      poolCandles = await samplePoolHistoryCandles({
        pool,
        token: address,
        launchBlock: startBlock,
        spotUsd: priceUsd,
      });
    } catch {
      poolCandles = [];
    }
  }

  const merged = mergeCandles(curveCandles, poolCandles);
  if (merged.length > 0) {
    if (priceUsd != null && priceUsd > 0) {
      const last = merged[merged.length - 1]!;
      last.c = priceUsd;
      last.h = Math.max(last.h, priceUsd);
      last.l = Math.min(last.l, priceUsd);
      last.t = Math.max(last.t, Date.now());
    }
    liveCandleBuf.set(address, merged);
    return merged;
  }

  const trades = await fetchPonsTrades(address);
  const fromTrades = tradesToCandles(trades);
  if (fromTrades.length > 0) {
    const spot = priceUsd != null && priceUsd > 0 ? priceUsd : fromTrades[fromTrades.length - 1]?.c;
    if (spot != null && spot > 0) {
      const merged = [...fromTrades];
      const last = merged[merged.length - 1];
      if (last) {
        last.c = spot;
        last.h = Math.max(last.h, spot);
        last.l = Math.min(last.l, spot);
      }
      liveCandleBuf.set(address, merged);
      return merged;
    }
    return fromTrades;
  }

  const spot = priceUsd != null && priceUsd > 0 ? priceUsd : null;
  if (spot != null) return pushLiveCandle(address, spot);
  return liveCandleBuf.get(address) ?? [];
}
