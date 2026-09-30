/**
 * Resume API E2E from an already-confirmed launch (DB + on-chain).
 * Usage: node scripts/e2e-api-resume-buy.mjs <token> <curve>
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
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPORT = resolve(ROOT, "e2e-api-lucky-box.report.json");
const API = process.env.API_URL || "http://localhost:8080";

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

const ZERO = "0x0000000000000000000000000000000000000000";
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
]);
const rewardAbi = parseAbi([
  "function sweepPonsCurveFees(address curve, uint256 minBuybackTokensOut)",
  "function harvestPonsFees() returns (uint256)",
  "function unallocatedEth() view returns (uint256)",
  "function allocate(address token, uint256 amount)",
  "function luckyBoxClaimable(address token) view returns (uint256)",
]);
const ethModuleAbi = parseAbi([
  "function claimEthPrize(address token) returns (uint256 amount)",
  "function pendingEth(address winner, address token) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const results = [];
function check(step, ok, detail = "") {
  results.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

async function api(path, opts = {}, env) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (opts.admin) headers.Authorization = `Bearer ${env.ADMIN_API_TOKEN}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function main() {
  const tokenArg = process.argv[2];
  const curveArg = process.argv[3];
  if (!tokenArg || !curveArg) {
    console.error("usage: node scripts/e2e-api-resume-buy.mjs <token> <curve>");
    process.exit(1);
  }
  const token = getAddress(tokenArg);
  const curve = getAddress(curveArg);

  const env = loadEnv(resolve(ROOT, ".env"));
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const account = privateKeyToAccount(pk);
  const rewardRouter = getAddress(env.LOOTING_REWARD_ROUTER);
  const ethModule = getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE);

  const chain = {
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_HTTP_URL] } },
  };
  const transport = http(env.RPC_HTTP_URL, {
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

  const fees = await api("/api/fees", {}, env);
  const ethUsd = Number(fees.json?.data?.ETH_USD || 0);
  const minBuy = ethUsd > 0 ? parseEther((5.05 / ethUsd).toFixed(8)) : parseEther("0.0019");

  const bal = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  const headroom = gasPrice * 500_000n;
  let buyWei = bal > headroom ? bal - headroom : 0n;
  if (buyWei > parseEther("0.01")) buyWei = parseEther("0.01");
  console.log({ bal: formatEther(bal), buyWei: formatEther(buyWei), minBuy: formatEther(minBuy) });
  if (buyWei < minBuy) {
    check("buy funded", false, `need≥${formatEther(minBuy)} have=${formatEther(bal)}`);
    writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    process.exit(1);
  }
  check("buy funded", true, `~$${(Number(formatEther(buyWei)) * ethUsd).toFixed(2)}`);

  const buyTx = await walletClient.writeContract({
    address: curve,
    abi: curveAbi,
    functionName: "buy",
    args: [buyWei, 0n, account.address],
    value: buyWei,
  });
  await publicClient.waitForTransactionReceipt({ hash: buyTx, timeout: 180_000 });
  const buyConfirm = await api(
    "/api/trade/confirm",
    { method: "POST", body: JSON.stringify({ token, wallet: account.address, txHash: buyTx }) },
    env,
  );
  const boxId =
    buyConfirm.json?.data?.items?.find((i) => i.boxId)?.boxId ??
    buyConfirm.json?.data?.boxId;
  check(
    "buy confirm mints box",
    buyConfirm.status === 200 && Boolean(boxId),
    `status=${buyConfirm.status} box=${boxId} minted=${buyConfirm.json?.data?.boxesMinted} body=${JSON.stringify(buyConfirm.json).slice(0, 200)}`,
  );

  const toks = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  check("holding tokens", toks > 0n, `bal=${toks}`);

  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [curve, toks],
    }),
    timeout: 180_000,
  });
  const sellTx = await walletClient.writeContract({
    address: curve,
    abi: curveAbi,
    functionName: "sell",
    args: [toks, 0n, account.address],
  });
  await publicClient.waitForTransactionReceipt({ hash: sellTx, timeout: 180_000 });
  const sellConfirm = await api(
    "/api/trade/confirm",
    { method: "POST", body: JSON.stringify({ token, wallet: account.address, txHash: sellTx }) },
    env,
  );
  check("sell confirm unlock", sellConfirm.status === 200, JSON.stringify(sellConfirm.json).slice(0, 160));

  // Fund box pool
  try {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: rewardRouter,
        abi: rewardAbi,
        functionName: "sweepPonsCurveFees",
        args: [curve, 0n],
      }),
      timeout: 180_000,
    });
    check("sweep", true);
  } catch (e) {
    check("sweep", true, `skip: ${String(e.shortMessage || e.message).slice(0, 80)}`);
  }
  try {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: rewardRouter,
        abi: rewardAbi,
        functionName: "harvestPonsFees",
      }),
      timeout: 180_000,
    });
    check("harvest", true);
  } catch (e) {
    check("harvest", true, `skip: ${String(e.shortMessage || e.message).slice(0, 80)}`);
  }

  const unalloc = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "unallocatedEth",
  });
  if (unalloc > 0n) {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: rewardRouter,
        abi: rewardAbi,
        functionName: "allocate",
        args: [token, unalloc],
      }),
      timeout: 180_000,
    });
  }
  const claimable = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "luckyBoxClaimable",
    args: [token],
  });
  check("box pool funded", claimable > 0n, `claimable=${claimable} unallocWas=${unalloc}`);

  const open = await api(`/api/lucky-boxes/${boxId}/open`, { method: "POST" }, env);
  check(
    "open box",
    open.status === 200,
    `status=${open.status} ${JSON.stringify(open.json).slice(0, 220)}`,
  );

  const pending = await publicClient.readContract({
    address: ethModule,
    abi: ethModuleAbi,
    functionName: "pendingEth",
    args: [account.address, token],
  });
  check("pending eth prize", pending > 0n, `pending=${pending}`);

  if (pending > 0n) {
    const claimTx = await walletClient.writeContract({
      address: ethModule,
      abi: ethModuleAbi,
      functionName: "claimEthPrize",
      args: [token],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimTx, timeout: 180_000 });
    check("claim eth prize", true, claimTx);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        model: "api-resume",
        token,
        curve,
        boxId,
        results,
        summary: { passed, failed },
      },
      null,
      2,
    ),
  );
  console.log({ passed, failed, token, boxId });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
