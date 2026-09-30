import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { env } from "../config/env.js";
import { getKeeperWallet, getPublic } from "../clients/keeper.js";

const rewardRouterAbi = parseAbi([
  "function sweepPonsCurveFees(address curve, uint256 minBuybackTokensOut)",
  "function harvestPonsFees() returns (uint256 amount)",
  "function allocate(address token, uint256 amount)",
  "function unallocatedEth() view returns (uint256)",
  "function ponsEscrowClaimable() view returns (uint256)",
]);

const curveAbi = parseAbi([
  "function creatorTaxBalance() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
]);

/**
 * Sweep Pons curve accrued fees → FeeEscrow → harvest into RewardRouter → allocate to launch.
 * Requires launch `creatorFeeRecipient = RewardRouter` and preferably buybackEnabled=false.
 */
export async function allocateTaxToLaunch(opts: {
  token: string;
  curve?: string | null;
  amountWei?: bigint;
}): Promise<Hex | null> {
  if (!env.LOOTING_REWARD_ROUTER) return null;
  const keeper = getKeeperWallet();
  if (!keeper?.account) return null;

  const router = getAddress(env.LOOTING_REWARD_ROUTER) as Address;
  const token = getAddress(opts.token) as Address;
  const client = getPublic();
  let lastTx: Hex | null = null;

  try {
    if (opts.curve) {
      const curve = getAddress(opts.curve) as Address;
      let pending = 0n;
      try {
        const [tax, quoteFee] = await Promise.all([
          client.readContract({ address: curve, abi: curveAbi, functionName: "creatorTaxBalance" }) as Promise<bigint>,
          client.readContract({ address: curve, abi: curveAbi, functionName: "quoteFeeBalance" }) as Promise<bigint>,
        ]);
        pending = tax + quoteFee;
      } catch {
        pending = 1n; // unknown views — still try sweep
      }

      if (pending > 0n) {
        try {
          lastTx = await keeper.writeContract({
            address: router,
            abi: rewardRouterAbi,
            functionName: "sweepPonsCurveFees",
            args: [curve, 0n],
            chain: keeper.chain,
            account: keeper.account,
          });
          await client.waitForTransactionReceipt({ hash: lastTx, timeout: 120_000 });
        } catch (err) {
          console.warn("[reward-router] sweepPonsCurveFees failed", curve, err);
        }
      }
    }

    const escrowBal = (await client.readContract({
      address: router,
      abi: rewardRouterAbi,
      functionName: "ponsEscrowClaimable",
    })) as bigint;
    if (escrowBal > 0n) {
      try {
        lastTx = await keeper.writeContract({
          address: router,
          abi: rewardRouterAbi,
          functionName: "harvestPonsFees",
          chain: keeper.chain,
          account: keeper.account,
        });
        await client.waitForTransactionReceipt({ hash: lastTx, timeout: 120_000 });
      } catch (err) {
        console.warn("[reward-router] harvestPonsFees failed", err);
      }
    }

    const unallocated = (await client.readContract({
      address: router,
      abi: rewardRouterAbi,
      functionName: "unallocatedEth",
    })) as bigint;
    if (unallocated <= 0n) return lastTx;

    // Prefer exact tax event amount when it fits; otherwise allocate whatever arrived.
    let amount = opts.amountWei && opts.amountWei > 0n ? opts.amountWei : unallocated;
    if (amount > unallocated) amount = unallocated;

    lastTx = await keeper.writeContract({
      address: router,
      abi: rewardRouterAbi,
      functionName: "allocate",
      args: [token, amount],
      chain: keeper.chain,
      account: keeper.account,
    });
    return lastTx;
  } catch (err) {
    console.warn("[reward-router] allocateTaxToLaunch failed", opts.token, err);
    return lastTx;
  }
}
