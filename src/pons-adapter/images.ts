import type { Address } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { tokenAbi } from "./abi.js";

const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://w3s.link/ipfs/",
];

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml", "image/avif"]);

type CachedImage = { at: number; type: string; body: Buffer };
const images = new Map<string, CachedImage>();
const missingUntil = new Map<string, number>();

function ipfsPath(logo: string): string | null {
  const match = logo.trim().match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (!match) return null;
  return match[1].replace(/^\/+/, "");
}

function publicHttps(logo: string): string | null {
  const value = logo.trim();
  if (!value || value.startsWith("ipfs://") || value.startsWith("ar://")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "0.0.0.0") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function candidates(logo: string): string[] {
  const path = ipfsPath(logo);
  if (path) return GATEWAYS.map((gateway) => `${gateway}${path}`);
  const ar = logo.trim().match(/^ar:\/\/(.+)$/i);
  if (ar) return [`https://arweave.net/${ar[1]}`];
  const https = publicHttps(logo);
  return https ? [https] : [];
}

async function pull(url: string): Promise<{ type: string; body: Buffer } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "image/*,application/json;q=0.5", "User-Agent": "LootingIndexer/0.1" },
    });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > 2_000_000) return null;
    if (type === "application/json" || body[0] === 0x7b) {
      const meta = JSON.parse(body.toString("utf8")) as { image?: string; image_url?: string };
      const nested = meta.image || meta.image_url;
      if (!nested || nested === url) return null;
      const next = candidates(nested)[0];
      return next ? pull(next) : null;
    }
    if (!IMAGE_TYPES.has(type) && !type.startsWith("image/")) return null;
    return { type: type.startsWith("image/") ? type : "image/png", body };
  } catch {
    return null;
  }
}

async function chainLogo(token: string): Promise<string> {
  try {
    const client = getPublicClient();
    const info = await client.readContract({
      address: token as Address,
      abi: tokenAbi,
      functionName: "getTokenInfo",
    });
    return (info[1] ?? "").trim();
  } catch {
    return "";
  }
}

/** Bytes for a token image. Empty chain logos stay empty. */
export async function loadTokenImage(token: string): Promise<CachedImage | null> {
  const key = token.toLowerCase();
  const cached = images.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
  const absent = missingUntil.get(key);
  if (absent && absent > Date.now()) return null;

  const row = await prisma.trenchPair.findFirst({
    where: { token: key },
    select: { id: true, logo: true },
  });
  if (!row) return null;
  let logo = row.logo.trim();
  if (!logo) {
    logo = await chainLogo(key);
    if (logo) await prisma.trenchPair.update({ where: { id: row.id }, data: { logo } });
  }
  for (const url of candidates(logo)) {
    const file = await pull(url);
    if (!file) continue;
    const stored = { ...file, at: Date.now() };
    images.set(key, stored);
    missingUntil.delete(key);
    return stored;
  }
  missingUntil.set(key, Date.now() + 30_000);
  return null;
}
