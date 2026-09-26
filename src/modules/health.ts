import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "UNAUTHORIZED" });
    return false;
  }
  const token = header.slice("Bearer ".length);
  if (token !== env.ADMIN_API_TOKEN) {
    reply.code(403).send({ error: "FORBIDDEN" });
    return false;
  }
  return true;
}

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true, chainId: env.CHAIN_ID }));
}
