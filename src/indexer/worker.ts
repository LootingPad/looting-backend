import { env } from "../config/env.js";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { getCheckpoint, setCheckpoint } from "./checkpoint.js";
import { handleLog, watchedAddresses } from "./decoders.js";

const CHECKPOINT_NAME = "looting_contracts";

async function processRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
  const client = getPublicClient();
  const addresses = watchedAddresses();

  // Also watch known vault clones
  const vaults = await prisma.stakingVault.findMany({
    where: { chainId: env.CHAIN_ID },
    select: { vaultAddress: true },
  });
  for (const v of vaults) {
    addresses.push(v.vaultAddress as `0x${string}`);
  }

  if (addresses.length === 0) {
    console.log("[indexer] no contract addresses configured; sleeping");
    return;
  }

  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))] as `0x${string}`[];

  const logs = await client.getLogs({
    address: unique,
    fromBlock,
    toBlock,
  });

  // Group timestamps by block
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

  if (env.ENABLE_TRADE_INDEXING) {
    // Pons / Uniswap V4 trade decoding lands in Sprint 2 once ABIs are confirmed.
    console.log("[indexer] trade indexing enabled but decoder not yet configured");
  }

  const tip = await client.getBlock({ blockNumber: toBlock });
  await setCheckpoint(CHECKPOINT_NAME, toBlock, tip.hash);
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
    // Lightweight reorg check: if stored hash no longer matches, roll back.
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

  // Cap batch size to avoid RPC payload limits
  const maxSpan = 2_000n;
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
