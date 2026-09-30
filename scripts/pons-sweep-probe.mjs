import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  getAddress,
  parseAbi,
  keccak256,
  toHex,
  slice,
} from "viem";

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
const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
const curve = getAddress("0xe91c2ECf4EE5b1BC5B3D8C9381743F0289342235");
const token = getAddress("0x69904faf181f14600D0472255aff5FEb888739F0");
const reward = getAddress(env.LOOTING_REWARD_ROUTER);
const creator = getAddress("0x28b14bF827b10D2037fdc367a1f86434069D5E50");

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

const sigs = [
  "sweepFees(uint256)",
  "sweepFees(uint256,uint256)",
  "quoteFeeBalance()",
  "creatorTaxBalance()",
  "transferCreatorFeeRecipient(address,address)",
  "setCreatorFeeRecipient(address,address)",
  "rescueCurveFees(address)",
  "sweepOperator()",
  "isSweepOperator(address)",
];

function sel(sig) {
  return slice(keccak256(toHex(sig)), 0, 4);
}
function hasSel(code, selector) {
  return Boolean(code) && code.toLowerCase().includes(`63${selector.slice(2).toLowerCase()}`);
}

const [factoryCode, curveCode] = await Promise.all([
  client.getBytecode({ address: factory }),
  client.getBytecode({ address: curve }),
]);

const found = {};
for (const sig of sigs) {
  const s = sel(sig);
  found[sig] = {
    selector: s,
    onFactory: hasSel(factoryCode, s),
    onCurve: hasSel(curveCode, s),
  };
}

const abi = parseAbi([
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function transferCreatorFeeRecipient(address token, address newRecipient)",
  "function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

const out = { found, views: {}, sims: {} };

async function tryRead(label, address, functionName, args = []) {
  try {
    const v = await client.readContract({ address, abi, functionName, args });
    out.views[label] = typeof v === "bigint" ? v.toString() : v;
  } catch (e) {
    out.views[label] = `REVERT:${(e.shortMessage || e.message).slice(0, 180)}`;
  }
}

await tryRead("curve.quoteFeeBalance", curve, "quoteFeeBalance");
await tryRead("curve.creatorTaxBalance", curve, "creatorTaxBalance");

const record = await client.readContract({
  address: factory,
  abi,
  functionName: "getLaunchedToken",
  args: [token],
});
out.views.launched = {
  creatorFeeRecipient: record.creatorFeeRecipient,
  buybackEnabled: record.buybackEnabled,
  phase: record.phase,
};

// Simulate sweep as creator / reward / random
for (const [who, account] of [
  ["creator", creator],
  ["rewardRouter", reward],
  ["random", getAddress("0x1111111111111111111111111111111111111111")],
]) {
  try {
    await client.simulateContract({
      address: curve,
      abi,
      functionName: "sweepFees",
      args: [0n],
      account,
    });
    out.sims[`sweepFees_as_${who}`] = "SUCCESS";
  } catch (e) {
    out.sims[`sweepFees_as_${who}`] = (e.shortMessage || e.message).slice(0, 280);
  }
}

// Simulate transfer recipient creator -> reward
try {
  await client.simulateContract({
    address: factory,
    abi,
    functionName: "transferCreatorFeeRecipient",
    args: [token, reward],
    account: creator,
  });
  out.sims.transferRecipient_creatorToReward = "SUCCESS";
} catch (e) {
  out.sims.transferRecipient_creatorToReward = (e.shortMessage || e.message).slice(0, 280);
}

const path = resolve(__dirname, "../pons-sweep-probe.json");
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
