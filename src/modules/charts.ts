import type { FastifyInstance } from "fastify";
import { getTokenMetadata, getTokenOhlcv, MobulaError } from "../clients/mobula.js";
import { normalizeAddress } from "../lib/utils.js";

export async function registerChartRoutes(app: FastifyInstance) {
  app.get("/api/charts/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const q = req.query as { period?: string; from?: string; to?: string; amount?: string };

    let address: string;
    try {
      address = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    try {
      const data = await getTokenOhlcv({
        address,
        period: q.period ?? "1h",
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        amount: q.amount ? Number(q.amount) : 200,
      });
      return { data: data.data ?? data };
    } catch (err) {
      const status = err instanceof MobulaError && err.status < 500 ? err.status : 502;
      return reply.code(status).send({
        error: status === 404 ? "NOT_FOUND" : "MOBULA_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function registerMetadataRoutes(app: FastifyInstance) {
  app.get("/api/metadata/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    let address: string;
    try {
      address = normalizeAddress(token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    try {
      const data = await getTokenMetadata(address);
      return { data };
    } catch (err) {
      const status = err instanceof MobulaError && err.status < 500 ? err.status : 502;
      return reply.code(status).send({
        error: status === 404 || status === 400 ? "NOT_FOUND" : "MOBULA_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
