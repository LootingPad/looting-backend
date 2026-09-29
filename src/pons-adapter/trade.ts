import { encodeFunctionData, getAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { getPublicClient } from "../clients/rpc.js";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { FE_FEES } from "../lib/fe-shape.js";
import { curveAbi, erc20Abi } from "./abi.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const BPS = 10_000n;
/** Canonical Multicall3. One user transaction runs the curve trade and the fee transfer. */
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const multicall3Abi = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export class TradePrepareError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type TradeCall = {
  to: Address;
  data: Hex;
  value: string;
};

export function tradeFeeWei(ethUsd = FE_FEES.ETH_USD): bigint {
  const usd = BigInt(Math.round(FE_FEES.TRADE_FEE_USD * 1_000_000));
  const fx = BigInt(Math.round(ethUsd * 1_000_000));
  if (fx <= 0n) return 0n;
  return (usd * 10n ** 18n) / fx;
}

function parseHuman(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new TradePrepareError("INVALID_AMOUNT", "Enter an amount above 0.");
  }
  try {
    const parsed = parseUnits(clean, decimals);
    if (parsed <= 0n) throw new Error("zero");
    return parsed;
  } catch {
    throw new TradePrepareError("INVALID_AMOUNT", "Enter an amount above 0.");
  }
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(5_000, Math.max(0, Math.floor(slippageBps))));
  return (amount * (BPS - bps)) / BPS;
}

function quoteBuy(quoteIn: bigint, feeBps: bigint, taxBps: bigint, quoteReserve: bigint, tokenReserve: bigint, realQuote: bigint, threshold: bigint) {
  let gross = quoteIn;
  let net = gross - (gross * feeBps) / BPS - (gross * taxBps) / BPS;
  const room = threshold > realQuote ? threshold - realQuote : 0n;
  if (net > room && net > 0n) {
    gross = (room * quoteIn) / net;
    net = room;
  }
  if (net <= 0n || quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  const k = quoteReserve * tokenReserve;
  const newY = k / (quoteReserve + net);
  return tokenReserve > newY ? tokenReserve - newY : 0n;
}

function quoteSell(tokensIn: bigint, feeBps: bigint, taxBps: bigint, quoteReserve: bigint, tokenReserve: bigint) {
  if (tokensIn <= 0n || quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  const k = quoteReserve * tokenReserve;
  const newX = k / (tokenReserve + tokensIn);
  const gross = quoteReserve > newX ? quoteReserve - newX : 0n;
  const net = gross - (gross * feeBps) / BPS - (gross * taxBps) / BPS;
  return net > 0n ? net : 0n;
}

export async function prepareCurveTrade(input: {
  token: string;
  side: "buy" | "sell";
  amount: string;
  wallet: Address;
  slippageBps: number;
}): Promise<{ calls: TradeCall[]; feeWei: string; feeUsd: number }> {
  const token = input.token.toLowerCase();
  const row = await prisma.trenchPair.findFirst({
    where: { chainId: env.CHAIN_ID, token },
  });
  if (!row) throw new TradePrepareError("NOT_FOUND", "Token is not on the curve.");

  const curve = getAddress(row.curve);
  const pairToken = getAddress(row.pairToken);
  const native = pairToken.toLowerCase() === ZERO;
  const wallet = input.wallet;
  const client = getPublicClient();
  const spendToken = input.side === "sell" ? getAddress(row.token) : native ? null : pairToken;
  const spender = MULTICALL3;

  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: curve, abi: curveAbi, functionName: "graduated" },
      { address: curve, abi: curveAbi, functionName: "feeBps" },
      { address: curve, abi: curveAbi, functionName: "creatorTaxBps" },
      { address: curve, abi: curveAbi, functionName: "getReserves" },
      { address: curve, abi: curveAbi, functionName: "realQuoteReserve" },
      { address: curve, abi: curveAbi, functionName: "graduationThreshold" },
      { address: curve, abi: curveAbi, functionName: "pairDecimals" },
      ...(spendToken
        ? [{ address: spendToken, abi: erc20Abi, functionName: "allowance" as const, args: [wallet, spender] as const }]
        : []),
    ] as Parameters<typeof client.multicall>[0]["contracts"],
  });

  const graduated = results[0]?.status === "success" && results[0].result === true;
  if (graduated || row.chainPhase === "PoolCreated" || row.chainPhase === "Swept") {
    throw new TradePrepareError("CURVE_GRADUATED", "This token has already graduated.");
  }

  const feeBps = results[1]?.status === "success" ? (results[1].result as bigint) : 0n;
  const taxBps = results[2]?.status === "success" ? (results[2].result as bigint) : 0n;
  const reserves = results[3]?.status === "success" ? (results[3].result as readonly [bigint, bigint]) : null;
  const realQuote = results[4]?.status === "success" ? (results[4].result as bigint) : 0n;
  const threshold = results[5]?.status === "success" ? (results[5].result as bigint) : 0n;
  const pairDecimals = results[6]?.status === "success" ? Number(results[6].result) : 18;
  const allowance = results[7]?.status === "success" ? (results[7].result as bigint) : 0n;
  if (!reserves) throw new TradePrepareError("QUOTE_FAILED", "Could not read the curve.");

  const [quoteReserve, tokenReserve] = reserves;
  const quoteDecimals = native ? 18 : pairDecimals;
  const amountIn = parseHuman(input.amount, input.side === "buy" ? quoteDecimals : row.decimals);
  const fee = tradeFeeWei();
  const feeWallet = getAddress(env.TRADE_FEE_WALLET);
  let swap: { data: Hex; value: bigint };

  if (input.side === "buy") {
    const tokensOut = quoteBuy(amountIn, feeBps, taxBps, quoteReserve, tokenReserve, realQuote, threshold);
    if (tokensOut <= 0n) throw new TradePrepareError("QUOTE_FAILED", "This buy would not receive tokens.");
    swap = {
      data: encodeFunctionData({
        abi: curveAbi,
        functionName: "buy",
        args: [amountIn, applySlippage(tokensOut, input.slippageBps), wallet],
      }),
      value: native ? amountIn : 0n,
    };
  } else {
    const quoteOut = quoteSell(amountIn, feeBps, taxBps, quoteReserve, tokenReserve);
    if (native && quoteOut <= fee) {
      throw new TradePrepareError("FEE_EXCEEDS_OUTPUT", "Amount is below the $0.056 fee.");
    }
    if (quoteOut <= 0n) throw new TradePrepareError("QUOTE_FAILED", "This sell would not receive anything.");
    swap = {
      data: encodeFunctionData({
        abi: curveAbi,
        functionName: "sell",
        args: [amountIn, applySlippage(quoteOut, input.slippageBps), wallet],
      }),
      value: 0n,
    };
  }

  const calls: TradeCall[] = [];
  if (spendToken && allowance < amountIn) {
    calls.push({
      to: spendToken,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amountIn] }),
      value: "0",
    });
  }
  calls.push(bundleTradeAndFee(curve, swap.data, swap.value, feeWallet, fee));

  return {
    calls,
    feeWei: fee.toString(),
    feeUsd: FE_FEES.TRADE_FEE_USD,
  };
}

function bundleTradeAndFee(curve: Address, data: Hex, value: bigint, feeWallet: Address, fee: bigint): TradeCall {
  const inner = [
    { target: curve, allowFailure: false, value, callData: data },
    { target: feeWallet, allowFailure: false, value: fee, callData: "0x" as Hex },
  ];
  return {
    to: MULTICALL3,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [inner] }),
    value: (value + fee).toString(),
  };
}
