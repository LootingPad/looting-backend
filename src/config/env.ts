import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const addressOrEmpty = z
  .string()
  .default("")
  .transform((v) => v.trim())
  .refine((v) => v === "" || /^0x[a-fA-F0-9]{40}$/.test(v), "invalid address");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().optional().default(""),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  MOBULA_API_KEY: z.string().min(1),
  MOBULA_BASE_URL: z.string().url().default("https://api.mobula.io"),
  UNI_UNIVERSAL_ROUTER: addressOrEmpty,
  UNI_PERMIT2: addressOrEmpty,
  UNI_V4_POOL_MANAGER: addressOrEmpty,
  UNI_V4_QUOTER: addressOrEmpty,
  UNI_V3_SWAP_ROUTER: addressOrEmpty,
  UNI_V3_QUOTER: addressOrEmpty,
  WETH_ADDRESS: addressOrEmpty,
  LAUNCH_REGISTRY_ADDRESS: addressOrEmpty,
  DEV_LOCK_ADDRESS: addressOrEmpty,
  STAKING_FACTORY_ADDRESS: addressOrEmpty,
  KEEPER_PRIVATE_KEY: z.string().optional().default(""),
  ADMIN_API_TOKEN: z.string().min(1),
  INDEXER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  ENABLE_TRADE_INDEXING: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** DexScreener Explore — off by default; product uses Pons + on-chain trenches. */
  ENABLE_DEXSCREENER_FEED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** ponsapi.dev — live New Pair / Almost (Pons V2 creates). */
  PONSAPI_API_KEY: z.string().optional().default(""),
  PONSAPI_BASE_URL: z.string().url().optional().default("https://api.ponsapi.dev"),
  PONSAPI_WS_URL: z.string().optional().default("wss://api.ponsapi.dev/v1/ws"),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(4000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(8),
  INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  TRADE_FEE_WALLET: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => /^0x[a-fA-F0-9]{40}$/.test(v), "invalid TRADE_FEE_WALLET"),
  /** Receives LOOTING's 0.00035 ETH share of the 0.00085 create fee. */
  LAUNCH_FEE_WALLET: z
    .string()
    .default("0xD712570969461D9f736a76e290a4Ee700509a59B")
    .transform((v) => v.trim())
    .refine((v) => /^0x[a-fA-F0-9]{40}$/.test(v), "invalid LAUNCH_FEE_WALLET"),
  PONS_V2_FACTORY: z
    .string()
    .default("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e")
    .refine((v) => /^0x[a-fA-F0-9]{40}$/.test(v), "invalid address"),
  /**
   * Optional one-confirm launch router (LootingLaunchRouter). When set, prepare returns a single
   * call: pay LOOTING 0.00035 + Pons launchFee in one user tx. Empty = legacy two-call path.
   */
  LOOTING_LAUNCH_ROUTER: addressOrEmpty,
  /**
   * LootingRewardRouter — Pons creatorFeeRecipient for new LOOTING launches + claimCreator target.
   * Empty = legacy auto-settle to creator wallet (pre-router launches).
   */
  LOOTING_REWARD_ROUTER: addressOrEmpty,
  /** Optional interim ETH lucky-box module (keeper credits / winner claims). */
  LOOTING_LUCKY_BOX_ETH_MODULE: addressOrEmpty,
  /** Pons FeeEscrow — creatorFeeRecipient claimable balances after curve sweepFees. */
  PONS_FEE_ESCROW: addressOrEmpty,
  /** Burn-budget pull destination (ops buy+burn). */
  BURN_WALLET: addressOrEmpty,
  /**
   * Public origin for absolute media URLs written on-chain.
   * Must be reachable by GMGN / Axiom / explorers — never localhost.
   * Prefer IPFS (PINATA_JWT) when available; this is the HTTPS fallback.
   */
  PUBLIC_API_BASE: z
    .string()
    .optional()
    .default("https://looting-backend-production.up.railway.app")
    .transform((v) => {
      const clean = v.trim().replace(/\/$/, "");
      if (/api\.lootingpad\.com/i.test(clean)) return "https://looting-backend-production.up.railway.app";
      return clean;
    }),
  /** Pinata JWT for pinning launch logos to public IPFS (ipfs://… on-chain). */
  PINATA_JWT: z.string().optional().default(""),
  TRENCH_POLL_MS: z.coerce.number().int().positive().default(200),
  TRENCH_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(0),
  TRENCH_LOG_CHUNK: z.coerce.number().int().positive().default(99),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export function contractsConfigured(): boolean {
  return Boolean(
    env.LAUNCH_REGISTRY_ADDRESS && env.DEV_LOCK_ADDRESS && env.STAKING_FACTORY_ADDRESS,
  );
}
