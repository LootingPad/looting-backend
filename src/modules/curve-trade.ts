import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { prepareCurveTrade, TradePrepareError } from "../pons-adapter/trade.js";
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
}
