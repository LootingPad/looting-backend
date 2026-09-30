/**
 * Deploy LootingRewardRouter + LootingLuckyBoxEthModule, wire module + LaunchRouter.
 * Uses backend .env KEEPER_PRIVATE_KEY. Does not print the private key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, http, getAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_ROOT = resolve(__dirname, "../../../smart-contract/looting-smart-contract");
const BACKEND_ENV = resolve(__dirname, "../.env");
const ROUTER_ARTIFACT = resolve(CONTRACT_ROOT, "out/LootingRewardRouter.sol/LootingRewardRouter.json");
const MODULE_ARTIFACT = resolve(CONTRACT_ROOT, "out/LootingLuckyBoxEthModule.sol/LootingLuckyBoxEthModule.json");
const DEPLOYMENTS = resolve(CONTRACT_ROOT, "deployments/4663.json");

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

function upsertEnv(path, key, value) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`) || line.startsWith(`# ${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${value}`);
  }
  writeFileSync(path, next.join("\n").replace(/\n+$/, "\n"));
}

const robinhood = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};

const rewardRouterWriteAbi = parseAbi([
  "function setLuckyBoxModule(address module)",
  "function setPonsFeeEscrow(address escrow)",
  "function luckyBoxModule() view returns (address)",
  "function ponsFeeEscrow() view returns (address)",
]);

const launchRouterWriteAbi = parseAbi([
  "function setRewardRouter(address newRouter)",
  "function rewardRouter() view returns (address)",
]);

async function main() {
  const env = loadEnv(BACKEND_ENV);
  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (!pk) throw new Error("KEEPER_PRIVATE_KEY missing");
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const rpc = env.RPC_HTTP_URL;
  if (!rpc) throw new Error("RPC_HTTP_URL missing");

  const admin = getAddress("0x28b14bF827b10D2037fdc367a1f86434069D5E50");
  const keeper = admin;
  const pauser = admin;
  const registry = getAddress(env.LAUNCH_REGISTRY_ADDRESS || "0xe39493f3aef4fbA076d7c8B60F8b23fA7e2848fe");
  const burnWallet = getAddress(env.BURN_WALLET || env.LAUNCH_FEE_WALLET || "0xD712570969461D9f736a76e290a4Ee700509a59B");
  const launchRouter = getAddress(env.LOOTING_LAUNCH_ROUTER || "0x96C7e2B5715EBAC72122e2c7c96a5aF94976c303");
  const ponsFeeEscrow = getAddress(env.PONS_FEE_ESCROW || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e");

  const account = privateKeyToAccount(pk);
  console.log("deployer", account.address);
  console.log("admin", admin);
  console.log("registry", registry);
  console.log("burnWallet", burnWallet);
  console.log("launchRouter", launchRouter);
  console.log("ponsFeeEscrow", ponsFeeEscrow);

  if (account.address.toLowerCase() !== admin.toLowerCase()) {
    throw new Error(`deployer ${account.address} != admin ${admin}; need admin key for setRewardRouter`);
  }

  const chain = { ...robinhood, rpcUrls: { default: { http: [rpc] } } };
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

  const chainId = await publicClient.getChainId();
  if (chainId !== 4663) throw new Error(`unexpected chainId ${chainId}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log("balanceWei", balance.toString());

  const routerArtifact = JSON.parse(readFileSync(ROUTER_ARTIFACT, "utf8"));
  const moduleArtifact = JSON.parse(readFileSync(MODULE_ARTIFACT, "utf8"));

  const routerTx = await walletClient.deployContract({
    abi: routerArtifact.abi,
    bytecode: routerArtifact.bytecode.object,
    args: [admin, keeper, pauser, registry, burnWallet],
  });
  console.log("rewardRouterTx", routerTx);
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerTx, timeout: 180_000 });
  if (routerReceipt.status !== "success" || !routerReceipt.contractAddress) {
    throw new Error(`RewardRouter deploy failed status=${routerReceipt.status}`);
  }
  const rewardRouter = getAddress(routerReceipt.contractAddress);
  console.log("LootingRewardRouter", rewardRouter);

  const moduleTx = await walletClient.deployContract({
    abi: moduleArtifact.abi,
    bytecode: moduleArtifact.bytecode.object,
    args: [admin, keeper, rewardRouter],
  });
  console.log("ethModuleTx", moduleTx);
  const moduleReceipt = await publicClient.waitForTransactionReceipt({ hash: moduleTx, timeout: 180_000 });
  if (moduleReceipt.status !== "success" || !moduleReceipt.contractAddress) {
    throw new Error(`EthModule deploy failed status=${moduleReceipt.status}`);
  }
  const ethModule = getAddress(moduleReceipt.contractAddress);
  console.log("LootingLuckyBoxEthModule", ethModule);

  const setModuleTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardRouterWriteAbi,
    functionName: "setLuckyBoxModule",
    args: [ethModule],
  });
  console.log("setLuckyBoxModuleTx", setModuleTx);
  await publicClient.waitForTransactionReceipt({ hash: setModuleTx, timeout: 180_000 });

  const setEscrowTx = await walletClient.writeContract({
    address: rewardRouter,
    abi: rewardRouterWriteAbi,
    functionName: "setPonsFeeEscrow",
    args: [ponsFeeEscrow],
  });
  console.log("setPonsFeeEscrowTx", setEscrowTx);
  await publicClient.waitForTransactionReceipt({ hash: setEscrowTx, timeout: 180_000 });

  const setRouterTx = await walletClient.writeContract({
    address: launchRouter,
    abi: launchRouterWriteAbi,
    functionName: "setRewardRouter",
    args: [rewardRouter],
  });
  console.log("setRewardRouterTx", setRouterTx);
  await publicClient.waitForTransactionReceipt({ hash: setRouterTx, timeout: 180_000 });

  const wiredModule = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardRouterWriteAbi,
    functionName: "luckyBoxModule",
  });
  const wiredEscrow = await publicClient.readContract({
    address: rewardRouter,
    abi: rewardRouterWriteAbi,
    functionName: "ponsFeeEscrow",
  });
  const wiredRouter = await publicClient.readContract({
    address: launchRouter,
    abi: launchRouterWriteAbi,
    functionName: "rewardRouter",
  });
  console.log("verify luckyBoxModule", wiredModule);
  console.log("verify ponsFeeEscrow", wiredEscrow);
  console.log("verify launchRouter.rewardRouter", wiredRouter);

  const existing = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  existing.rewardRouter = rewardRouter;
  existing.rewardRouterDeployTx = routerTx;
  existing.rewardRouterDeployBlock = Number(routerReceipt.blockNumber);
  existing.luckyBoxEthModule = ethModule;
  existing.luckyBoxEthModuleDeployTx = moduleTx;
  existing.luckyBoxEthModuleDeployBlock = Number(moduleReceipt.blockNumber);
  existing.burnWallet = burnWallet;
  existing.ponsFeeEscrow = ponsFeeEscrow;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(existing, null, 2)}\n`);
  console.log("updated", DEPLOYMENTS);

  upsertEnv(BACKEND_ENV, "LOOTING_REWARD_ROUTER", rewardRouter);
  upsertEnv(BACKEND_ENV, "LOOTING_LUCKY_BOX_ETH_MODULE", ethModule);
  upsertEnv(BACKEND_ENV, "BURN_WALLET", burnWallet);
  upsertEnv(BACKEND_ENV, "PONS_FEE_ESCROW", ponsFeeEscrow);
  console.log("updated backend .env");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
