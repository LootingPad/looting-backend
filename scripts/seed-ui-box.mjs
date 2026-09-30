/**
 * Seed a real Lucky Box in prod Postgres so Rewards UI is not empty.
 * Flow: /api/launch/prepare → sign → /api/launch/confirm → buy ≥$5 →
 * /api/trade/confirm → sell → /api/trade/confirm.
 *
 * Run: node scripts/seed-ui-box.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ENV = resolve(__dirname, "../.env");
const API = process.env.PUBLIC_API_BASE || "https://api.lootingpad.com";

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

const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} ${res.status} ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const env = loadEnv(BACKEND_ENV);
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const rpc = env.RPC_HTTP_URL;
  const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const account = privateKeyToAccount(pk);

  const chain = {
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
  const transport = http(rpc, {
    timeout: 60_000,
    fetchOptions: {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LootingIndexer/0.1; +https://github.com/LootingPad/looting-backend)",
        Accept: "application/json",
      },
    },
  });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const bal = await publicClient.getBalance({ address: account.address });
  console.log({ wallet: account.address, balance: formatEther(bal), api: API });
  if (bal < parseEther("0.0035")) {
    throw new Error(`Need ≥0.0035 ETH. Have ${formatEther(bal)}`);
  }

  const stamp = Date.now().toString().slice(-6);
  const name = `UI Box ${stamp}`;
  const symbol = `UB${stamp.slice(-4)}`;

  // 1) Prepare + confirm launch so Launch row exists in prod Postgres
  const prepare = await api("/api/launch/prepare", {
    wallet: account.address,
    name,
    symbol,
    description: "seed lucky box for UI",
    logo: "https://lootingpad.com/logo.png",
    creatorTax: 1,
    luckyShare: 50,
    buybackEnabled: false,
  });
  const actionId = prepare.data?.actionId;
  const calls = prepare.data?.calls ?? [];
  if (!actionId || !calls.length) throw new Error(`bad prepare: ${JSON.stringify(prepare)}`);
  console.log("prepare", { actionId, calls: calls.length, mode: prepare.data.mode });

  let launchTx;
  for (const call of calls) {
    launchTx = await walletClient.sendTransaction({
      to: getAddress(call.to),
      data: call.data,
      value: BigInt(call.value || "0"),
    });
    console.log("launch call tx", launchTx);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: launchTx, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`launch call reverted ${launchTx}`);
  }

  const conf = await api("/api/launch/confirm", { actionId, txHash: launchTx });
  const token = getAddress(conf.token || conf.data?.token);
  console.log("launch confirm", { token, curve: conf.curve || conf.data?.curve, status: conf.status });

  const launched = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  const curve = getAddress(launched.curve);
  console.log("curve", curve);

  // 2) Buy ≥ $5 (ETH_USD=3500 → need ≥ ~0.00143 ETH). Use 0.002.
  const buyAmount = parseEther("0.002");
  const buyTx = await walletClient.writeContract({
    address: curve,
    abi: curveAbi,
    functionName: "buy",
    args: [buyAmount, 0n, account.address],
    value: buyAmount,
  });
  console.log("buyTx", buyTx);
  await publicClient.waitForTransactionReceipt({ hash: buyTx, timeout: 180_000 });

  const buyConfirm = await api("/api/trade/confirm", {
    token,
    wallet: account.address,
    txHash: buyTx,
  });
  console.log("buy confirm", buyConfirm.data);

  // 3) Full sell to unlock box
  const toks = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const approveTx = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [curve, toks],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 180_000 });

  const sellTx = await walletClient.writeContract({
    address: curve,
    abi: curveAbi,
    functionName: "sell",
    args: [toks, 0n, account.address],
  });
  console.log("sellTx", sellTx);
  await publicClient.waitForTransactionReceipt({ hash: sellTx, timeout: 180_000 });

  const sellConfirm = await api("/api/trade/confirm", {
    token,
    wallet: account.address,
    txHash: sellTx,
  });
  console.log("sell confirm", sellConfirm.data);

  const boxesRes = await fetch(`${API}/api/wallet/${account.address}/lucky-boxes`);
  const boxes = await boxesRes.json();
  console.log("lucky-boxes", JSON.stringify(boxes, null, 2));

  writeFileSync(
    resolve(__dirname, "../e2e-ui-box-seed.report.json"),
    `${JSON.stringify(
      {
        wallet: account.address,
        token,
        curve,
        buyTx,
        sellTx,
        buyConfirm: buyConfirm.data,
        sellConfirm: sellConfirm.data,
        boxes,
      },
      null,
      2,
    )}\n`,
  );

  if (!boxes.data?.length) {
    throw new Error("Seed finished but wallet still has 0 boxes — check launch/rewardsEnabled + usdNotional");
  }
  console.log(`OK — ${boxes.data.length} box(es) for ${account.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
