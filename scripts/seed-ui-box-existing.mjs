/**
 * Seed box on existing DB launch (QQQ) — no new launch fee needed.
 * Buy ≥$5 → confirm → sell → confirm.
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
const TOKEN = getAddress(process.env.SEED_TOKEN || "0xcd8856715898dcdb641504ace654e57e9e2965cb");

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
  console.log({ wallet: account.address, balance: formatEther(bal), token: TOKEN, api: API });

  // ≥$5 at ETH_USD=3500 ≈ 0.00143 ETH; leave ~0.0004 for gas round-trips
  const buyAmount = parseEther("0.0015");
  if (bal < buyAmount + parseEther("0.00035")) {
    throw new Error(`Need ≥${formatEther(buyAmount + parseEther("0.00035"))} ETH. Have ${formatEther(bal)}`);
  }

  const launched = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [TOKEN],
  });
  if (!launched.exists) throw new Error("token not launched on factory");
  const curve = getAddress(launched.curve);
  console.log({ curve, phase: launched.phase });

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
    token: TOKEN,
    wallet: account.address,
    txHash: buyTx,
  });
  console.log("buy confirm", buyConfirm.data);

  const toks = await publicClient.readContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log("token bal", toks.toString());
  if (toks === 0n) throw new Error("buy returned 0 tokens");

  const approveTx = await walletClient.writeContract({
    address: TOKEN,
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
    token: TOKEN,
    wallet: account.address,
    txHash: sellTx,
  });
  console.log("sell confirm", sellConfirm.data);

  const boxes = await fetch(`${API}/api/wallet/${account.address}/lucky-boxes`).then((r) => r.json());
  console.log("lucky-boxes", JSON.stringify(boxes, null, 2));

  writeFileSync(
    resolve(__dirname, "../e2e-ui-box-seed.report.json"),
    `${JSON.stringify({ wallet: account.address, token: TOKEN, curve, buyTx, sellTx, buyConfirm: buyConfirm.data, sellConfirm: sellConfirm.data, boxes }, null, 2)}\n`,
  );

  if (!boxes.data?.length) {
    throw new Error("Still 0 boxes after buy/sell confirm");
  }
  console.log(`OK — ${boxes.data.length} box(es). Connect wallet ${account.address} on Rewards.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
