import { createHash } from "node:crypto";
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { env } from "../config/env.js";
import { getKeeperWallet, getPublic } from "../clients/keeper.js";
import { quoteAndPrepareSwap } from "../clients/uniswap.js";
import { prisma } from "../db/prisma.js";
import type { RewardOutcome } from "../modules/config-public.js";

const ethModuleAbi = parseAbi([
  "function creditEthPrize(address token, address winner, uint256 amount, bytes32 boxId)",
  "function claimEthPrize(address token) returns (uint256 amount)",
]);

/**
 * Boxes that can still draw from the launch box pool (not yet opened / paid).
 * Includes the box currently being opened.
 */
export async function countOutstandingBoxes(launchId: string): Promise<number> {
  const n = await prisma.luckyBox.count({
    where: {
      launchId,
      openedAt: null,
      status: { in: ["exited", "unclaimed"] },
    },
  });
  return Math.max(1, n);
}

/** Deterministic uint in [0, mod) from digest hex + salt. */
function digestMod(digestHex: string, salt: string, mod: bigint): bigint {
  if (mod <= 0n) return 0n;
  const h = createHash("sha256").update(`${digestHex}:${salt}`).digest("hex");
  return BigInt(`0x${h.slice(0, 16)}`) % mod;
}

/**
 * Pool-safe random ETH spend for one win.
 * fairShare = pool / outstandingBoxes; amount ∈ [minShare, maxShare] of fairShare.
 */
export function rollPrizeAmountWei(opts: {
  poolWei: bigint;
  outstandingBoxes: number;
  outcome: RewardOutcome;
  digestHex: string;
}): bigint {
  if (opts.poolWei <= 0n) return 0n;
  if (opts.outcome.kind === "miss") return 0n;

  const n = BigInt(Math.max(1, opts.outstandingBoxes));
  const fairShare = opts.poolWei / n;
  if (fairShare <= 0n) return 0n;

  const minBps = BigInt(Math.min(10_000, Math.max(0, opts.outcome.minShareBps)));
  const maxBps = BigInt(Math.min(10_000, Math.max(Number(minBps), opts.outcome.maxShareBps)));

  const lo = (fairShare * minBps) / 10_000n;
  const hi = (fairShare * maxBps) / 10_000n;
  if (hi <= 0n) return 0n;
  if (hi <= lo) return hi > opts.poolWei ? opts.poolWei : hi;

  const span = hi - lo + 1n;
  const offset = digestMod(opts.digestHex, "prize-amount", span);
  const amount = lo + offset;
  return amount > opts.poolWei ? opts.poolWei : amount;
}

export type CreditResult = {
  creditTx: Hex | null;
  swapTx: Hex | null;
  swapOutput: bigint | null;
  /** Winner must claim ETH on-chain. */
  claimableOnChain: boolean;
  /** Prize delivered (ERC-20 sent, or ETH fallback sent, or miss). */
  settled: boolean;
  /** True when settle could not start (quote/module) — caller must NOT burn the box. */
  abortOpen: boolean;
  error?: string;
  prizeTokenLabel: string;
  /** eth if paid as ETH (including swap fallback). */
  paidAs: "eth" | "erc20" | "none";
};

function emptyResult(label: string, patch: Partial<CreditResult> = {}): CreditResult {
  return {
    creditTx: null,
    swapTx: null,
    swapOutput: null,
    claimableOnChain: false,
    settled: false,
    abortOpen: true,
    prizeTokenLabel: label,
    paidAs: "none",
    ...patch,
  };
}

/**
 * ETH prize: credit EthModule to the winner (user claims later).
 * ERC-20: quote first → pull → claim → swap; if swap fails after pull, send ETH to winner.
 */
export async function settlePrize(opts: {
  launchToken: string;
  winner: string;
  boxId: string;
  boxIdBytes32: Hex;
  amountWei: bigint;
  outcome: RewardOutcome;
}): Promise<CreditResult> {
  if (opts.amountWei <= 0n || opts.outcome.kind === "miss") {
    return emptyResult(opts.outcome.label, { settled: true, abortOpen: false, paidAs: "none" });
  }

  if (!env.LOOTING_LUCKY_BOX_ETH_MODULE || !env.LOOTING_REWARD_ROUTER) {
    return emptyResult(opts.outcome.label, { error: "MODULE_NOT_SET" });
  }

  const walletClient = getKeeperWallet();
  if (!walletClient?.account) {
    return emptyResult(opts.outcome.label, { error: "KEEPER_NOT_SET" });
  }
  // Re-bind after the null check so nested closures keep a non-null keeper type.
  const keeper = walletClient;
  const keeperAccount = walletClient.account;

  const module = getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE) as Address;
  const launchToken = getAddress(opts.launchToken) as Address;
  const winner = getAddress(opts.winner) as Address;

  if (opts.outcome.kind === "eth") {
    try {
      const creditTx = await keeper.writeContract({
        address: module,
        abi: ethModuleAbi,
        functionName: "creditEthPrize",
        args: [launchToken, winner, opts.amountWei, opts.boxIdBytes32],
        chain: keeper.chain,
        account: keeperAccount,
      });
      return {
        creditTx,
        swapTx: null,
        swapOutput: null,
        claimableOnChain: true,
        settled: false,
        abortOpen: false,
        prizeTokenLabel: "ETH",
        paidAs: "eth",
      };
    } catch (err) {
      console.warn("[lucky-box-prize] creditEthPrize failed", opts.boxId, err);
      return emptyResult("ETH", {
        error: err instanceof Error ? err.message : "credit failed",
      });
    }
  }

  if (!opts.outcome.prizeToken || !env.WETH_ADDRESS || !env.UNI_V3_SWAP_ROUTER) {
    return emptyResult(opts.outcome.label, { error: "ERC20_PATH_NOT_CONFIGURED" });
  }

  const prizeToken = getAddress(opts.outcome.prizeToken) as Address;
  const approved = await prisma.rewardPrizeToken.findFirst({
    where: { token: prizeToken.toLowerCase(), approved: true },
  });
  if (!approved) {
    return emptyResult(opts.outcome.label, { error: "PRIZE_TOKEN_NOT_APPROVED" });
  }

  const label = approved.label ?? prizeToken.slice(0, 8);

  /**
   * Prefer the configured prize token whenever a Uniswap route works.
   * Dust / no route / swap revert → ETH (claimable or sent), never leave the box stuck.
   */
  const MIN_ERC20_SWAP_WEI = 10n ** 14n; // 0.0001 ETH — below this, skip quote and pay ETH
  const tryErc20 = opts.amountWei >= MIN_ERC20_SWAP_WEI;

  let quote: Awaited<ReturnType<typeof quoteAndPrepareSwap>> | null = null;
  if (tryErc20) {
    try {
      quote = await quoteAndPrepareSwap({
        tokenIn: getAddress(env.WETH_ADDRESS) as Address,
        tokenOut: prizeToken,
        amountIn: opts.amountWei,
        recipient: winner,
        slippageBps: 500,
      });
      if (quote.amountOut <= 0n) quote = null;
    } catch (err) {
      console.warn("[lucky-box-prize] ERC-20 quote failed — will pay ETH", opts.boxId, err);
      quote = null;
    }
  } else {
    console.info("[lucky-box-prize] dust prize — pay ETH instead of ERC-20", opts.boxId, opts.amountWei.toString());
  }

  async function creditEthToWinner(reason: string): Promise<CreditResult> {
    const creditTx = await keeper.writeContract({
      address: module,
      abi: ethModuleAbi,
      functionName: "creditEthPrize",
      args: [launchToken, winner, opts.amountWei, opts.boxIdBytes32],
      chain: keeper.chain,
      account: keeperAccount,
    });
    return {
      creditTx,
      swapTx: null,
      swapOutput: null,
      claimableOnChain: true,
      settled: false,
      abortOpen: false,
      error: reason,
      prizeTokenLabel: "ETH",
      paidAs: "eth",
    };
  }

  if (!quote) {
    try {
      return await creditEthToWinner(
        tryErc20 ? "ERC20_QUOTE_FAILED_ETH_FALLBACK" : "ERC20_DUST_ETH_FALLBACK",
      );
    } catch (err) {
      console.warn("[lucky-box-prize] ETH fallback failed", opts.boxId, err);
      return emptyResult(label, {
        error: "Could not settle prize (no swap route and ETH credit failed).",
      });
    }
  }

  let creditTx: Hex | null = null;
  try {
    creditTx = await keeper.writeContract({
      address: module,
      abi: ethModuleAbi,
      functionName: "creditEthPrize",
      args: [launchToken, keeperAccount.address, opts.amountWei, opts.boxIdBytes32],
      chain: keeper.chain,
      account: keeperAccount,
    });
    await getPublic().waitForTransactionReceipt({ hash: creditTx });

    const claimTx = await keeper.writeContract({
      address: module,
      abi: ethModuleAbi,
      functionName: "claimEthPrize",
      args: [launchToken],
      chain: keeper.chain,
      account: keeperAccount,
    });
    await getPublic().waitForTransactionReceipt({ hash: claimTx });

    try {
      const swapTx = await keeper.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: quote.value,
        chain: keeper.chain,
        account: keeperAccount,
      });
      await getPublic().waitForTransactionReceipt({ hash: swapTx });
      return {
        creditTx,
        swapTx,
        swapOutput: quote.amountOut,
        claimableOnChain: false,
        settled: true,
        abortOpen: false,
        prizeTokenLabel: label,
        paidAs: "erc20",
      };
    } catch (swapErr) {
      console.warn("[lucky-box-prize] swap failed — ETH fallback to winner", opts.boxId, swapErr);
      const fallbackTx = await keeper.sendTransaction({
        to: winner,
        value: opts.amountWei,
        chain: keeper.chain,
        account: keeperAccount,
      });
      await getPublic().waitForTransactionReceipt({ hash: fallbackTx });
      return {
        creditTx,
        swapTx: fallbackTx,
        swapOutput: null,
        claimableOnChain: false,
        settled: true,
        abortOpen: false,
        error: "SWAP_FAILED_ETH_FALLBACK",
        prizeTokenLabel: "ETH",
        paidAs: "eth",
      };
    }
  } catch (err) {
    console.warn("[lucky-box-prize] ERC20 settle failed after quote", opts.boxId, err);
    // Pool may already be pulled — do not leave the box reopenable (would double-pull).
    return {
      creditTx,
      swapTx: null,
      swapOutput: null,
      claimableOnChain: false,
      settled: false,
      abortOpen: false,
      error: err instanceof Error ? err.message : "settle failed",
      prizeTokenLabel: label,
      paidAs: "none",
    };
  }
}

/** Encode claim call for UX (ETH prizes only). */
export function encodeClaimEthPrize(launchToken: Address): Hex {
  return encodeFunctionData({
    abi: ethModuleAbi,
    functionName: "claimEthPrize",
    args: [launchToken],
  });
}
