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
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(4000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(8),
  INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
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
