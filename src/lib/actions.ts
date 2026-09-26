import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { erc20Abi, stakingVaultAbi, devLockAbi } from "../abi/looting.js";
import { getPublicClient } from "../clients/rpc.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { lockIdToFe, rawToUiAmount } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";

export type TxBundle = {
  to: Address;
  data: Hex;
  value: string;
};

/** FE lock id ("flex"|"30"|"90") or numeric 0|1|2 → contract lockId. */
export function parseLockId(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(2, value));
  const s = String(value ?? "flex").toLowerCase();
  if (s === "30" || s === "1") return 1;
  if (s === "90" || s === "2") return 2;
  return 0;
}

export function parseRawAmount(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("INVALID_AMOUNT");
  }
  return BigInt(trimmed);
}

export async function waitForReceipt(txHash: Hex) {
  const client = getPublicClient();
  return client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 120_000 });
}

export async function waitForReceiptSafe(txHash: Hex) {
  try {
    return await waitForReceipt(txHash);
  } catch {
    return null;
  }
}

export async function resolveVault(vaultIdOrAddress: string) {
  const key = vaultIdOrAddress.trim();
  const or: Array<{ vaultAddress: string } | { vaultId: bigint }> = [
    { vaultAddress: key.toLowerCase() },
  ];
  if (/^\d+$/.test(key)) {
    or.push({ vaultId: BigInt(key) });
  }
  return prisma.stakingVault.findFirst({
    where: { chainId: env.CHAIN_ID, OR: or },
    include: { launch: true },
  });
}

export async function buildApproveIfNeeded(opts: {
  wallet: string;
  token: string;
  spender: string;
  amount: bigint;
}): Promise<TxBundle | null> {
  const client = getPublicClient();
  const allowance = (await client.readContract({
    address: opts.token as Address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [opts.wallet as Address, opts.spender as Address],
  })) as bigint;

  if (allowance >= opts.amount) return null;

  return {
    to: opts.token as Address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [opts.spender as Address, opts.amount],
    }),
    value: "0",
  };
}

export async function readPendingRewards(vaultAddress: string, wallet: string, lockId: number) {
  try {
    const client = getPublicClient();
    const pending = (await client.readContract({
      address: vaultAddress as Address,
      abi: stakingVaultAbi,
      functionName: "pendingRewards",
      args: [wallet as Address, lockId],
    })) as bigint;
    return rawToUiAmount(pending);
  } catch {
    return 0;
  }
}

export async function readDevLockClaimable(lockId: bigint) {
  if (!env.DEV_LOCK_ADDRESS) return 0;
  try {
    const client = getPublicClient();
    const claimable = (await client.readContract({
      address: env.DEV_LOCK_ADDRESS as Address,
      abi: devLockAbi,
      functionName: "claimableAmount",
      args: [lockId],
    })) as bigint;
    return rawToUiAmount(claimable);
  } catch {
    return 0;
  }
}

export async function recordStakingActivity(input: {
  vaultId: string;
  vaultDbId?: string;
  walletAddress: string;
  kind: "stake" | "unstake" | "claim";
  lockId: number;
  amount: string | bigint;
  reward?: string | bigint;
  txHash?: string;
  at?: Date;
}) {
  await prisma.stakingActivity.create({
    data: {
      chainId: env.CHAIN_ID,
      vaultId: input.vaultId,
      vaultDbId: input.vaultDbId,
      walletAddress: normalizeAddress(input.walletAddress),
      kind: input.kind,
      lockId: input.lockId,
      amount: input.amount.toString(),
      reward: (input.reward ?? 0).toString(),
      txHash: input.txHash?.toLowerCase(),
      at: input.at ?? new Date(),
    },
  });
}

export function feLockLabel(lockId: number) {
  return lockIdToFe(lockId);
}
