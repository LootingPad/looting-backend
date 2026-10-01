import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { loadLootingLiveMarket, loadLootingCandles, resolveTokenProfile, browserLogoUrl } from "../lib/token-profile.js";
import { normalizeAddress } from "../lib/utils.js";

export const SITE_CONFIG_ID = "default";

export type SiteConfigPublic = {
  address: string;
  symbol: string;
  name: string;
  logo: string;
  tagline: string;
  blurb: string;
  burnAllocationPct: number;
  asOf: string | null;
  updatedAt: string;
};

function toPublic(row: {
  lootingTokenAddress: string;
  symbol: string;
  name: string;
  logo?: string | null;
  tagline: string;
  blurb: string;
  burnAllocationPct: number;
  asOfLabel: string | null;
  updatedAt: Date;
}): SiteConfigPublic {
  return {
    address: row.lootingTokenAddress,
    symbol: row.symbol,
    name: row.name,
    logo: row.logo ?? "",
    tagline: row.tagline,
    blurb: row.blurb,
    burnAllocationPct: row.burnAllocationPct,
    asOf: row.asOfLabel,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrCreateSiteConfig() {
  const existing = await prisma.siteConfig.findUnique({ where: { id: SITE_CONFIG_ID } });
  if (existing) return existing;
  return prisma.siteConfig.create({
    data: { id: SITE_CONFIG_ID },
  });
}

export type SiteConfigUpdate = {
  lootingTokenAddress?: string;
  symbol?: string;
  name?: string;
  logo?: string;
  tagline?: string;
  blurb?: string;
  burnAllocationPct?: number;
  asOfLabel?: string | null;
};

export function parseSiteConfigUpdate(body: SiteConfigUpdate): {
  ok: true;
  data: {
    lootingTokenAddress?: string;
    symbol?: string;
    name?: string;
    logo?: string;
    tagline?: string;
    blurb?: string;
    burnAllocationPct?: number;
    asOfLabel?: string | null;
  };
} | { ok: false; error: string } {
  const data: {
    lootingTokenAddress?: string;
    symbol?: string;
    name?: string;
    logo?: string;
    tagline?: string;
    blurb?: string;
    burnAllocationPct?: number;
    asOfLabel?: string | null;
  } = {};

  if (body.lootingTokenAddress !== undefined) {
    const raw = body.lootingTokenAddress.trim();
    if (!raw) {
      data.lootingTokenAddress = "";
    } else {
      try {
        data.lootingTokenAddress = normalizeAddress(raw);
      } catch {
        return { ok: false, error: "INVALID_ADDRESS" };
      }
    }
  }

  if (body.symbol !== undefined) data.symbol = body.symbol.trim() || "LOOTING";
  if (body.name !== undefined) data.name = body.name.trim() || "LOOTING";
  if (body.logo !== undefined) data.logo = body.logo.trim();
  if (body.tagline !== undefined) data.tagline = body.tagline.trim();
  if (body.blurb !== undefined) data.blurb = body.blurb.trim();

  if (body.burnAllocationPct !== undefined) {
    const n = Number(body.burnAllocationPct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: "INVALID_BURN_ALLOCATION" };
    }
    data.burnAllocationPct = n;
  }

  if (body.asOfLabel !== undefined) {
    const label = body.asOfLabel?.trim() || null;
    data.asOfLabel = label;
  }

  return { ok: true, data };
}

export async function upsertSiteConfig(update: SiteConfigUpdate) {
  const parsed = parseSiteConfigUpdate(update);
  if (!parsed.ok) return parsed;

  // When CA is set and meta fields were left blank, pull them from chain/Mobula.
  if (parsed.data.lootingTokenAddress) {
    try {
      const profile = await resolveTokenProfile(parsed.data.lootingTokenAddress);
      if (!parsed.data.symbol || parsed.data.symbol === "LOOTING") parsed.data.symbol = profile.symbol;
      if (!parsed.data.name || parsed.data.name === "LOOTING") parsed.data.name = profile.name;
      if (parsed.data.logo === undefined || parsed.data.logo === "") {
        parsed.data.logo = browserLogoUrl(profile.logo) || profile.logo;
      } else {
        parsed.data.logo = browserLogoUrl(parsed.data.logo) || parsed.data.logo;
      }
      if ((!parsed.data.blurb || !parsed.data.blurb.trim()) && profile.description) {
        parsed.data.blurb = profile.description.slice(0, 500);
      }
    } catch {
      /* keep submitted fields */
    }
  }

  const row = await prisma.siteConfig.upsert({
    where: { id: SITE_CONFIG_ID },
    create: {
      id: SITE_CONFIG_ID,
      ...parsed.data,
    },
    update: parsed.data,
  });

  return { ok: true as const, data: toPublic(row) };
}

export async function readSiteConfigPublic(): Promise<SiteConfigPublic> {
  const row = await getOrCreateSiteConfig();
  return toPublic(row);
}

/** Public read for the /looting marketing page — config + live market + OHLCV when CA is set. */
export async function registerLootingTokenRoutes(app: FastifyInstance) {
  app.get("/api/looting-token", async () => {
    const config = await readSiteConfigPublic();
    let market = null;
    let candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
    let liveLogo = config.logo;
    let liveSymbol = config.symbol;
    let liveName = config.name;
    let description = "";
    let socials = {
      twitter: "",
      telegram: "",
      discord: "",
      website: "",
      farcaster: "",
    };

    if (config.address) {
      try {
        const profile = await resolveTokenProfile(config.address);
        liveLogo = browserLogoUrl(profile.logo || config.logo) || profile.logo || config.logo;
        liveSymbol = profile.symbol || config.symbol;
        liveName = profile.name || config.name;
        description = profile.description || "";
        socials = profile.socials;
      } catch {
        /* keep stored */
      }
      try {
        market = await loadLootingLiveMarket(config.address);
      } catch {
        market = null;
      }
      try {
        candles = await loadLootingCandles(config.address, market?.priceUsd ?? null);
      } catch {
        candles = [];
      }
    }

    return {
      data: {
        ...config,
        symbol: liveSymbol,
        name: liveName,
        logo: liveLogo,
        description,
        socials,
        market,
        candles,
      },
    };
  });
}
