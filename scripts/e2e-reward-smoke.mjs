/**
 * On-chain E2E: LaunchRouter → recipient=RewardRouter → buy → sweep → harvest → allocate → claim → sell.
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
  "function isLaunch(address token) view returns (bool)",
]);
const rewardAbi = parseAbi([
  "function sweepPonsCurveFees(address curve, uint256 minBuybackTokensOut)",
  "function harvestPonsFees() returns (uint256)",
  "function unallocatedEth() view returns (uint256)",
  "function allocate(address token, uint256 amount)",
  "function creatorAccrued(address token) view returns (uint256)",
  "function creatorPaid(address token) view returns (uint256)",
  "function luckyBoxRewardAccrued(address token) view returns (uint256)",
  "function burnBudgetAccrued() view returns (uint256)",
  "function claimCreator(address token) returns (uint256)",
  "function ponsEscrowClaimable() view returns (uint256)",
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

async function main() {
  const env = loadEnv(BACKEND_ENV);
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk) throw new Error("KEEPER_PRIVATE_KEY missing");
  if (!pk.startsWith("0x")) pk = `0x${pk}`;

  const rpc = env.RPC_HTTP_URL;
  const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const launchRouter = getAddress(env.LOOTING_LAUNCH_ROUTER);
  const rewardRouter = getAddress(env.LOOTING_REWARD_ROUTER);
  const registry = getAddress(env.LAUNCH_REGISTRY_ADDRESS);
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

  const bal0 = await publicClient.getBalance({ address: account.address });
  console.log({ wallet: account.address, balance: formatEther(bal0), launchRouter, rewardRouter });

  const [launchFee, canLaunch, expectedEconomics] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "canLaunch", args: [account.address] }),
    publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "previewLaunchEconomics",
      args: [0n, ZERO],
    }),
  ]);
  check("wallet canLaunch", canLaunch === true);

  const stamp = Date.now().toString().slice(-6);
  const params = {
    name: `E2E Sweep ${stamp}`,
    symbol: `SW${stamp.slice(-4)}`,
    logo: "https://lootingpad.com/logo.png",
    description: "e2e sweep path",
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    creatorFeeRecipient: account.address, // overwritten by router
    creatorTaxBps: 100,
    buybackEnabled: true, // overwritten to false
    expectedEconomics,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };

  const launchTx = await walletClient.sendTransaction({
    to: launchRouter,
    data: encodeFunctionData({
      abi: launchRouterAbi,
      functionName: "launch",
      args: [params, 0n, ZERO],
    }),
    value: launchFee + parseEther("0.00035"),
  });
  console.log("launchTx", launchTx);
  const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchTx, timeout: 180_000 });
  check("launch tx success", launchReceipt.status === "success");

  let token;
  let curve;
  for (const log of launchReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: tokenLaunchedEvent, data: log.data, topics: log.topics });
      token = d.args.token;
      curve = d.args.curve;
    } catch {
      /* skip */
    }
  }
  check("parsed TokenLaunched", Boolean(token && curve), `token=${token} curve=${curve}`);

  const record = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  check(
    "creatorFeeRecipient = RewardRouter",
    record.creatorFeeRecipient.toLowerCase() === rewardRouter.toLowerCase(),
    `got=${record.creatorFeeRecipient}`,
  );
  check("buybackEnabled = false", record.buybackEnabled === false);

  const regTx = await walletClient.writeContract({
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
  });
  await publicClient.waitForTransactionReceipt({ hash: regTx, timeout: 180_000 });
  check("registry.isLaunch", await publicClient.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "isLaunch",
    args: [token],
  }));

  const buyAmount = parseEther("0.00015");
  const buyTx = await walletClient.writeContract({
    address: curve,
    abi: curveAbi,
    functionName: "buy",
    args: [buyAmount, 0n, account.address],
    value: buyAmount,
  });
  console.log("buyTx", buyTx);
  await publicClient.waitForTransactionReceipt({ hash: buyTx, timeout: 180_000 });

  const taxBal = await publicClient.readContract({
    address: curve,
    abi: curveAbi,
    functionName: "creatorTaxBalance",
  });
  const feeBal = await publicClient.readContract({
    address: curve,
    abi: curveAbi,
    functionName: "quoteFeeBalance",
  });
  check("fees accrued on curve", taxBal + feeBal > 0n, `tax=${taxBal} fee=${feeBal}`);

  const sweepTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "sweepPonsCurveFees",
    args: [curve, 0n],
  });
  console.log("sweepTx", sweepTx);
  await publicClient.waitForTransactionReceipt({ hash: sweepTx, timeout: 180_000 });

  const escrow = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "ponsEscrowClaimable",
  });
  check("escrow credited after sweep", escrow > 0n, `escrow=${escrow}`);

  const harvestTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "harvestPonsFees",
  });
  console.log("harvestTx", harvestTx);
  await publicClient.waitForTransactionReceipt({ hash: harvestTx, timeout: 180_000 });
  const unalloc = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "unallocatedEth",
  });
  check("harvest → unallocatedEth", unalloc > 0n, `unalloc=${unalloc}`);

  const allocTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "allocate",
    args: [token, unalloc],
  });
  await publicClient.waitForTransactionReceipt({ hash: allocTx, timeout: 180_000 });
  const creatorAccrued = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "creatorAccrued",
    args: [token],
  });
  const boxAccrued = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "luckyBoxRewardAccrued",
    args: [token],
  });
  check("allocate split", creatorAccrued > 0n && boxAccrued > 0n, `creator=${creatorAccrued} box=${boxAccrued}`);

  const claimTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "claimCreator",
    args: [token],
  });
  await publicClient.waitForTransactionReceipt({ hash: claimTx, timeout: 180_000 });
  const paid = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardAbi,
    functionName: "creatorPaid",
    args: [token],
  });
  check("claimCreator", paid === creatorAccrued, `paid=${paid}`);

  const bal = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (bal > 0n) {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [curve, bal],
      }),
      timeout: 180_000,
    });
    const sellTx = await walletClient.writeContract({
      address: curve,
      abi: curveAbi,
      functionName: "sell",
      args: [bal, 0n, account.address],
    });
    const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellTx, timeout: 180_000 });
    const left = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    check("full sell exit", sellReceipt.status === "success" && left === 0n, `left=${left}`);
  } else {
    check("full sell exit", false, "no tokens");
  }

  const report = {
    at: new Date().toISOString(),
    model: "sweep-harvest-allocate",
    launchRouter,
    rewardRouter,
    token,
    curve,
    results,
    summary: {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    notes: [
      "creatorFeeRecipient = RewardRouter, buybackEnabled=false",
      "path: trade → sweepPonsCurveFees → harvestPonsFees → allocate → claimCreator",
    ],
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log("wrote", REPORT_PATH);
  console.log(report.summary);
  if (report.summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
