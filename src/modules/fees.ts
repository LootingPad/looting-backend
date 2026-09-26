import type { FastifyInstance } from "fastify";
import { FE_FEES } from "../lib/fe-shape.js";

export async function registerFeeRoutes(app: FastifyInstance) {
  app.get("/api/fees", async () => ({ data: FE_FEES }));
}
