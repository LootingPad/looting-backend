import type { FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { prepareCurveTrade, TradePrepareError } from "../pons-adapter/trade.js";
import { ingestTradesFromReceipt } from "../services/trade-rewards.js";
import { normalizeAddress } from "../lib/utils.js";

export async function registerCurveTradeRoutes(app: FastifyInstance) {
  app.post("/api/trade/prepare", async (req, reply) => {
    const body = req.body as {
      token?: string;
      side?: string;
      amount?: string;
      wallet?: string;
      slippageBps?: number;
    };

    if (body.side !== "buy" && body.side !== "sell") {
      return reply.code(400).send({ error: "INVALID_SIDE", message: "Side must be buy or sell." });
    }

    let wallet: string;
    let token: string;
    try {
      wallet = normalizeAddress(body.wallet ?? "");
      token = normalizeAddress(body.token ?? "");
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS", message: "Connect a wallet first." });
    }

    try {
      const prepared = await prepareCurveTrade({
        token,
        side: body.side,
        amount: String(body.amount ?? ""),
        wallet: wallet as Address,
        slippageBps: Number(body.slippageBps ?? 1000),
      });
      return { data: prepared };
    } catch (err) {
      if (err instanceof TradePrepareError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /** After wallet broadcast — index CurveBuy/Sell, award XP, mint/unlock Lucky Boxes. */
  app.post("/api/trade/confirm", async (req, reply) => {
    const body = req.body as { token?: string; wallet?: string; txHash?: string };
    let wallet: string;
    let token: string;
    try {
      wallet = normalizeAddress(body.wallet ?? "");
      token = normalizeAddress(body.token ?? "");
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }
    const txHash = String(body.txHash ?? "").toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) {
      return reply.code(400).send({ error: "INVALID_TX", message: "txHash is required." });
    }

    const client = getPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED", message: "Trade transaction reverted." });
    }

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const ingested = await ingestTradesFromReceipt({
      token,
      wallet,
      txHash: txHash as Hex,
      receipt,
      timestamp: new Date(Number(block.timestamp) * 1000),
    });

    return {
      data: {
        status: "confirmed",
        txHash,
        trades: ingested.length,
        boxesMinted: ingested.filter((t) => t.boxId).length,
        boxesUnlocked: ingested.reduce((sum, t) => sum + (t.unlocked ?? 0), 0),
        items: ingested,
      },
    };
  });
}
