import { env } from "../config/env.js";

export type IpfsPinResult = {
  cid: string;
  uri: string;
  gatewayUrl: string;
};

const GATEWAY = "https://ipfs.filebase.io/ipfs/";

/**
 * Pin bytes to public IPFS via Pinata (legacy pinFileToIPFS).
 * Returns ipfs://CID for on-chain storage — GMGN / Axiom resolve via public gateways.
 */
export async function pinImageToIpfs(
  bytes: Buffer,
  contentType: string,
  filename = "logo.png",
): Promise<IpfsPinResult | null> {
  const jwt = env.PINATA_JWT.trim();
  if (!jwt) return null;

  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  form.append("file", blob, filename);
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: filename, keyvalues: { app: "looting", kind: "token-logo" } }),
  );
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PINATA_${res.status}:${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { IpfsHash?: string; cid?: string };
  const cid = (json.IpfsHash || json.cid || "").trim();
  if (!cid) throw new Error("PINATA_NO_CID");

  return {
    cid,
    uri: `ipfs://${cid}`,
    gatewayUrl: `${GATEWAY}${cid}`,
  };
}

/** Prefer reliable gateways for display (public ipfs.io often 429). */
export function ipfsToHttp(logo: string): string | undefined {
  const raw = logo.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ipfs://")) {
    const cid = raw.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `${GATEWAY}${cid}`;
  }
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  return undefined;
}
