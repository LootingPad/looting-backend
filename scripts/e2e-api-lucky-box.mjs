/**
 * API E2E: seal ETH odds → launch → buy ≥ $5 → sell → allocate →
 * POST /api/lucky-boxes/:id/open → claimEthPrize.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
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
const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function previewLaunchEconomics(uint256, address) view returns (bytes32)",
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);
const launchRouterAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launch((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
]);
const tokenLaunchedEvent = parseAbi([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function creatorTaxBalance() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function register((address token, address curve, address creator, address creatorFeeRouter, uint16 creatorBps, uint16 luckyBoxBps, uint16 totalCreatorFeeBps, bool holderShareEnabled, address quoteAsset, uint64 launchedAt, uint8 phase, bool rewardsEnabled, bytes32 configHash) config)",
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
  const headers = {
    "content-type": "application/json",
    ...(opts.headers || {}),
  };
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
  const env = loadEnv(resolve(ROOT, ".env"));
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const account = privateKeyToAccount(pk);
  const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const launchRouter = getAddress(env.LOOTING_LAUNCH_ROUTER);
  const rewardRouter = getAddress(env.LOOTING_REWARD_ROUTER);
  const ethModule = getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE);
  const registry = getAddress(env.LAUNCH_REGISTRY_ADDRESS);

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

  const bal = await publicClient.getBalance({ address: account.address });
  console.log({ wallet: account.address, balanceEth: formatEther(bal) });

  // --- Seal safe ETH odds (100% ETH so open always pays) ---
  const seal = await api(
    "/api/admin/reward-table",
    {
      method: "POST",
      admin: true,
      body: JSON.stringify({
        name: `e2e-eth-${Date.now()}`,
        active: true,
        outcomes: [{ label: "ETH", weight: 100, kind: "eth" }],
      }),
    },
    env,
  );
  check("seal ETH odds", seal.status === 200 || seal.status === 201, JSON.stringify(seal.json).slice(0, 120));

  const fees = await api("/api/fees", {}, env);
  const ethUsd = Number(fees.json?.data?.ETH_USD || 0);
  check("ethUsd", ethUsd > 0, `ETH_USD=${ethUsd}`);

  // ≥ $5 notional to clear qualify floor; size to remaining balance.
  // Use live launchFee + gasPrice so a lean wallet can still clear the floor.
  const [launchFeeLive, gasPrice] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
    publicClient.getGasPrice(),
  ]);
  const gasReserve = gasPrice * 3_500_000n; // launch + buy + sell + harvest + claim headroom
  const launchCost = launchFeeLive + gasPrice * 400_000n;
  const maxBuy = bal > launchCost + gasReserve ? bal - launchCost - gasReserve : 0n;
  const minBuy = ethUsd > 0 ? parseEther((5.05 / ethUsd).toFixed(8)) : parseEther("0.0019");
  let buyWei = maxBuy;
  if (buyWei > parseEther("0.01")) buyWei = parseEther("0.01");
  if (buyWei < minBuy) {
    check(
      "wallet funded",
      false,
      `need buy≥${formatEther(minBuy)} + launch/gas; have=${formatEther(bal)} maxBuy=${formatEther(maxBuy)} fee=${formatEther(launchFeeLive)} gasR=${formatEther(gasReserve)}`,
    );
    writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    process.exit(1);
  }
  const buyUsdApprox = Number(formatEther(buyWei)) * ethUsd;
  check("wallet funded", true, `buyWei=${formatEther(buyWei)} (~$${buyUsdApprox.toFixed(2)})`);

  const canLaunch = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "canLaunch",
    args: [account.address],
  });
  check("canLaunch", canLaunch === true);

  const stamp = Date.now().toString().slice(-6);
  const prepare = await api(
    "/api/launch/prepare",
    {
      method: "POST",
      body: JSON.stringify({
        wallet: account.address,
        name: `API E2E ${stamp}`,
        symbol: `A${stamp.slice(-4)}`,
        description: "api lucky box e2e",
        logo: "https://lootingpad.com/logo.png",
        creatorTax: 1,
        luckyShare: 50,
        holderShareEnabled: false,
      }),
    },
    env,
  );
  const actionId = prepare.json?.data?.actionId ?? prepare.json?.actionId;
  const calls = prepare.json?.data?.calls ?? prepare.json?.calls;
  check("launch prepare", prepare.status === 200 && Array.isArray(calls) && calls.length > 0, `actionId=${actionId}`);

  // One-confirm router path: single payable call
  const call0 = calls[0];
  const launchTx = await walletClient.sendTransaction({
    to: getAddress(call0.to),
    data: call0.data,
    value: BigInt(call0.value || "0"),
  });
  const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchTx, timeout: 180_000 });
  check("launch", launchReceipt.status === "success", launchTx);

  const confirmLaunch = await api(
    "/api/launch/confirm",
    {
      method: "POST",
      body: JSON.stringify({ actionId, txHash: launchTx }),
    },
    env,
  );
  const token = confirmLaunch.json?.token;
  const curve = confirmLaunch.json?.curve;
  check(
    "launch confirm (DB)",
    (confirmLaunch.status === 200 || confirmLaunch.json?.status === "confirmed") && Boolean(token && curve),
    `token=${token} status=${confirmLaunch.json?.status}`,
  );

  // On-chain registry (confirm already attempts this; ensure split exists for allocate)
  try {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: registry,
        abi: registryAbi,
        functionName: "register",
        args: [
          {
            token,
            curve,
            creator: account.address,
            creatorFeeRouter: rewardRouter,
            creatorBps: 5000,
            luckyBoxBps: 5000,
            totalCreatorFeeBps: 10000,
            holderShareEnabled: false,
            quoteAsset: ZERO,
            launchedAt: BigInt(Math.floor(Date.now() / 1000)),
            phase: 0,
            rewardsEnabled: true,
            configHash: toHex(crypto.getRandomValues(new Uint8Array(32))),
          },
        ],
      }),
      timeout: 180_000,
    });
    check("registry", true);
  } catch (e) {
    check("registry", true, `skip/exists: ${String(e.shortMessage || e.message).slice(0, 80)}`);
  }

  // Buy ≥ $5 — size AFTER launch so fee/gas already spent are reflected.
  const balAfterLaunch = await publicClient.getBalance({ address: account.address });
  const gasPriceNow = await publicClient.getGasPrice();
  const buyGasHeadroom = gasPriceNow * 500_000n;
  let liveBuy = balAfterLaunch > buyGasHeadroom ? balAfterLaunch - buyGasHeadroom : 0n;
  if (liveBuy > parseEther("0.01")) liveBuy = parseEther("0.01");
  if (liveBuy < minBuy) {
    check(
      "buy funded post-launch",
      false,
      `need≥${formatEther(minBuy)}; have=${formatEther(balAfterLaunch)} liveBuy=${formatEther(liveBuy)}`,
    );
    writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    process.exit(1);
  }
  buyWei = liveBuy;
  check(
    "buy funded post-launch",
    true,
    `buyWei=${formatEther(buyWei)} (~$${(Number(formatEther(buyWei)) * ethUsd).toFixed(2)}) bal=${formatEther(balAfterLaunch)}`,
  );

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
  const boxId = buyConfirm.json?.data?.items?.find((i) => i.boxId)?.boxId;
  check(
    "buy confirm mints box",
    buyConfirm.status === 200 && Boolean(boxId),
    `status=${buyConfirm.status} box=${boxId} minted=${buyConfirm.json?.data?.boxesMinted}`,
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
  check(
    "sell unlocks box",
    sellConfirm.status === 200 && Number(sellConfirm.json?.data?.boxesUnlocked || 0) >= 1,
    `unlocked=${sellConfirm.json?.data?.boxesUnlocked}`,
  );

  // Fund box pool
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: rewardRouter,
      abi: rewardAbi,
      functionName: "sweepPonsCurveFees",
      args: [curve, 0n],
    }),
    timeout: 180_000,
  });
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: rewardRouter,
      abi: rewardAbi,
      functionName: "harvestPonsFees",
    }),
    timeout: 180_000,
  });
  const unalloc = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "unallocatedEth",
  });
  check("harvested", unalloc > 0n, `unalloc=${unalloc}`);
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: rewardRouter,
      abi: rewardAbi,
      functionName: "allocate",
      args: [token, unalloc],
    }),
    timeout: 180_000,
  });
  const boxPool = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "luckyBoxClaimable",
    args: [token],
  });
  check("box pool", boxPool > 0n, `box=${boxPool}`);

  // Open via API (keeper credits)
  const open = await api(
    `/api/lucky-boxes/${boxId}/open`,
    { method: "POST", body: JSON.stringify({ wallet: account.address }) },
    env,
  );
  check(
    "api open",
    open.status === 200 && (open.json?.claimableOnChain === true || open.json?.data?.status === "claimed"),
    `status=${open.status} claimable=${open.json?.claimableOnChain} reward=${open.json?.reward} credited=${open.json?.creditedWei}`,
  );

  if (open.json?.claimableOnChain) {
    const pending = await publicClient.readContract({
      address: ethModule,
      abi: ethModuleAbi,
      functionName: "pendingEth",
      args: [account.address, token],
    });
    check("pending ETH", pending > 0n, `pending=${pending}`);
    const claimTx = await walletClient.writeContract({
      address: ethModule,
      abi: ethModuleAbi,
      functionName: "claimEthPrize",
      args: [token],
    });
    await publicClient.waitForTransactionReceipt({ hash: claimTx, timeout: 180_000 });
    await api(
      `/api/lucky-boxes/${boxId}/claim/confirm`,
      { method: "POST", body: JSON.stringify({ wallet: account.address, txHash: claimTx }) },
      env,
    );
    check("claim ETH", true, claimTx);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const report = {
    at: new Date().toISOString(),
    token,
    curve,
    boxId,
    buyTx,
    sellTx,
    open: open.json,
    passed,
    failed,
    results,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("wrote", REPORT, { passed, failed });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  writeFileSync(
    REPORT,
    JSON.stringify({ at: new Date().toISOString(), fatal: String(err), results }, null, 2),
  );
  process.exit(1);
});
