import type { Address } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { loadMediaAsset, mediaIdFromLogo } from "../modules/media.js";
import { tokenAbi } from "./abi.js";

/** Prefer gateways that still serve anonymous reads; public ipfs.io/pinata often 429. */
const GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://4everland.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/avif",
]);

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type CachedImage = { at: number; type: string; body: Buffer };
const images = new Map<string, CachedImage>();
const missingUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<CachedImage | null>>();

function ipfsPath(logo: string): string | null {
  const match = logo.trim().match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (!match) return null;
  return match[1].replace(/^\/+/, "");
}

function publicHttps(logo: string): string | null {
  const value = logo.trim();
  if (!value || value.startsWith("ipfs://") || value.startsWith("ar://")) return null;
  // Our own media URLs are loaded from Postgres — never HTTP-fetch them.
  if (mediaIdFromLogo(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "127.0.0.1" || host === "0.0.0.0") {
      return null;
    }
    if (url.protocol === "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function candidates(logo: string): string[] {
  const path = ipfsPath(logo);
  if (path) {
    return [
      ...GATEWAYS.map((gateway) => `${gateway}${path}`),
      `https://${path}.ipfs.dweb.link`,
      `https://${path}.ipfs.nftstorage.link`,
    ];
  }
  const ar = logo.trim().match(/^ar:\/\/(.+)$/i);
  if (ar) return [`https://arweave.net/${ar[1]}`];
  const https = publicHttps(logo);
  if (!https) return [];
  // Dedicated Pinata/HTTP URLs first; also try CID extraction if path looks like /ipfs/<cid>
  const viaIpfs = https.match(/\/ipfs\/([^/?#]+)/i);
  if (viaIpfs) {
    const cid = viaIpfs[1];
    return [https, ...GATEWAYS.map((gateway) => `${gateway}${cid}`)];
  }
  return [https];
}

/** Many IPFS gateways return application/octet-stream — sniff magic bytes. */
function sniffImageType(body: Buffer, headerType: string): string | null {
  const type = headerType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(type) || type.startsWith("image/")) {
    return type === "image/jpg" ? "image/jpeg" : type;
  }
  if (body.length >= 12) {
    if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
    if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "image/gif";
    if (
      body[0] === 0x52 &&
      body[1] === 0x49 &&
      body[2] === 0x46 &&
      body[3] === 0x46 &&
      body[8] === 0x57 &&
      body[9] === 0x45 &&
      body[10] === 0x42 &&
      body[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  const head = body.subarray(0, Math.min(body.length, 256)).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

async function pull(url: string, signal?: AbortSignal): Promise<{ type: string; body: Buffer } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: signal ?? AbortSignal.timeout(8_000),
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": BROWSER_UA,
      },
    });
    if (!response.ok) return null;
    const headerType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > 2_000_000) return null;
    if (headerType === "application/json" || body[0] === 0x7b) {
      try {
        const meta = JSON.parse(body.toString("utf8")) as { image?: string; image_url?: string };
        const nested = meta.image || meta.image_url;
        if (!nested || nested === url) return null;
        return pullFirst(candidates(nested));
      } catch {
        return null;
      }
    }
    const type = sniffImageType(body, headerType);
    if (!type) return null;
    return { type, body };
  } catch {
    return null;
  }
}

/** Race gateways; first usable image wins. */
async function pullFirst(urls: string[]): Promise<{ type: string; body: Buffer } | null> {
  if (urls.length === 0) return null;
  const unique = [...new Set(urls)];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  try {
    return await Promise.any(
      unique.map(async (url) => {
        const file = await pull(url, controller.signal);
        if (!file) throw new Error("miss");
        controller.abort();
        return file;
      }),
    );
  } catch {
    // Parallel race failed — try a few sequentially with fresh timeouts.
    for (const url of unique.slice(0, 4)) {
      const file = await pull(url);
      if (file) return file;
    }
    return null;
  } finally {
    clearTimeout(timer);
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

async function resolveTokenImage(token: string): Promise<CachedImage | null> {
  const key = token.toLowerCase();
  const cached = images.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached;
  const absent = missingUntil.get(key);
  if (absent && absent > Date.now()) return null;

  const row = await prisma.trenchPair.findFirst({
    where: { token: key },
    select: { id: true, logo: true },
  });
  let logo = (row?.logo ?? "").trim();
  if (!logo) {
    logo = await chainLogo(key);
    if (logo && row) await prisma.trenchPair.update({ where: { id: row.id }, data: { logo } });
  }
  if (!logo) {
    missingUntil.set(key, Date.now() + 60_000);
    return null;
  }

  const mediaId = mediaIdFromLogo(logo);
  if (mediaId) {
    const media = await loadMediaAsset(mediaId);
    if (!media) {
      missingUntil.set(key, Date.now() + 30_000);
      return null;
    }
    const stored = { ...media, at: Date.now() };
    images.set(key, stored);
    missingUntil.delete(key);
    return stored;
  }

  const file = await pullFirst(candidates(logo));
  if (!file) {
    missingUntil.set(key, Date.now() + 5_000);
    return null;
  }
  const stored = { ...file, at: Date.now() };
  images.set(key, stored);
  missingUntil.delete(key);
  return stored;
}

/** Bytes for a token image. Empty chain logos stay empty. */
export async function loadTokenImage(token: string): Promise<CachedImage | null> {
  const key = token.toLowerCase();
  const cached = images.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached;
  const flight = inFlight.get(key);
  if (flight) return flight;
  const job = resolveTokenImage(key).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
