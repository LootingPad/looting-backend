import type { TrenchPair } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { readTrenchPairs, toStoredPair, type TrenchPairResponse } from "./live.js";

type TrenchSocket = {
  OPEN: number;
  readyState: number;
  send: (data: string) => void;
  on: (event: "close" | "error", listener: () => void) => void;
};

const clients = new Set<TrenchSocket>();
const phaseClients = new Set<TrenchSocket>();

function track(set: Set<TrenchSocket>, socket: TrenchSocket): void {
  set.add(socket);
  const drop = () => {
    clients.delete(socket);
    phaseClients.delete(socket);
  };
  socket.on("close", drop);
  socket.on("error", drop);
}

export function addTrenchClient(socket: TrenchSocket): void {
  track(clients, socket);
}

export function addTrenchPhaseClient(socket: TrenchSocket): void {
  track(phaseClients, socket);
}

function sendAll(set: Set<TrenchSocket>, payload: string): void {
  for (const socket of set) {
    if (socket.readyState !== socket.OPEN) {
      set.delete(socket);
      continue;
    }
    try {
      socket.send(payload);
    } catch {
      set.delete(socket);
    }
  }
}

export async function rememberPair(row: TrenchPair, pair: TrenchPairResponse): Promise<void> {
  await prisma.trenchPair.update({
    where: { id: row.id },
    data: {
      mcap: pair.mcap,
      athMcap: pair.athMcap,
      volume: pair.volume,
      taxPercent: pair.taxPercent,
      creatorTaxBps: pair.creatorTaxBps,
      txns: pair.txns,
      holders: pair.holders,
      bundlers: pair.bundlers,
      bondingPercentage: Math.round(pair.bondingPercentage),
      chainPhase: pair.phase,
    },
  });
}

/** One chain read for this new token, saved once, then fanned out to open clients. */
export async function publishTrenchPair(row: TrenchPair): Promise<void> {
  let pair: TrenchPairResponse;
  try {
    const [enriched] = await readTrenchPairs([row]);
    pair = enriched ?? toStoredPair(row);
  } catch (err) {
    console.warn("[trenches] live read failed, sending stored pair", err);
    pair = toStoredPair(row);
  }
  try {
    await rememberPair(row, pair);
  } catch (err) {
    console.warn("[trenches] display save failed", err);
  }
  if (clients.size === 0 && phaseClients.size === 0) return;
  const body = JSON.stringify({ type: "pair", pair });
  sendAll(clients, body);
  sendAll(phaseClients, JSON.stringify({ type: "pair", phase: "new", pair }));
}

/** Stage change only. The pair was already priced by the indexer multicall. */
export function publishTrenchStage(
  phase: "new" | "almost migrated" | "migrated",
  from: "new" | "almost migrated" | "migrated",
  pair: TrenchPairResponse,
): void {
  if (phaseClients.size === 0) return;
  sendAll(phaseClients, JSON.stringify({ type: "pair", phase, from, pair }));
}
