import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatEther, getAddress } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dirname, "../.env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const rpc = env.RPC_HTTP_URL;
const a = getAddress("0x28b14bF827b10D2037fdc367a1f86434069D5E50");
const c = createPublicClient({
  chain: {
    id: 4663,
    name: "rh",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  },
  transport: http(rpc, {
    fetchOptions: {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LootingIndexer/0.1; +https://github.com/LootingPad/looting-backend)",
        Accept: "application/json",
      },
    },
  }),
});
const bal = await c.getBalance({ address: a });
console.log(JSON.stringify({ to: a, balanceEth: formatEther(bal) }, null, 2));
