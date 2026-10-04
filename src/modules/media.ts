import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { pinImageToIpfs } from "../lib/ipfs.js";

const MAX_BYTES = 1_500_000;
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function publicApiBase(req: FastifyRequest): string {
  const configured = env.PUBLIC_API_BASE.trim().replace(/\/$/, "");
  if (configured && !isLocalOrigin(configured)) return configured;

  const protoHeader = req.headers["x-forwarded-proto"];
  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(",")[0]?.trim() || "http";
  const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader)?.split(",")[0]?.trim();
  if (host && !isLocalHost(host)) return `${proto === "http" ? "https" : proto}://${host}`;

  // Never write localhost into on-chain logos — terminals like GMGN can't fetch it.
  return "https://looting-backend-production.up.railway.app";
}

function isLocalHost(host: string) {
  const h = host.toLowerCase().split(":")[0]!;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h.endsWith(".local");
}

function isLocalOrigin(origin: string) {
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function parseDataUrl(raw: string): { contentType: string; bytes: Buffer } | null {
  const match = raw.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  if (!ALLOWED.has(contentType)) return null;
  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return { contentType: contentType === "image/jpg" ? "image/jpeg" : contentType, bytes };
  } catch {
    return null;
  }
}

function extFor(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("avif")) return "avif";
  return "png";
}

export async function registerMediaRoutes(app: FastifyInstance) {
  app.post("/api/media", async (req, reply) => {
    const body = (req.body ?? {}) as { dataUrl?: string; contentType?: string; base64?: string };
    let contentType = "";
    let bytes: Buffer | null = null;

    if (typeof body.dataUrl === "string" && body.dataUrl.startsWith("data:")) {
      const parsed = parseDataUrl(body.dataUrl);
      if (!parsed) {
        return reply.code(400).send({
          error: "INVALID_IMAGE",
          message: "Logo must be a PNG, JPEG, WebP, GIF, or AVIF under 1.5 MB.",
        });
      }
      contentType = parsed.contentType;
      bytes = parsed.bytes;
    } else if (typeof body.base64 === "string" && typeof body.contentType === "string") {
      contentType = body.contentType.trim().toLowerCase();
      if (!ALLOWED.has(contentType)) {
        return reply.code(400).send({ error: "INVALID_IMAGE", message: "Unsupported image type." });
      }
      try {
        bytes = Buffer.from(body.base64.replace(/\s+/g, ""), "base64");
      } catch {
        return reply.code(400).send({ error: "INVALID_IMAGE", message: "Invalid base64 image." });
      }
      if (!bytes.length || bytes.length > MAX_BYTES) {
        return reply.code(400).send({
          error: "INVALID_IMAGE",
          message: "Logo must be under 1.5 MB.",
        });
      }
      if (contentType === "image/jpg") contentType = "image/jpeg";
    } else {
      return reply.code(400).send({
        error: "INVALID_IMAGE",
        message: "Send { dataUrl } or { contentType, base64 }.",
      });
    }

    const row = await prisma.mediaAsset.create({
      data: {
        contentType,
        data: new Uint8Array(bytes!),
        byteLength: bytes!.length,
      },
    });

    const httpsUrl = `${publicApiBase(req)}/api/media/${row.id}`;

    // Prefer ipfs:// on-chain so Pons / GMGN / Axiom resolve the same public CID.
    let ipfsUri: string | undefined;
    let gatewayUrl: string | undefined;
    try {
      const pinned = await pinImageToIpfs(
        bytes!,
        contentType,
        `looting-${row.id}.${extFor(contentType)}`,
      );
      if (pinned) {
        ipfsUri = pinned.uri;
        gatewayUrl = pinned.gatewayUrl;
      }
    } catch (err) {
      req.log.warn({ err }, "ipfs pin failed — falling back to https media URL");
    }

    const url = ipfsUri || httpsUrl;
    return {
      data: {
        id: row.id,
        url,
        httpsUrl,
        ipfsUri: ipfsUri || null,
        gatewayUrl: gatewayUrl || httpsUrl,
        contentType: row.contentType,
        byteLength: row.byteLength,
        source: ipfsUri ? "ipfs" : "https",
      },
    };
  });

  app.get("/api/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id || id.length > 64) return reply.code(400).send({ error: "INVALID_ID" });

    const row = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });

    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("Access-Control-Allow-Origin", "*")
      .type(row.contentType)
      .send(Buffer.from(row.data));
  });
}

export async function loadMediaAsset(id: string): Promise<{ type: string; body: Buffer } | null> {
  if (!id || id.length > 64) return null;
  const row = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!row) return null;
  return { type: row.contentType, body: Buffer.from(row.data) };
}

/** Extract media id from an absolute or relative /api/media/:id URL. */
export function mediaIdFromLogo(logo: string): string | null {
  const match = logo.trim().match(/\/api\/media\/([a-z0-9_-]+)/i);
  return match?.[1] ?? null;
}
