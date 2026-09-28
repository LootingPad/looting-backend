import type { TrenchPair } from "@prisma/client";
import websocket from "@fastify/websocket";
import type { Address } from "viem";
import type { FastifyInstance } from "fastify";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { tokenAbi } from "../pons-adapter/abi.js";
import { addTrenchClient, addTrenchPhaseClient, rememberPair } from "../pons-adapter/hub.js";
import { loadTokenImage } from "../pons-adapter/images.js";
import { readTrenchPairs, readTrenchTokenDetail, toStoredPair, type TrenchPairResponse } from "../pons-adapter/live.js";
import { toBoardPair } from "../pons-adapter/stages.js";

const liveCache = new Map<string, { at: number; pairs: TrenchPairResponse[] }>();
const detailCache = new Map<string, { at: number; body: Awaited<ReturnType<typeof readTrenchTokenDetail>> }>();
const detailFlight = new Map<string, Promise<void>>();

function tokenList(raw: unknown, max: number): string[] {
  const values = String(raw ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => /^0x[0-9a-f]{40}$/.test(token));
  return [...new Set(values)].slice(0, max);
}

async function refreshLogos(rows: TrenchPair[]): Promise<void> {
  if (rows.length === 0) return;
  const client = getPublicClient();
  const results = await client.multicall({
    allowFailure: true,
    contracts: rows.map((row) => ({
      address: row.token as Address,
      abi: tokenAbi,
      functionName: "getTokenInfo" as const,
    })),
  });
  await Promise.all(
    rows.map(async (row, index) => {
      const result = results[index];
      if (!result || result.status !== "success") return;
      const info = result.result as readonly [Address, string, string, unknown];
      const logo = (info[1] ?? "").trim();
      if (!logo || logo === row.logo) return;
      row.logo = logo;
      await prisma.trenchPair.update({ where: { id: row.id }, data: { logo } });
    }),
  );
}

function snapshotLimit(raw: unknown): number {
  const value = Number(raw ?? "20");
  return Number.isFinite(value) ? Math.min(50, Math.max(1, Math.trunc(value))) : 20;
}

export async function registerTrenchRoutes(app: FastifyInstance) {
  await app.register(websocket);

  app.get("/trenches/image/:token", async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) return reply.code(400).send();
    const image = await loadTokenImage(token);
    if (!image) return reply.code(404).send();
    return reply
      .header("cache-control", "public, max-age=600")
      .type(image.type)
      .send(image.body);
  });

  app.get("/trenches/token/:token", async (req, reply) => {
    const token = String((req.params as { token?: string }).token ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) return reply.code(400).send({ error: "BAD_TOKEN" });
    const row = await prisma.trenchPair.findFirst({
      where: { chainId: env.CHAIN_ID, token },
    });
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    const cached = detailCache.get(token);
    const fresh = cached != null && Date.now() - cached.at < 2_000;
    if (!fresh && !detailFlight.has(token)) {
      const job = (async () => {
        try {
          await refreshLogos([row]);
          const detail = await readTrenchTokenDetail(row);
          await rememberPair(row, detail.pair);
          detailCache.set(token, { at: Date.now(), body: detail });
        } catch {
          /* the next poll retries; a failed chain read must not reset the HTTP socket */
        }
      })().finally(() => detailFlight.delete(token));
      detailFlight.set(token, job);
    }

    if (cached) return cached.body;
    return { pair: toBoardPair(row), holders: [], trades: [], candles: [], ticks: [] };
  });

  app.get("/trenches/live", async (req) => {
    const tokens = tokenList((req.query as { tokens?: string }).tokens, 14);
    if (tokens.length === 0) return { pairs: [] };
    const key = tokens.slice().sort().join(",");
    const hit = liveCache.get(key);
    if (hit && Date.now() - hit.at < 2_000) return { pairs: hit.pairs };

    try {
      const found = await prisma.trenchPair.findMany({
        where: { chainId: env.CHAIN_ID, token: { in: tokens } },
      });
      const byToken = new Map(found.map((row) => [row.token, row]));
      const rows = tokens.map((token) => byToken.get(token)).filter((row): row is TrenchPair => Boolean(row));
      await refreshLogos(rows);
      const pairs = await readTrenchPairs(rows, { deadline: Date.now() + 3_000 });
      const priced = new Map(pairs.map((pair) => [pair.token, pair]));
      await Promise.all(
        rows.map(async (row) => {
          const pair = priced.get(row.token);
          if (pair) await rememberPair(row, pair);
        }),
      );
      const ordered = tokens.map((token) => priced.get(token)).filter((pair): pair is TrenchPairResponse => Boolean(pair));
      liveCache.set(key, { at: Date.now(), pairs: ordered });
      return { pairs: ordered };
    } catch {
      return hit ? { pairs: hit.pairs } : { pairs: [] };
    }
  });

  app.get("/trenches-new-pairs", { websocket: true }, async (socket, req) => {
    const limit = snapshotLimit((req.query as { limit?: string }).limit);
    const rows = await prisma.trenchPair.findMany({
      where: { chainId: env.CHAIN_ID },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: limit,
    });
    socket.send(JSON.stringify({ type: "snapshot", pairs: rows.map(toStoredPair) }));
    addTrenchClient(socket);
  });

  app.get("/trenches", { websocket: true }, async (socket, req) => {
    const limit = snapshotLimit((req.query as { limit?: string }).limit);
    const where = { chainId: env.CHAIN_ID };
    const [fresh, almost, migrated] = await Promise.all([
      prisma.trenchPair.findMany({
        where: { ...where, stage: "new" },
        orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
        take: limit,
      }),
      prisma.trenchPair.findMany({
        where: { ...where, stage: "almost" },
        orderBy: [{ bondingPercentage: "desc" }, { stageChangedAt: "desc" }],
        take: limit,
      }),
      prisma.trenchPair.findMany({
        where: { ...where, stage: "migrated" },
        orderBy: [{ stageChangedAt: "desc" }],
        take: limit,
      }),
    ]);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        phases: {
          new: fresh.map(toBoardPair),
          "almost migrated": almost.map(toBoardPair),
          migrated: migrated.map(toBoardPair),
        },
      }),
    );
    addTrenchPhaseClient(socket);
  });
}
