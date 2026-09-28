import type { TrenchPair } from "@prisma/client";
import type { Address } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { curveAbi, curveBuyEvent, curveSellEvent, factoryAbi, phaseName } from "./abi.js";
import { publishTrenchStage, rememberPair } from "./hub.js";
import {
  asReserves,
  bonding,
  formatAmount,
  readTrenchPairs,
  toStoredPair,
  type TrenchPairResponse,
} from "./live.js";

/** Still on the curve, but close enough to graduation to leave the new board. */
const ALMOST_BONDING = 15;
const ZERO = "0x0000000000000000000000000000000000000000";

export type TrenchBoard = "new" | "almost" | "migrated";

export function boardLabel(board: string): "new" | "almost migrated" | "migrated" {
  if (board === "almost") return "almost migrated";
  if (board === "migrated") return "migrated";
  return "new";
}

export function classifyBoard(phase: string, bondingPercentage: number): TrenchBoard {
  if (phase === "PoolCreated" || phase === "Swept") return "migrated";
  if (bondingPercentage >= ALMOST_BONDING) return "almost";
  return "new";
}

export function toBoardPair(row: TrenchPair): TrenchPairResponse {
  return {
    ...toStoredPair(row),
    phase: row.chainPhase,
    bondingPercentage: row.bondingPercentage,
    creatorTaxBps: row.creatorTaxBps,
    taxPercent: row.taxPercent,
    mcap: row.mcap,
    athMcap: row.athMcap,
    txns: row.txns,
    volume: row.volume,
    bundlers: row.bundlers,
    holders: row.holders,
  };
}

type Market = {
  phase: string;
  bondingPercentage: number;
  graduationThreshold: string;
  creatorFeeRecipient: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  taxPercent: number;
  mcap: string;
};

function paint(row: TrenchPair, market: Market): TrenchPairResponse {
  return {
    ...toStoredPair(row),
    phase: market.phase,
    bondingPercentage: market.bondingPercentage,
    graduationThreshold: market.graduationThreshold,
    creatorFeeRecipient: market.creatorFeeRecipient,
    creatorTaxBps: market.creatorTaxBps,
    buybackEnabled: market.buybackEnabled,
    taxPercent: market.taxPercent,
    mcap: market.mcap,
    athMcap: market.mcap,
  };
}

async function readMarkets(rows: TrenchPair[]): Promise<Map<string, Market>> {
  const markets = new Map<string, Market>();
  if (rows.length === 0) return markets;
  const client = getPublicClient();
  const factory = env.PONS_V2_FACTORY as Address;

  for (let offset = 0; offset < rows.length; offset += 20) {
    const slice = rows.slice(offset, offset + 20);
    const results = await client.multicall({
      allowFailure: true,
      contracts: slice.flatMap((row) => {
        const curve = row.curve as Address;
        return [
          {
            address: factory,
            abi: factoryAbi,
            functionName: "getLaunchedToken" as const,
            args: [row.token as Address] as const,
          },
          { address: curve, abi: curveAbi, functionName: "feeBps" as const },
          { address: curve, abi: curveAbi, functionName: "creatorTaxBps" as const },
          { address: curve, abi: curveAbi, functionName: "getReserves" as const },
          { address: curve, abi: curveAbi, functionName: "realQuoteReserve" as const },
          { address: curve, abi: curveAbi, functionName: "graduationThreshold" as const },
        ];
      }),
    });

    slice.forEach((row, index) => {
      const base = index * 6;
      const launched = results[base];
      const fee = results[base + 1];
      const creator = results[base + 2];
      const reserves = results[base + 3];
      const raised = results[base + 4];
      const threshold = results[base + 5];

      let phase = row.chainPhase;
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

      const thresholdRaw =
        threshold?.status === "success" ? (threshold.result as bigint) : BigInt(graduationThreshold || "0");
      const raisedRaw = raised?.status === "success" ? (raised.result as bigint) : 0n;
      const bondingPercentage = bonding(raisedRaw, thresholdRaw, phase);
      const feeBps = fee?.status === "success" ? Number(fee.result) : 0;
      const curveTaxBps = creator?.status === "success" ? Number(creator.result) : creatorTaxBps;
      const quoteDecimals = row.pairToken === ZERO ? 18 : 18;
      let mcapRaw = 0n;
      if (reserves?.status === "success") {
        const [quoteReserve, tokenReserve] = asReserves(reserves.result);
        const supply = BigInt(row.totalSupply);
        if (tokenReserve > 0n && supply > 0n) mcapRaw = (quoteReserve * supply) / tokenReserve;
      }

      markets.set(row.token, {
        phase,
        bondingPercentage,
        graduationThreshold: thresholdRaw.toString(),
        creatorFeeRecipient,
        creatorTaxBps,
        buybackEnabled,
        taxPercent: (feeBps + curveTaxBps) / 100,
        mcap: formatAmount(mcapRaw, quoteDecimals),
      });
    });
  }

  return markets;
}

async function applyMarkets(rows: TrenchPair[], broadcast: boolean): Promise<void> {
  const markets = await readMarkets(rows);
  for (const row of rows) {
    if (row.stage === "migrated") continue;
    const market = markets.get(row.token);
    if (!market) continue;
    const bondingPercentage = Math.round(market.bondingPercentage);
    const next = classifyBoard(market.phase, market.bondingPercentage);
    const changed = next !== row.stage;
    if (
      !changed &&
      bondingPercentage === row.bondingPercentage &&
      market.phase === row.chainPhase &&
      market.mcap === row.mcap &&
      market.creatorTaxBps === row.creatorTaxBps
    ) {
      continue;
    }
    await prisma.trenchPair.update({
      where: { id: row.id },
      data: {
        stage: next,
        bondingPercentage,
        chainPhase: market.phase,
        mcap: market.mcap,
        athMcap: market.mcap,
        taxPercent: market.taxPercent,
        creatorTaxBps: market.creatorTaxBps,
        ...(changed ? { stageChangedAt: new Date() } : {}),
      },
    });
    if (broadcast && changed) {
      publishTrenchStage(boardLabel(next), boardLabel(row.stage), paint(row, market));
    }
  }
}

/** Curves that traded in this tip window. One multicall, no per-client reads. */
export async function syncTradedCurves(fromBlock: bigint, toBlock: bigint): Promise<void> {
  const client = getPublicClient();
  const [buys, sells] = await Promise.all([
    client.getLogs({ event: curveBuyEvent, fromBlock, toBlock }),
    client.getLogs({ event: curveSellEvent, fromBlock, toBlock }),
  ]);
  const curves = [
    ...new Set([...buys, ...sells].map((log) => log.address.toLowerCase())),
  ];
  if (curves.length === 0) return;
  const rows = await prisma.trenchPair.findMany({
    where: { chainId: env.CHAIN_ID, curve: { in: curves }, stage: { not: "migrated" } },
  });
  await applyMarkets(rows, true);
}

let lastAlmostCheck = 0;

/** Backup for a keeper sweep that emits no curve trade. At most once every 5s. */
export async function watchAlmost(): Promise<void> {
  const now = Date.now();
  if (now - lastAlmostCheck < 5_000) return;
  lastAlmostCheck = now;
  const rows = await prisma.trenchPair.findMany({
    where: { chainId: env.CHAIN_ID, stage: "almost" },
    orderBy: [{ bondingPercentage: "desc" }, { stageChangedAt: "desc" }],
    take: 20,
  });
  await applyMarkets(rows, true);
}

/** Fill the three boards from tokens already stored. Does not broadcast. */
export async function classifyRecent(): Promise<void> {
  const [recent, closest] = await Promise.all([
    prisma.trenchPair.findMany({
      where: { chainId: env.CHAIN_ID, stage: { not: "migrated" } },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: 120,
    }),
    prisma.trenchPair.findMany({
      where: { chainId: env.CHAIN_ID, stage: { not: "migrated" }, bondingPercentage: { gt: 0 } },
      orderBy: { bondingPercentage: "desc" },
      take: 40,
    }),
  ]);
  const rows = [...new Map([...recent, ...closest].map((row) => [row.id, row])).values()];
  await applyMarkets(rows, false);
  const newest = rows.slice(0, 8);
  try {
    const priced = await readTrenchPairs(newest);
    for (const pair of priced) {
      const row = newest.find((item) => item.token === pair.token);
      if (row) await rememberPair(row, pair);
    }
  } catch (err) {
    console.warn("[trenches] recent trade stats failed", err);
  }
  console.log(`[trenches] classified ${rows.length} recent pair(s) into new / almost migrated / migrated`);
}
