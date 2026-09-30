import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseEther,
  parseUnits,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { erc20Abi, factoryAbi, launchAndBuyAbi, launchRouterAbi } from "./abi.js";

const ZERO = zeroAddress;
const DEFAULT_LAUNCH_CONFIG_ID = 0n;
/** Optional launch-and-buy router (docs.ponsfamily.com/v2). */
export const PONS_LAUNCH_AND_BUY = getAddress("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948");
/** LOOTING cut of the create fee (total 0.00085 − Pons launchFee 0.0005). */
export const LOOTING_LAUNCH_FEE_REMAINDER_WEI = parseEther("0.00035");

export class LaunchPrepareError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type LaunchCall = {
  to: Address;
  data: Hex;
  value: string;
  /** Optional gas limit (hex or decimal string) so wallets can skip flaky estimateGas. */
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

export type PrepareLaunchInput = {
  wallet: Address;
  name: string;
  symbol: string;
  description?: string;
  logo?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  farcaster?: string;
  /** Creator tax in percent (e.g. 1 = 1%). */
  creatorTaxPercent: number;
  /** Lucky Box share of creator tax in percent of total tax (0–100). Stored off-chain. */
  luckyShare?: number;
  holderShareEnabled?: boolean;
  creatorFeeRecipient?: string;
  pair?: string;
  pairToken?: string;
  launchConfigId?: number;
  initialBuy?: string;
  exemptions?: string[];
  buybackEnabled?: boolean;
  salt?: Hex;
};

export type PrepareLaunchResult = {
  calls: LaunchCall[];
  /** Total create fee charged to the wallet (Pons + LOOTING remainder). */
  launchFeeWei: string;
  launchFeeEth: string;
  ponsFeeWei: string;
  lootingFeeWei: string;
  quoteInWei: string;
  pairToken: Address;
  launchConfigId: string;
  salt: Hex;
  expectedEconomics: Hex;
  /** On-chain creatorTaxBps — exactly the % the creator set. */
  creatorTaxBps: number;
  mode: "launch" | "launchAndBuy";
};

function cleanText(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function cleanHandle(value: string | undefined, max = 64): string {
  let text = cleanText(value, max).replace(/^@/, "");
  text = text
    .replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i, "")
    .replace(/^https?:\/\/(www\.)?t\.me\//i, "")
    .replace(/\/$/, "");
  return text.slice(0, max);
}

/** On-chain logo must stay short — never embed data: URLs. */
function sanitizeLogo(logo: string | undefined): string {
  const value = (logo ?? "").trim();
  if (!value) return "";
  if (value.startsWith("data:")) return "";
  if (value.length > 256) {
    throw new LaunchPrepareError("INVALID_LOGO", "Logo URI is too long.");
  }
  if (value.startsWith("ipfs://") || value.startsWith("ar://")) return value;
  if (value.startsWith("https://") || value.startsWith("http://")) {
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
        throw new LaunchPrepareError(
          "INVALID_LOGO",
          "Logo must be a public https:// URL (not localhost) so GMGN and other terminals can load it.",
        );
      }
    } catch (err) {
      if (err instanceof LaunchPrepareError) throw err;
      throw new LaunchPrepareError("INVALID_LOGO", "Logo must be an ipfs:// or https:// URI.");
    }
    return value;
  }
  throw new LaunchPrepareError("INVALID_LOGO", "Logo must be an ipfs:// or https:// URI.");
}

function resolvePairToken(pair: string | undefined, pairToken: string | undefined): Address {
  if (pairToken) {
    if (!isAddress(pairToken)) throw new LaunchPrepareError("INVALID_PAIR", "Invalid pair token.");
    return getAddress(pairToken);
  }
  const symbol = (pair ?? "ETH").trim().toUpperCase();
  if (!symbol || symbol === "ETH") return ZERO;
  throw new LaunchPrepareError(
    "PAIR_NOT_SUPPORTED",
    `${symbol} pairing is not available yet. Launch against ETH.`,
  );
}

function parseCreatorTaxBps(percent: number, maxBps: number): number {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new LaunchPrepareError("INVALID_TAX", "Creator tax must be 0 or greater.");
  }
  const bps = Math.round(percent * 100);
  if (bps > maxBps) {
    throw new LaunchPrepareError(
      "INVALID_TAX",
      `Creator tax cannot exceed ${maxBps / 100}%.`,
    );
  }
  return bps;
}

function parseOptionalAmount(amount: string | undefined, decimals: number): bigint {
  const clean = (amount ?? "").trim();
  if (!clean) return 0n;
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new LaunchPrepareError("INVALID_BUY", "Initial buy must be a positive number.");
  }
  try {
    const parsed = parseUnits(clean, decimals);
    if (parsed < 0n) throw new Error("neg");
    return parsed;
  } catch {
    throw new LaunchPrepareError("INVALID_BUY", "Initial buy must be a positive number.");
  }
}

function parseExemptions(list: string[] | undefined): Address[] {
  if (!list?.length) return [];
  if (list.length > 32) {
    throw new LaunchPrepareError("EXEMPTION_LIMIT", "Up to 32 exemption wallets.");
  }
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const value = raw.trim();
    if (!isAddress(value)) {
      throw new LaunchPrepareError("INVALID_EXEMPTION", "Exemption wallets need a full 0x address.");
    }
    const addr = getAddress(value);
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function weiToEthString(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function preparePonsLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
  const name = cleanText(input.name, 32);
  const symbol = cleanText(input.symbol, 10).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (name.length < 2) throw new LaunchPrepareError("INVALID_NAME", "Name needs at least 2 characters.");
  if (symbol.length < 2 || symbol.length > 10) {
    throw new LaunchPrepareError("INVALID_SYMBOL", "Ticker needs 2–10 letters or numbers.");
  }
  const description = cleanText(input.description, 256);
  if (/https?:\/\/|www\./i.test(description)) {
    throw new LaunchPrepareError("INVALID_DESCRIPTION", "Description can't include links.");
  }

  const wallet = getAddress(input.wallet);
  const pairToken = resolvePairToken(input.pair, input.pairToken);
  const native = pairToken === ZERO;
  const logo = sanitizeLogo(input.logo);
  const exemptions = parseExemptions(input.exemptions);
  const launchConfigId =
    input.launchConfigId != null ? BigInt(input.launchConfigId) : DEFAULT_LAUNCH_CONFIG_ID;
  const feeWallet = getAddress(env.LAUNCH_FEE_WALLET);
  const lootingFee = LOOTING_LAUNCH_FEE_REMAINDER_WEI;

  // Pons creator tax → RewardRouter (forced by LaunchRouter). Buyback off so keeper can sweepFees.
  let feeRecipient: Address = wallet;
  if (env.LOOTING_REWARD_ROUTER) {
    feeRecipient = getAddress(env.LOOTING_REWARD_ROUTER);
  } else if (input.creatorFeeRecipient?.trim()) {
    if (!isAddress(input.creatorFeeRecipient)) {
      throw new LaunchPrepareError("INVALID_RECIPIENT", "Creator wallet needs a full 0x address.");
    }
    feeRecipient = getAddress(input.creatorFeeRecipient);
  }

  const factory = getAddress(env.PONS_V2_FACTORY);
  const client = getPublicClient();

  const [launchFee, maxTax, canLaunch, config, expectedEconomics, pairApproved, pairEcon, allowance] =
    await Promise.all([
      client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
      client.readContract({ address: factory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
      client.readContract({ address: factory, abi: factoryAbi, functionName: "canLaunch", args: [wallet] }),
      client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "getLaunchConfig",
        args: [launchConfigId],
      }),
      client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "previewLaunchEconomics",
        args: [launchConfigId, pairToken],
      }),
      native
        ? Promise.resolve(true)
        : client.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: "approvedPairTokens",
            args: [pairToken],
          }),
      native
        ? Promise.resolve([0n, 0n, 18] as const)
        : client.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: "pairTokenEconomics",
            args: [pairToken],
          }),
      !native
        ? client.readContract({
            address: pairToken,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet, PONS_LAUNCH_AND_BUY],
          })
        : Promise.resolve(0n),
    ]);

  if (!canLaunch) {
    throw new LaunchPrepareError("LAUNCH_DISABLED", "Launches are closed for this wallet right now.");
  }
  if (!config.enabled) {
    throw new LaunchPrepareError("CONFIG_DISABLED", "This launch config is disabled.");
  }
  if (!native && !pairApproved) {
    throw new LaunchPrepareError("PAIR_NOT_APPROVED", "This quote asset is not approved on Pons.");
  }

  const creatorTaxBps = parseCreatorTaxBps(input.creatorTaxPercent, Number(maxTax));
  const quoteDecimals = native ? 18 : Number(pairEcon[2] || 18);
  const quoteIn = parseOptionalAmount(input.initialBuy, quoteDecimals);
  const salt =
    input.salt && /^0x[a-fA-F0-9]{64}$/.test(input.salt)
      ? (input.salt as Hex)
      : (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);

  const params = {
    name,
    symbol,
    logo,
    description,
    socials: {
      twitter: cleanHandle(input.twitter),
      telegram: cleanHandle(input.telegram),
      discord: cleanText(input.discord, 128),
      website: cleanText(input.website, 128),
      farcaster: cleanHandle(input.farcaster),
    },
    creatorFeeRecipient: feeRecipient,
    creatorTaxBps,
    buybackEnabled: false, // recipient sweepFees path — Pons operator not required
    expectedEconomics,
    salt,
  };

  const calls: LaunchCall[] = [];
  let mode: "launch" | "launchAndBuy" = "launch";
  let ponsValue = launchFee;
  let launchData: Hex;
  let launchTarget: Address = factory;
  const routerAddr = env.LOOTING_LAUNCH_ROUTER?.trim()
    ? getAddress(env.LOOTING_LAUNCH_ROUTER)
    : null;
  /** One-confirm path: router collects LOOTING fee then calls Pons. Not used for launchAndBuy yet. */
  const useRouter = Boolean(routerAddr) && quoteIn === 0n;

  if (quoteIn > 0n) {
    mode = "launchAndBuy";
    if (feeRecipient === ZERO) {
      throw new LaunchPrepareError(
        "INVALID_RECIPIENT",
        "Creator wallet is required when buying at launch.",
      );
    }
    if (!native) {
      if (allowance < quoteIn) {
        calls.push({
          to: pairToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [PONS_LAUNCH_AND_BUY, quoteIn],
          }),
          value: "0",
        });
      }
    } else {
      ponsValue = launchFee + quoteIn;
    }
    launchTarget = PONS_LAUNCH_AND_BUY;
    launchData = encodeFunctionData({
      abi: launchAndBuyAbi,
      functionName: "launchAndBuy",
      args: [params, launchConfigId, pairToken, quoteIn, 0n, wallet, exemptions],
    });
  } else if (useRouter && routerAddr) {
    launchTarget = routerAddr;
    ponsValue = launchFee + lootingFee;
    if (exemptions.length > 0) {
      launchData = encodeFunctionData({
        abi: launchRouterAbi,
        functionName: "launch",
        args: [params, launchConfigId, pairToken, exemptions],
      });
    } else {
      launchData = encodeFunctionData({
        abi: launchRouterAbi,
        functionName: "launch",
        args: [params, launchConfigId, pairToken],
      });
    }
  } else if (exemptions.length > 0) {
    launchData = encodeFunctionData({
      abi: factoryAbi,
      functionName: "launchToken",
      args: [params, launchConfigId, pairToken, exemptions],
    });
  } else {
    launchData = encodeFunctionData({
      abi: factoryAbi,
      functionName: "launchToken",
      args: [params, launchConfigId, pairToken],
    });
  }

  // Prefer LootingLaunchRouter (one wallet confirm). Fallback: factory + separate fee tx.
  // Never Multicall3: Pons uses msg.sender as deployer.
  const launchCall: LaunchCall = {
    to: launchTarget,
    data: launchData,
    value: ponsValue.toString(),
  };

  // Prefill gas + EIP-1559 fees so MetaMask/Phantom can show a fee without failing estimate.
  try {
    const [gas, block, priority] = await Promise.all([
      client.estimateGas({
        account: wallet,
        to: launchTarget,
        data: launchData,
        value: ponsValue,
      }),
      client.getBlock({ blockTag: "latest" }),
      client.estimateMaxPriorityFeePerGas().catch(() => 1_000_000n),
    ]);
    const base = block.baseFeePerGas ?? 20_000_000n;
    const tip = priority > 0n ? priority : 1_000_000n;
    const maxFee = base * 2n + tip;
    launchCall.gas = ((gas * 120n) / 100n).toString();
    launchCall.maxPriorityFeePerGas = tip.toString();
    launchCall.maxFeePerGas = maxFee.toString();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/insufficient|fund|balance/i.test(message)) {
      throw new LaunchPrepareError(
        "INSUFFICIENT_FUNDS",
        "Wallet needs enough ETH for the launch fee (0.00085) plus gas.",
      );
    }
    launchCall.gas = useRouter ? "5000000" : "4500000";
  }

  calls.push(launchCall);

  if (!useRouter) {
    const feeCall: LaunchCall = {
      to: feeWallet,
      data: "0x",
      value: lootingFee.toString(),
      gas: "21000",
    };
    if (launchCall.maxFeePerGas) {
      feeCall.maxFeePerGas = launchCall.maxFeePerGas;
      feeCall.maxPriorityFeePerGas = launchCall.maxPriorityFeePerGas;
    }
    calls.push(feeCall);
  }

  const totalFee = launchFee + lootingFee;
  return {
    calls,
    launchFeeWei: totalFee.toString(),
    launchFeeEth: weiToEthString(totalFee),
    ponsFeeWei: launchFee.toString(),
    lootingFeeWei: lootingFee.toString(),
    quoteInWei: quoteIn.toString(),
    pairToken,
    launchConfigId: launchConfigId.toString(),
    salt,
    expectedEconomics,
    creatorTaxBps,
    mode,
  };
}
