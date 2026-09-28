import type { Address } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { getCheckpoint, setCheckpoint } from "../indexer/checkpoint.js";
import { factoryAbi, tokenAbi, tokenLaunchedEvent } from "./abi.js";
import { publishTrenchPair } from "./hub.js";
import { classifyRecent, syncTradedCurves, watchAlmost } from "./stages.js";

const CHECKPOINT = "pons_v2_trenches";
const factory = env.PONS_V2_FACTORY as Address;

type Draft = {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  txHash: string;
  blockNumber: bigint;
  logIndex: number;
  launchedAt: Date;
};

function lower(value: string): string {
  return value.toLowerCase();
}

async function hydrate(drafts: Draft[]): Promise<void> {
  if (drafts.length === 0) return;
  const size = 6;
  for (let offset = 0; offset < drafts.length; offset += size) {
    await hydrateGroup(drafts.slice(offset, offset + size));
  }
}

async function hydrateGroup(drafts: Draft[]): Promise<void> {
  const client = getPublicClient();
  const results = await client.multicall({
    allowFailure: false,
    contracts: drafts.flatMap((draft) => [
      { address: draft.token, abi: tokenAbi, functionName: "name" as const },
      { address: draft.token, abi: tokenAbi, functionName: "symbol" as const },
      { address: draft.token, abi: tokenAbi, functionName: "decimals" as const },
      { address: draft.token, abi: tokenAbi, functionName: "totalSupply" as const },
      { address: draft.token, abi: tokenAbi, functionName: "getTokenInfo" as const },
      {
        address: factory,
        abi: factoryAbi,
        functionName: "getLaunchedToken" as const,
        args: [draft.token] as const,
      },
    ]),
  });

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const base = index * 6;
    const name = results[base] as string;
    const symbol = results[base + 1] as string;
    const decimals = results[base + 2] as number;
    const totalSupply = results[base + 3] as bigint;
    const info = results[base + 4] as readonly [
      Address,
      string,
      string,
      { twitter: string; telegram: string; discord: string; website: string; farcaster: string },
    ];
    const launched = results[base + 5] as {
      deployer: Address;
      curve: Address;
      pairToken: Address;
      phase: number;
    };
    const socials = info[3];
    const token = lower(draft.token);
    const existing = await prisma.trenchPair.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      select: { id: true },
    });

    await prisma.trenchPair.upsert({
      where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      create: {
        chainId: env.CHAIN_ID,
        token: lower(draft.token),
        name,
        symbol,
        decimals,
        totalSupply: totalSupply.toString(),
        logo: info[1],
        description: info[2],
        twitter: socials.twitter,
        telegram: socials.telegram,
        discord: socials.discord,
        website: socials.website,
        farcaster: socials.farcaster,
        deployer: lower(launched.deployer || draft.deployer),
        curve: lower(launched.curve || draft.curve),
        pairToken: lower(launched.pairToken || draft.pairToken),
        launchConfigId: draft.launchConfigId.toString(),
        txHash: lower(draft.txHash),
        blockNumber: draft.blockNumber,
        logIndex: draft.logIndex,
        launchedAt: draft.launchedAt,
      },
      update: {
        name,
        symbol,
        decimals,
        totalSupply: totalSupply.toString(),
        logo: info[1],
        description: info[2],
        twitter: socials.twitter,
        telegram: socials.telegram,
        discord: socials.discord,
        website: socials.website,
        farcaster: socials.farcaster,
        deployer: lower(launched.deployer || draft.deployer),
        curve: lower(launched.curve || draft.curve),
        pairToken: lower(launched.pairToken || draft.pairToken),
        launchConfigId: draft.launchConfigId.toString(),
      },
    });

    if (!existing) {
      const row = await prisma.trenchPair.findUnique({
        where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      });
      if (row) await publishTrenchPair(row);
    }
  }
}

async function processRange(fromBlock: bigint, toBlock: bigint, headTime: Date): Promise<void> {
  const client = getPublicClient();
  const logs = await client.getLogs({
    address: factory,
    event: tokenLaunchedEvent,
    fromBlock,
    toBlock,
  });
  const blockTimes = new Map<string, Date>();
  const drafts: Draft[] = [];

  for (const log of logs) {
    const args = log.args;
    if (
      log.blockNumber == null ||
      log.transactionHash == null ||
      log.logIndex == null ||
      !args.token ||
      !args.curve ||
      !args.deployer ||
      args.pairToken == null ||
      args.launchConfigId == null
    ) {
      continue;
    }
    const key = log.blockNumber.toString();
    let launchedAt = blockTimes.get(key);
    if (!launchedAt) {
      if (log.blockNumber === toBlock) launchedAt = headTime;
      else {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        launchedAt = new Date(Number(block.timestamp) * 1000);
      }
      blockTimes.set(key, launchedAt);
    }
    drafts.push({
      token: args.token,
      curve: args.curve,
      deployer: args.deployer,
      pairToken: args.pairToken,
      launchConfigId: args.launchConfigId,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      launchedAt,
    });
  }

  if (drafts.length > 0) {
    await hydrate(drafts);
    console.log(`[trenches] stored ${drafts.length} new pair(s) in ${fromBlock}-${toBlock}`);
  }

  await syncTradedCurves(fromBlock, toBlock);

  const tip = await client.getBlock({ blockNumber: toBlock });
  await setCheckpoint(CHECKPOINT, toBlock, tip.hash);
}

async function tick(): Promise<boolean> {
  const client = getPublicClient();
  const head = await client.getBlock({ blockTag: "latest" });
  if (head.number == null) return true;
  const confirmations = BigInt(env.TRENCH_CONFIRMATIONS);
  const safeTip = head.number > confirmations ? head.number - confirmations : 0n;
  const saved = await getCheckpoint(CHECKPOINT);

  let from: bigint;
  if (!saved) {
    const lookback = 200n;
    from = safeTip > lookback ? safeTip - lookback : 0n;
    console.log(`[trenches] follow tip from ${from}`);
  } else if (safeTip > saved.blockNumber + 2_000n) {
    from = safeTip > 200n ? safeTip - 200n : 0n;
    console.log(`[trenches] checkpoint far behind; resume at ${from}`);
  } else {
    from = saved.blockNumber + 1n;
  }

  if (from > safeTip) return true;
  const span = BigInt(env.TRENCH_LOG_CHUNK);
  const to = from + span > safeTip ? safeTip : from + span;
  await processRange(from, to, new Date(Number(head.timestamp) * 1000));
  return to >= safeTip;
}

export function startTrenchIndexer(): void {
  console.log(`[trenches] factory ${factory} on chain ${env.CHAIN_ID}`);
  void (async () => {
    try {
      await classifyRecent();
    } catch (err) {
      console.warn("[trenches] classify recent failed", err);
    }
    for (;;) {
      let caughtUp = true;
      try {
        caughtUp = await tick();
      } catch (err) {
        console.error("[trenches] tick error", err);
      }
      if (caughtUp) {
        try {
          await watchAlmost();
        } catch (err) {
          console.warn("[trenches] almost watch failed", err);
        }
        await new Promise((resolve) => setTimeout(resolve, env.TRENCH_POLL_MS));
      }
    }
  })();
}
