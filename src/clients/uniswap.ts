import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { env } from "../config/env.js";
import { getPublicClient } from "./rpc.js";

const MAX_SLIPPAGE_BPS = 500; // 5%

const quoterV3Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export type SwapQuoteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee?: number;
  slippageBps?: number;
  recipient: Address;
  deadlineSeconds?: number;
};

export type SwapQuoteResult = {
  amountOut: bigint;
  amountOutMin: bigint;
  fee: number;
  to: Address;
  data: Hex;
  value: bigint;
  deadline: number;
};

function clampSlippage(bps: number | undefined): number {
  const v = bps ?? 100;
  if (v < 0) return 0;
  if (v > MAX_SLIPPAGE_BPS) return MAX_SLIPPAGE_BPS;
  return v;
}

/**
 * Quote + prepare Uniswap V3 SwapRouter02 calldata on Robinhood.
 * V4 Universal Router encoding is more complex; V3 router is deployed and sufficient
 * for Terminal swaps until a dedicated V4 path encoder lands.
 */
export async function quoteAndPrepareSwap(req: SwapQuoteRequest): Promise<SwapQuoteResult> {
  if (!env.UNI_V3_QUOTER || !env.UNI_V3_SWAP_ROUTER) {
    throw new Error("UNISWAP_NOT_CONFIGURED");
  }

  const fee = req.fee ?? 3000;
  const client = getPublicClient();
  const quoter = env.UNI_V3_QUOTER as Address;
  const router = env.UNI_V3_SWAP_ROUTER as Address;

  let amountOut: bigint;
  try {
    const result = await client.simulateContract({
      address: quoter,
      abi: quoterV3Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: req.tokenIn,
          tokenOut: req.tokenOut,
          amountIn: req.amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    amountOut = (result.result as readonly [bigint, ...unknown[]])[0];
  } catch (err) {
    throw new Error(`QUOTE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  const slippageBps = clampSlippage(req.slippageBps);
  const amountOutMin = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadlineSeconds = Math.min(Math.max(req.deadlineSeconds ?? 300, 60), 1800);
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

  const isEthIn =
    req.tokenIn.toLowerCase() === env.WETH_ADDRESS.toLowerCase() ||
    req.tokenIn.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  const tokenIn = isEthIn ? (env.WETH_ADDRESS as Address) : req.tokenIn;

  const data = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut: req.tokenOut,
        fee,
        recipient: req.recipient,
        amountIn: req.amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  return {
    amountOut,
    amountOutMin,
    fee,
    to: router,
    data,
    value: isEthIn ? req.amountIn : 0n,
    deadline,
  };
}
