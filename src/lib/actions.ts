import type { Address, Hex } from "viem";
import { decodeEventLog, encodeFunctionData } from "viem";
import type { PendingActionKind, Prisma } from "@prisma/client";
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
  const txHash = input.txHash?.toLowerCase();
  if (txHash) {
    const existing = await prisma.stakingActivity.findFirst({
      where: { chainId: env.CHAIN_ID, txHash, kind: input.kind, lockId: input.lockId },
    });
    if (existing) return;
  }

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
      txHash,
      at: input.at ?? new Date(),
    },
  });
}

type PendingPayload = Prisma.InputJsonValue;

export async function findReusablePending(idempotencyKey: string | undefined, kind: PendingActionKind, wallet: string) {
  if (!idempotencyKey) return null;
  const existing = await prisma.pendingAction.findUnique({ where: { idempotency: idempotencyKey } });
  if (!existing) return null;
  if (existing.kind !== kind || existing.wallet !== wallet) return { conflict: true as const };
  return { action: existing };
}

export async function savePendingAction(data: {
  kind: PendingActionKind;
  wallet: string;
  idempotency?: string;
  payload: PendingPayload;
}) {
  try {
    return await prisma.pendingAction.create({
      data: {
        kind: data.kind,
        wallet: data.wallet,
        idempotency: data.idempotency,
        payload: data.payload,
      },
    });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "P2002" && data.idempotency) {
      const existing = await prisma.pendingAction.findUnique({ where: { idempotency: data.idempotency } });
      if (existing && existing.kind === data.kind && existing.wallet === data.wallet) return existing;
    }
    throw err;
  }
}

export function rewardFromClaimReceipt(
  logs: ReadonlyArray<{ data: Hex; topics: readonly Hex[] }>,
  lockId: number,
): string {
  for (const log of logs) {
    try {
      if (log.topics.length === 0) continue;
      const decoded = decodeEventLog({
        abi: stakingVaultAbi,
        data: log.data,
        topics: [log.topics[0], ...log.topics.slice(1)],
      });
      if (decoded.eventName !== "StakingRewardsClaimed") continue;
      if (Number(decoded.args.lockId) !== lockId) continue;
      return decoded.args.amount.toString();
    } catch {
      // unrelated log
    }
  }
  return "0";
}

export function feLockLabel(lockId: number) {
  return lockIdToFe(lockId);
}
