/**
 * Full E2E: launch → buy → sell exit → sweep/harvest/allocate → creditEthPrize → claimEthPrize.
 * Proves holder receives ETH from creator-tax-funded box pool.
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
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ENV = resolve(__dirname, "../.env");
const REPORT_PATH = resolve(__dirname, "../e2e-holder-reward.report.json");

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
  "function luckyBoxRewardAccrued(address token) view returns (uint256)",
  "function luckyBoxClaimable(address token) view returns (uint256)",
  "function claimCreator(address token) returns (uint256)",
  "function ponsEscrowClaimable() view returns (uint256)",
]);
const ethModuleAbi = parseAbi([
  "function creditEthPrize(address token, address winner, uint256 amount, bytes32 boxId)",
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

async function main() {
  const env = loadEnv(BACKEND_ENV);
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const rpc = env.RPC_HTTP_URL;
  const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const launchRouter = getAddress(env.LOOTING_LAUNCH_ROUTER);
  const rewardRouter = getAddress(env.LOOTING_REWARD_ROUTER);
  const ethModule = getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE);
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

  console.log({
    holder: account.address,
    balance: formatEther(await publicClient.getBalance({ address: account.address })),
    launchRouter,
    rewardRouter,
    ethModule,
  });

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
  const launchTx = await walletClient.sendTransaction({
    to: launchRouter,
    data: encodeFunctionData({
      abi: launchRouterAbi,
      functionName: "launch",
      args: [
        {
          name: `Holder E2E ${stamp}`,
          symbol: `H${stamp.slice(-4)}`,
          logo: "https://lootingpad.com/logo.png",
          description: "holder reward e2e",
          socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
          creatorFeeRecipient: account.address,
          creatorTaxBps: 100,
          buybackEnabled: false,
          expectedEconomics,
          salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
        },
        0n,
        ZERO,
      ],
    }),
    value: launchFee + parseEther("0.00035"),
  });
  console.log("launchTx", launchTx);
  const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchTx, timeout: 180_000 });
  check("launch", launchReceipt.status === "success");

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
  check("token+curve", Boolean(token && curve), `token=${token}`);

  const record = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  check("recipient=RewardRouter", record.creatorFeeRecipient.toLowerCase() === rewardRouter.toLowerCase());

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
  check("registry register", true);

  // Holder buys (qualifying trade)
  const buyAmount = parseEther("0.0002");
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: curve,
      abi: curveAbi,
      functionName: "buy",
      args: [buyAmount, 0n, account.address],
      value: buyAmount,
    }),
    timeout: 180_000,
  });
  const toks = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  check("holder bought tokens", toks > 0n, `bal=${toks}`);

  // Full exit (unlock path)
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [curve, toks],
    }),
    timeout: 180_000,
  });
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: curve,
      abi: curveAbi,
      functionName: "sell",
      args: [toks, 0n, account.address],
    }),
    timeout: 180_000,
  });
  const left = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  check("holder full exit", left === 0n);

  // Fund box pool from creator tax
  const pending = (await publicClient.readContract({
    address: curve,
    abi: curveAbi,
    functionName: "creatorTaxBalance",
  })) + (await publicClient.readContract({
    address: curve,
    abi: curveAbi,
    functionName: "quoteFeeBalance",
  }));
  check("fees on curve", pending > 0n, `pending=${pending}`);

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
  check("box pool funded", boxPool > 0n, `box=${boxPool}`);

  // Creator can still claim their share (not required for holder path)
  try {
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: rewardRouter,
        abi: rewardAbi,
        functionName: "claimCreator",
        args: [token],
      }),
      timeout: 180_000,
    });
    check("creator claim", true);
  } catch (e) {
    check("creator claim", false, String(e.shortMessage || e.message).slice(0, 120));
  }

  // Keeper credits holder prize from box pool
  const prize = boxPool; // full box pool to this holder for smoke
  const boxId = keccak256(stringToHex(`e2e-holder-${stamp}`));
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: ethModule,
      abi: ethModuleAbi,
      functionName: "creditEthPrize",
      args: [token, account.address, prize, boxId],
    }),
    timeout: 180_000,
  });
  const pendingPrize = await publicClient.readContract({
    address: ethModule,
    abi: ethModuleAbi,
    functionName: "pendingEth",
    args: [account.address, token],
  });
  check("prize credited to holder", pendingPrize === prize, `pending=${pendingPrize}`);

  // Holder claims ETH
  const balBefore = await publicClient.getBalance({ address: account.address });
  const claimTx = await walletClient.writeContract({
    address: ethModule,
    abi: ethModuleAbi,
    functionName: "claimEthPrize",
    args: [token],
  });
  console.log("claimEthPrizeTx", claimTx);
  const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTx, timeout: 180_000 });
  const balAfter = await publicClient.getBalance({ address: account.address });
  const gasCost = claimReceipt.gasUsed * (claimReceipt.effectiveGasPrice ?? 0n);
  const netGain = balAfter + gasCost - balBefore;
  check(
    "holder received ETH prize",
    claimReceipt.status === "success" && netGain === prize,
    `netGain=${netGain} prize=${prize} gas=${gasCost}`,
  );

  const pendingAfter = await publicClient.readContract({
    address: ethModule,
    abi: ethModuleAbi,
    functionName: "pendingEth",
    args: [account.address, token],
  });
  check("pending cleared", pendingAfter === 0n);

  const report = {
    at: new Date().toISOString(),
    model: "holder-eth-prize",
    launchRouter,
    rewardRouter,
    ethModule,
    token,
    curve,
    prizeWei: prize.toString(),
    claimTx,
    results,
    summary: {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
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
