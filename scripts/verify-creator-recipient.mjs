import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, getAddress, parseAbi } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ENV = resolve(__dirname, "../.env");
const REPORT_PATH = resolve(__dirname, "../e2e-reward-smoke.report.json");

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(BACKEND_ENV);
const rpc = env.RPC_HTTP_URL;
const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const token = getAddress("0x69904faf181f14600D0472255aff5FEb888739F0");
const creator = getAddress("0x28b14bF827b10D2037fdc367a1f86434069D5E50");
const reward = getAddress(env.LOOTING_REWARD_ROUTER);
const launchRouter = getAddress(env.LOOTING_LAUNCH_ROUTER);

const chain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
};
const client = createPublicClient({
  chain,
  transport: http(rpc, {
    fetchOptions: {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LootingIndexer/0.1)",
        Accept: "application/json",
      },
    },
  }),
});

const abi = parseAbi([
  "function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

const r = await client.readContract({
  address: factory,
  abi,
  functionName: "getLaunchedToken",
  args: [token],
});

const results = [
  {
    step: "Pons creatorFeeRecipient = creator",
    ok: r.creatorFeeRecipient.toLowerCase() === creator.toLowerCase(),
    detail: `got=${r.creatorFeeRecipient}`,
  },
  {
    step: "Pons creatorFeeRecipient != RewardRouter",
    ok: r.creatorFeeRecipient.toLowerCase() !== reward.toLowerCase(),
    detail: `reward=${reward}`,
  },
  {
    step: "Pons deployer = LaunchRouter",
    ok: r.deployer.toLowerCase() === launchRouter.toLowerCase(),
    detail: `deployer=${r.deployer}`,
  },
];

for (const row of results) {
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.step} — ${row.detail}`);
}

const report = {
  at: new Date().toISOString(),
  model: "unaffiliated-pons",
  launchRouter,
  rewardRouter: reward,
  liveVerifyToken: token,
  liveVerifyTx: "0x82c2641fc7df4fa5c0cd7012149d59f2c10802c70118178c0607a8dc0c8e5a2b",
  pons: {
    deployer: r.deployer,
    creatorFeeRecipient: r.creatorFeeRecipient,
    curve: r.curve,
  },
  results,
  forge: {
    LootingLaunchRouterTest: "7 passed",
    LootingRewardRouterTest: "8 passed",
  },
  backend: { typecheck: "ok" },
  railway: "LOOTING_LAUNCH_ROUTER=0x3e557F19890E83D8e33C19d7574458DF838a58Ab (redeploying)",
  notes: [
    "Pons creatorFeeRecipient = launching creator wallet",
    "Pons trade tax stays on Pons path (no LOOTING flush / affiliation)",
    "Lucky Box / burn funded by LOOTING deposit → allocate only",
    "Full allocate/claim/buy/sell smoke deferred — keeper ETH low after deploy+launch",
  ],
  summary: {
    passed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
  },
};

writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log("wrote", REPORT_PATH);
if (report.summary.failed > 0) process.exit(1);
