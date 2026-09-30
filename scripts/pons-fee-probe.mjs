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
const BACKEND_ENV = resolve(__dirname, "../.env");

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
const escrow = getAddress(env.PONS_FEE_ESCROW || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e");
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

const candidates = [
  "rescueCurveFees(address)",
  "rescueCurveFees(address,address)",
  "collectFees(address)",
  "collectCreatorFees(address)",
  "claimCreatorFees()",
  "claimFees()",
  "claim()",
  "flushFees(address)",
  "distributeFees(address)",
  "sweepFees(address)",
  "settleFees(address)",
  "withdrawCreatorFees(address)",
  "creditFees(address)",
  "harvestFees(address)",
  "syncFees(address)",
  "pullFees(address)",
  "processFees(address)",
  "skim(address)",
  "skimFees(address)",
  "takeFees(address)",
  "releaseFees(address)",
  "payoutFees(address)",
  "sendFees(address)",
  "forwardFees(address)",
  "feeEscrow()",
  "escrow()",
  "owner()",
  "getAccruedFees(address)",
  "accruedCreatorFees(address)",
  "creatorFeesAccrued(address)",
  "pendingCreatorFees(address)",
  "balanceOf(address)",
  "claimable(address)",
  "creatorTaxPaid()",
  "totalCreatorTax()",
  "realQuoteReserve()",
  "quoteReserve()",
  "getReserves()",
  "feeBps()",
  "creatorTaxBps()",
  "creatorFeeRecipient()",
  "accruedFees()",
  "protocolFees()",
  "creatorFees()",
  "feesOwed(address)",
  "owed(address)",
  "credit(address,uint256)",
  "credit(address,address,uint256)",
];

function selectorOf(sig) {
  return slice(keccak256(toHex(sig)), 0, 4);
}

function hasSelector(code, selector) {
  if (!code) return false;
  const hex = code.toLowerCase().slice(2);
  const s = selector.slice(2).toLowerCase();
  return hex.includes(`63${s}`);
}

const [factoryCode, escrowCode, curveCode] = await Promise.all([
  client.getBytecode({ address: factory }),
  client.getBytecode({ address: escrow }),
  client.getBytecode({ address: curve }),
]);

const found = { factory: [], escrow: [], curve: [] };
for (const sig of candidates) {
  const s = selectorOf(sig);
  if (hasSelector(factoryCode, s)) found.factory.push({ sig, selector: s });
  if (hasSelector(escrowCode, s)) found.escrow.push({ sig, selector: s });
  if (hasSelector(curveCode, s)) found.curve.push({ sig, selector: s });
}

const out = {
  addresses: { factory, escrow, curve, token, reward, creator },
  found,
  balances: {},
  views: {},
  calls: {},
};

out.balances.curve = (await client.getBalance({ address: curve })).toString();
out.balances.escrow = (await client.getBalance({ address: escrow })).toString();
out.balances.reward = (await client.getBalance({ address: reward })).toString();

const curveAbi = parseAbi([
  "function realQuoteReserve() view returns (uint256)",
  "function getReserves() view returns (uint256,uint256)",
  "function creatorTaxBps() view returns (uint16)",
  "function feeBps() view returns (uint16)",
  "function creatorTaxPaid() view returns (uint256)",
  "function totalCreatorTax() view returns (uint256)",
  "function creatorFeeRecipient() view returns (address)",
]);
const escrowAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function claim()",
  "function owner() view returns (address)",
]);
const factoryAbi = parseAbi([
  "function owner() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function rescueCurveFees(address token)",
]);

async function tryRead(label, address, abi, functionName, args = []) {
  try {
    const v = await client.readContract({ address, abi, functionName, args });
    out.views[label] =
      typeof v === "bigint"
        ? v.toString()
        : Array.isArray(v)
          ? v.map((x) => (typeof x === "bigint" ? x.toString() : x))
          : v;
  } catch (e) {
    out.views[label] = `REVERT:${(e.shortMessage || e.message).slice(0, 160)}`;
  }
}

await tryRead("curve.realQuoteReserve", curve, curveAbi, "realQuoteReserve");
await tryRead("curve.getReserves", curve, curveAbi, "getReserves");
await tryRead("curve.creatorTaxBps", curve, curveAbi, "creatorTaxBps");
await tryRead("curve.feeBps", curve, curveAbi, "feeBps");
await tryRead("curve.creatorTaxPaid", curve, curveAbi, "creatorTaxPaid");
await tryRead("curve.totalCreatorTax", curve, curveAbi, "totalCreatorTax");
await tryRead("curve.creatorFeeRecipient", curve, curveAbi, "creatorFeeRecipient");
await tryRead("escrow.balanceOf(reward)", escrow, escrowAbi, "balanceOf", [reward]);
await tryRead("escrow.balanceOf(creator)", escrow, escrowAbi, "balanceOf", [creator]);
await tryRead("factory.owner", factory, factoryAbi, "owner");
await tryRead("factory.feeEscrow", factory, factoryAbi, "feeEscrow");

try {
  await client.simulateContract({
    address: factory,
    abi: factoryAbi,
    functionName: "rescueCurveFees",
    args: [token],
    account: creator,
  });
  out.calls.rescueCurveFees_asCreator = "SUCCESS";
} catch (e) {
  out.calls.rescueCurveFees_asCreator = (e.shortMessage || e.message).slice(0, 240);
}

try {
  await client.simulateContract({
    address: factory,
    abi: factoryAbi,
    functionName: "rescueCurveFees",
    args: [token],
    account: reward,
  });
  out.calls.rescueCurveFees_asRewardRouter = "SUCCESS";
} catch (e) {
  out.calls.rescueCurveFees_asRewardRouter = (e.shortMessage || e.message).slice(0, 240);
}

// Accrued estimate = curve ETH balance - realQuoteReserve (if both readable)
if (
  out.views["curve.realQuoteReserve"] &&
  !String(out.views["curve.realQuoteReserve"]).startsWith("REVERT")
) {
  const bal = BigInt(out.balances.curve);
  const rqr = BigInt(out.views["curve.realQuoteReserve"]);
  out.views.accruedInCurveEstimate = (bal > rqr ? bal - rqr : 0n).toString();
}

const reportPath = resolve(__dirname, "../pons-fee-probe.json");
writeFileSync(reportPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.log("wrote", reportPath);
