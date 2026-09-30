import { env } from "../config/env.js";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { ingestCurveLog, loadCurveTokenMap } from "../services/trade-rewards.js";
import { getCheckpoint, setCheckpoint } from "./checkpoint.js";
import { handleLog, watchedAddresses } from "./decoders.js";

const CHECKPOINT_NAME = "looting_contracts";
const TRADE_CHECKPOINT = "pons_curve_trades";

async function processRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
  const client = getPublicClient();
  const addresses = watchedAddresses();

  const vaults = await prisma.stakingVault.findMany({
    where: { chainId: env.CHAIN_ID },
    select: { vaultAddress: true },
  });
  for (const v of vaults) {
    addresses.push(v.vaultAddress as `0x${string}`);
  }

  if (addresses.length === 0) {
    console.log("[indexer] no contract addresses configured; sleeping");
  } else {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))] as `0x${string}`[];

    const logs = await client.getLogs({
      address: unique,
      fromBlock,
      toBlock,
    });

    const blockTimes = new Map<string, Date>();
    for (const log of logs) {
      if (log.blockNumber == null) continue;
      const key = log.blockNumber.toString();
      if (!blockTimes.has(key)) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        blockTimes.set(key, new Date(Number(block.timestamp) * 1000));
      }
      await handleLog(log, blockTimes.get(key)!);
    }
  }

  if (env.ENABLE_TRADE_INDEXING) {
    const curveMap = await loadCurveTokenMap();
    const curves = [...curveMap.keys()] as `0x${string}`[];
    if (curves.length > 0) {
      const logs = await client.getLogs({
        address: curves,
        fromBlock,
        toBlock,
      });
      const blockTimes = new Map<string, Date>();
      let minted = 0;
      let unlocked = 0;
      for (const log of logs) {
        if (log.blockNumber == null) continue;
        const key = log.blockNumber.toString();
        if (!blockTimes.has(key)) {
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          blockTimes.set(key, new Date(Number(block.timestamp) * 1000));
        }
        const ingested = await ingestCurveLog(log, blockTimes.get(key)!, curveMap);
        if (ingested?.boxId) minted += 1;
        if (ingested?.unlocked) unlocked += ingested.unlocked;
      }
      if (logs.length > 0) {
        console.log(
          `[indexer] curve trades logs=${logs.length} boxesMinted=${minted} unlocked=${unlocked}`,
        );
      }
    }
  }

  const tip = await client.getBlock({ blockNumber: toBlock });
  await setCheckpoint(CHECKPOINT_NAME, toBlock, tip.hash);
  if (env.ENABLE_TRADE_INDEXING) {
    await setCheckpoint(TRADE_CHECKPOINT, toBlock, tip.hash);
  }
  console.log(`[indexer] advanced checkpoint to ${toBlock}`);
}

async function tick(): Promise<void> {
  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const safeTip =
    latest > BigInt(env.INDEXER_CONFIRMATIONS)
      ? latest - BigInt(env.INDEXER_CONFIRMATIONS)
      : 0n;

  const checkpoint = await getCheckpoint(CHECKPOINT_NAME);
  let from = checkpoint ? checkpoint.blockNumber + 1n : BigInt(env.INDEXER_START_BLOCK);

  if (checkpoint) {
    try {
      const block = await client.getBlock({ blockNumber: checkpoint.blockNumber });
      if (block.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
        console.warn(
          `[indexer] reorg detected at ${checkpoint.blockNumber}; rolling back 64 blocks`,
        );
        const rollback =
          checkpoint.blockNumber > 64n ? checkpoint.blockNumber - 64n : 0n;
        await prisma.trade.updateMany({
          where: {
            chainId: env.CHAIN_ID,
            blockNumber: { gte: rollback },
            confirmationState: { in: ["PENDING", "CONFIRMED", "FINALIZED"] },
          },
          data: { confirmationState: "REORGED" },
        });
        const parent = await client.getBlock({ blockNumber: rollback });
        await setCheckpoint(CHECKPOINT_NAME, rollback, parent.hash);
        from = rollback + 1n;
      }
    } catch (err) {
      console.warn("[indexer] reorg check failed", err);
    }
  }

  if (from > safeTip) return;

  const maxSpan = 99n;
  const to = from + maxSpan > safeTip ? safeTip : from + maxSpan;
  await processRange(from, to);
}

async function main() {
  if (!env.INDEXER_ENABLED) {
    console.log("[indexer] INDEXER_ENABLED=false; exiting");
    return;
  }

  console.log(`[indexer] starting on chain ${env.CHAIN_ID}`);
  console.log(`[indexer] rpc=${env.RPC_HTTP_URL}`);
  console.log(`[indexer] tradeIndexing=${env.ENABLE_TRADE_INDEXING}`);

  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[indexer] tick error", err);
    }
    await new Promise((r) => setTimeout(r, env.INDEXER_POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
