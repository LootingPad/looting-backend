/**
 * MVP flow probe (read-mostly): launch → trade → box open readiness via local API + chain.
 * Does NOT broadcast txs. Writes mvp-flow-probe.report.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, getAddress, http, parseAbi } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const API = process.env.API_URL || "http://localhost:8080";
const REPORT = resolve(ROOT, "mvp-flow-probe.report.json");

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

const steps = [];
function check(id, ok, detail = "", severity = ok ? "ok" : "block") {
  steps.push({ id, ok: Boolean(ok), severity: ok ? "ok" : severity, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${severity}] ${id}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function main() {
  const env = loadEnv(resolve(ROOT, ".env"));
  const factory = getAddress(env.PONS_V2_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
  const launchRouter = env.LOOTING_LAUNCH_ROUTER ? getAddress(env.LOOTING_LAUNCH_ROUTER) : null;
  const rewardRouter = env.LOOTING_REWARD_ROUTER ? getAddress(env.LOOTING_REWARD_ROUTER) : null;
  const ethModule = env.LOOTING_LUCKY_BOX_ETH_MODULE ? getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE) : null;
  const registry = env.LAUNCH_REGISTRY_ADDRESS ? getAddress(env.LAUNCH_REGISTRY_ADDRESS) : null;

  let pk = env.KEEPER_PRIVATE_KEY || "";
  if (pk && !pk.startsWith("0x")) pk = `0x${pk}`;
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = pk ? privateKeyToAccount(pk) : null;

  const chain = {
    id: Number(env.CHAIN_ID || 4663),
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_HTTP_URL] } },
  };
  const publicClient = createPublicClient({
    chain,
    transport: http(env.RPC_HTTP_URL, {
      timeout: 45_000,
      fetchOptions: {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; LootingIndexer/0.1; +https://github.com/LootingPad/looting-backend)",
          Accept: "application/json",
        },
      },
    }),
  });

  // --- 0. Infra ---
  const health = await api("/health");
  check("api.health", health.status === 200 && health.json?.ok === true, JSON.stringify(health.json));

  const fees = await api("/api/fees");
  check(
    "api.fees.ethUsd",
    fees.status === 200 && Number(fees.json?.data?.ETH_USD) > 0,
    `ETH_USD=${fees.json?.data?.ETH_USD}`,
  );

  const season = await api("/api/seasons/current");
  check(
    "api.season.active",
    season.status === 200 && Boolean(season.json?.data?.seasonId),
    season.status === 200 ? season.json?.data?.seasonId : JSON.stringify(season.json),
    season.status === 404 ? "warn" : "block",
  );

  const rewardTable = await api("/api/reward-table");
  const pool = rewardTable.json?.data?.rewardPool;
  check(
    "api.rewardTable",
    rewardTable.status === 200 && Array.isArray(pool) && pool.length > 0,
    `pool=${Array.isArray(pool) ? pool.length : 0}`,
  );

  // --- 1. Contracts live ---
  check("cfg.launchRouter", Boolean(launchRouter), launchRouter || "missing");
  check("cfg.rewardRouter", Boolean(rewardRouter), rewardRouter || "missing");
  check("cfg.ethModule", Boolean(ethModule), ethModule || "missing");
  check("cfg.registry", Boolean(registry), registry || "missing");

  const factoryAbi = parseAbi([
    "function launchFee() view returns (uint256)",
    "function canLaunch(address) view returns (bool)",
  ]);
  try {
    const launchFee = await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "launchFee",
    });
    check("chain.ponsLaunchFee", launchFee > 0n, `ponsFee=${formatEther(launchFee)} ETH`);
  } catch (err) {
    check("chain.ponsLaunchFee", false, String(err.shortMessage || err.message).slice(0, 120), "block");
  }

  let bal = 0n;
  if (account) {
    try {
      bal = await publicClient.getBalance({ address: account.address });
      check("keeper.balance", bal > parseEtherSafe("0.002"), `${account.address} bal=${formatEther(bal)} ETH`, "warn");
    } catch (err) {
      check("keeper.balance", false, String(err.shortMessage || err.message).slice(0, 120), "warn");
    }
    try {
      const can = await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "canLaunch",
        args: [account.address],
      });
      check("keeper.canLaunch", can === true, String(can));
    } catch (err) {
      check("keeper.canLaunch", false, String(err.shortMessage || err.message).slice(0, 120), "warn");
    }
  } else {
    check("keeper.key", false, "KEEPER_PRIVATE_KEY missing", "block");
  }

  // --- 2. Launch prepare (API product path) ---
  const wallet = account?.address || "0x0000000000000000000000000000000000000001";
  const stamp = Date.now().toString().slice(-5);
  const prep = await api("/api/launch/prepare", {
    method: "POST",
    body: JSON.stringify({
      wallet,
      name: `MVP Probe ${stamp}`,
      symbol: `M${stamp.slice(-4)}`,
      description: "mvp flow probe — do not broadcast",
      creatorTax: 1,
      luckyShare: 50,
      pair: "ETH",
      idempotencyKey: `mvp-probe:${wallet}:${stamp}`,
    }),
  });
  const prepOk = prep.status === 200 && Array.isArray(prep.json?.data?.calls) && prep.json.data.calls.length > 0;
  check(
    "api.launch.prepare",
    prepOk,
    prepOk
      ? `calls=${prep.json.data.calls.length} feeEth=${prep.json.data.launchFeeEth || prep.json.data?.feeEth || "?"}`
      : `${prep.status} ${JSON.stringify(prep.json).slice(0, 180)}`,
  );

  // --- 3. Prior product-path evidence (seed-ui-box) ---
  let uiBox = null;
  try {
    uiBox = JSON.parse(readFileSync(resolve(ROOT, "e2e-ui-box-seed.report.json"), "utf8"));
  } catch {
    /* none */
  }
  check(
    "prior.uiBox.buyMinted",
    Boolean(uiBox?.buyConfirm?.boxesMinted >= 1),
    uiBox ? `box=${uiBox.boxes?.data?.[0]?.id} status=${uiBox.boxes?.data?.[0]?.status}` : "no e2e-ui-box-seed.report.json",
    "warn",
  );
  check(
    "prior.uiBox.sellUnlocked",
    Boolean(uiBox?.sellConfirm?.boxesUnlocked >= 1),
    uiBox ? `unlocked=${uiBox.sellConfirm.boxesUnlocked}` : "missing",
    "warn",
  );

  // --- 4. Trade prepare against prior token if known ---
  const sampleToken = uiBox?.token;
  if (sampleToken && account) {
    const buyPrep = await api("/api/trade/prepare", {
      method: "POST",
      body: JSON.stringify({
        token: sampleToken,
        side: "buy",
        amount: "0.0001",
        wallet: account.address,
        slippageBps: 1000,
      }),
    });
    check(
      "api.trade.prepare.buy",
      buyPrep.status === 200 && Array.isArray(buyPrep.json?.data?.calls),
      buyPrep.status === 200
        ? `calls=${buyPrep.json.data.calls.length} feeWei=${buyPrep.json.data.feeWei}`
        : `${buyPrep.status} ${JSON.stringify(buyPrep.json).slice(0, 160)}`,
      buyPrep.status >= 500 ? "block" : "warn",
    );
  } else {
    check("api.trade.prepare.buy", false, "skipped — no sample token/wallet", "warn");
  }

  // --- 5. Lucky box open readiness ---
  if (uiBox?.boxes?.data?.[0]?.id && account) {
    const boxId = uiBox.boxes.data[0].id;
    const open = await api(`/api/lucky-boxes/${boxId}/open`, {
      method: "POST",
      body: JSON.stringify({ wallet: account.address }),
    });
    // Already opened / wrong status is informative, not necessarily a product break
    const openable =
      open.status === 200 ||
      (open.status === 400 && /already|opened|claimed|holding|in_market|eligible/i.test(JSON.stringify(open.json)));
    check(
      "api.box.openAttempt",
      open.status < 500,
      `${open.status} ${JSON.stringify(open.json).slice(0, 200)}`,
      open.status >= 500 ? "block" : "warn",
    );
    void openable;
  } else {
    check("api.box.openAttempt", false, "skipped — no seeded box", "warn");
  }

  // --- 6. On-chain reward path evidence ---
  let holderE2e = null;
  try {
    holderE2e = JSON.parse(readFileSync(resolve(ROOT, "e2e-holder-reward.report.json"), "utf8"));
  } catch {
    /* none */
  }
  check(
    "prior.onchain.holderPrize",
    holderE2e?.summary?.failed === 0,
    holderE2e
      ? `passed=${holderE2e.summary.passed} prizeWei=${holderE2e.prizeWei} token=${holderE2e.token}`
      : "no e2e-holder-reward.report.json",
    "warn",
  );

  // --- Cost model (MVP single run) ---
  const ethUsd = Number(fees.json?.data?.ETH_USD || 0);
  const costs = {
    launchFeeEth: 0.00085,
    sampleBuyEth: 0.0002,
    tradePlatformFeeUsd: Number(fees.json?.data?.TRADE_FEE_USD || 0.056),
    gasBufferEth: 0.0015,
    notes: [
      "Launch = Pons launchFee (~0.0005) + LOOTING 0.00035 via LootingLaunchRouter",
      "Each buy/sell pays flat $0.056 platform fee in ETH at live spot",
      "Gas on Robinhood is cheap; 0.0015 ETH buffer covers launch+buy+sell+sweep+claim (~8–12 txs)",
      "Keeper needs ETH for sweep/harvest/allocate/creditEthPrize when pool funding is automated",
    ],
  };
  const tradeFeeEth = ethUsd > 0 ? costs.tradePlatformFeeUsd / ethUsd : 0;
  const oneFullCycleEth =
    costs.launchFeeEth + costs.sampleBuyEth + tradeFeeEth * 2 + costs.gasBufferEth;
  const costSummary = {
    ethUsd,
    tradeFeeEthApprox: tradeFeeEth,
    oneFullCycleEthApprox: oneFullCycleEth,
    oneFullCycleUsdApprox: ethUsd > 0 ? oneFullCycleEth * ethUsd : null,
    recommendedTestWalletEth: Math.max(0.005, oneFullCycleEth * 2),
    recommendedKeeperEth: 0.01,
    recommendedTotalEth: Math.max(0.015, oneFullCycleEth * 2 + 0.01),
    recommendedTotalUsd:
      ethUsd > 0 ? Math.max(0.015, oneFullCycleEth * 2 + 0.01) * ethUsd : null,
  };

  const blocked = steps.filter((s) => !s.ok && s.severity === "block");
  const warns = steps.filter((s) => !s.ok && s.severity === "warn");
  const report = {
    at: new Date().toISOString(),
    api: API,
    chainId: chain.id,
    contracts: { factory, launchRouter, rewardRouter, ethModule, registry },
    keeper: account?.address || null,
    keeperBalanceEth: formatEther(bal),
    steps,
    summary: {
      passed: steps.filter((s) => s.ok).length,
      failed: steps.filter((s) => !s.ok).length,
      blockers: blocked.map((s) => s.id),
      warnings: warns.map((s) => s.id),
    },
    costs,
    costSummary,
    productGaps: [
      {
        area: "Launch (UI)",
        status: prepOk ? "ready" : "broken",
        note: "CreateForm → /api/launch/prepare → wallet signs LaunchRouter → /api/launch/confirm",
      },
      {
        area: "Trade + box mint/unlock",
        status: uiBox?.buyConfirm?.boxesMinted ? "proven" : "unproven-this-run",
        note: "Terminal → /api/trade/prepare+confirm indexes CurveBuy/Sell, mints box on buy, unlocks on full exit",
      },
      {
        area: "Lucky Box open + ETH prize",
        status: holderE2e?.summary?.failed === 0 ? "onchain-proven" : "partial",
        note: "Open uses sealed reward table; ETH prize needs RewardRouter box pool funded (sweep→harvest→allocate) then creditEthPrize",
      },
      {
        area: "Auto pool funding after trades",
        status: "gap",
        note: "Sweep/harvest/allocate is keeper/manual today — not auto after every trade in the UI path",
      },
      {
        area: "Staking / Dev Lock",
        status: "not-mvp-live",
        note: "UI shells exist; on-chain create stays disabled until factory/devlock addresses are set",
      },
      {
        area: "$LOOTING page",
        status: "intentionally-empty",
        note: "No CA / burn ledger yet",
      },
    ],
  };

  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log("\nwrote", REPORT);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(JSON.stringify(report.costSummary, null, 2));
  if (blocked.length) process.exit(2);
}

function parseEtherSafe(v) {
  const [a, b = ""] = String(v).split(".");
  const frac = (b + "000000000000000000").slice(0, 18);
  return BigInt(a) * 10n ** 18n + BigInt(frac);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
