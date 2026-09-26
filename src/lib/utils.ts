export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(trimmed)) {
    throw new Error(`Invalid address: ${address}`);
  }
  return trimmed;
}

export function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function tierFromXp(
  xp: bigint,
  thresholds: { bronze: number; silver: number; gold: number },
): "bronze" | "silver" | "gold" {
  const n = Number(xp);
  if (n >= thresholds.gold) return "gold";
  if (n >= thresholds.silver) return "silver";
  return "bronze";
}

/** Spec §11: base 10 XP, $5 min notional, volume bands up to 100. */
export function xpForQualifiedTrade(usdNotional: number): number {
  if (usdNotional < 5) return 0;
  if (usdNotional >= 10_000) return 100;
  if (usdNotional >= 1_000) return 50;
  if (usdNotional >= 100) return 25;
  return 10;
}

export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

import { prisma } from "../db/prisma.js";

export async function ensureWallet(chainId: number, wallet: string) {
  const normalized = normalizeAddress(wallet);
  return prisma.userWallet.upsert({
    where: { chainId_wallet: { chainId, wallet: normalized } },
    create: { chainId, wallet: normalized },
    update: { lastSeenAt: new Date() },
  });
}
