import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import type { FastifyInstance } from "fastify";
import { stakingVaultAbi, devLockAbi } from "../abi/looting.js";
import {
  buildApproveIfNeeded,
  findReusablePending,
  parseLockId,
  parseRawAmount,
  recordStakingActivity,
  resolveVault,
  rewardFromClaimReceipt,
  savePendingAction,
  waitForReceipt,
  waitForReceiptSafe,
  type TxBundle,
} from "../lib/actions.js";
import type { PendingActionKind } from "@prisma/client";
import { contractsConfigured, env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { normalizeAddress } from "../lib/utils.js";
import type { FastifyReply } from "fastify";

async function replyIfReused(
  reply: FastifyReply,
  idempotencyKey: string | undefined,
  kind: PendingActionKind,
  wallet: string,
) {
  const reused = await findReusablePending(idempotencyKey, kind, wallet);
  if (reused && "conflict" in reused) return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT" });
  if (reused && "action" in reused) {
    const payload = reused.action.payload as { tx: TxBundle; approveTx?: TxBundle | null };
    return {
      actionId: reused.action.id,
      tx: payload.tx,
      approveTx: payload.approveTx ?? null,
      needsApproval: Boolean(payload.approveTx),
    };
  }
  return null;
}

export async function registerStakingActionRoutes(app: FastifyInstance) {
  app.post("/api/staking/stake/prepare", async (req, reply) => {
    const body = req.body as {
      wallet: string;
      vaultId: string;
      amount: string;
      lock?: string | number;
      lockId?: string | number;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const reusedStake = await replyIfReused(reply, body.idempotencyKey, "staking_stake", wallet);
    if (reusedStake) return reusedStake;

    const vault = await resolveVault(body.vaultId);
    if (!vault) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });

    let amount: bigint;
    try {
      amount = parseRawAmount(body.amount);
    } catch {
      return reply.code(400).send({ error: "INVALID_AMOUNT" });
    }
    if (amount <= 0n) return reply.code(400).send({ error: "INVALID_AMOUNT" });

    const lockId = parseLockId(body.lockId ?? body.lock);
    const data = encodeFunctionData({
      abi: stakingVaultAbi,
      functionName: "stake",
      args: [amount, lockId],
    });
    const tx: TxBundle = {
      to: vault.vaultAddress as Address,
      data,
      value: "0",
    };
    const approveTx = await buildApproveIfNeeded({
      wallet,
      token: vault.stakeToken,
      spender: vault.vaultAddress,
      amount,
    });

    const pending = await savePendingAction({
      kind: "staking_stake",
      wallet,
      idempotency: body.idempotencyKey,
      payload: {
        wallet,
        vaultId: vault.vaultId.toString(),
        vaultDbId: vault.id,
        vaultAddress: vault.vaultAddress,
        amount: amount.toString(),
        lockId,
        tx,
        approveTx,
      },
    });

    return {
      actionId: pending.id,
      tx,
      approveTx: approveTx ?? null,
      needsApproval: Boolean(approveTx),
    };
  });

  app.post("/api/staking/stake/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "staking_stake") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceiptSafe(body.txHash as Hex);
    if (!receipt || receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    const payload = pending.payload as {
      vaultId: string;
      vaultDbId: string;
      amount: string;
      lockId: number;
      wallet: string;
    };

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    await recordStakingActivity({
      vaultId: payload.vaultId,
      vaultDbId: payload.vaultDbId,
      walletAddress: payload.wallet,
      kind: "stake",
      lockId: payload.lockId,
      amount: payload.amount,
      txHash: body.txHash,
    });

    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });

  app.post("/api/staking/unstake/prepare", async (req, reply) => {
    const body = req.body as {
      wallet: string;
      vaultId: string;
      amount: string;
      lock?: string | number;
      lockId?: string | number;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const reusedUnstake = await replyIfReused(reply, body.idempotencyKey, "staking_unstake", wallet);
    if (reusedUnstake) return reusedUnstake;

    const vault = await resolveVault(body.vaultId);
    if (!vault) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });

    let amount: bigint;
    try {
      amount = parseRawAmount(body.amount);
    } catch {
      return reply.code(400).send({ error: "INVALID_AMOUNT" });
    }
    if (amount <= 0n) return reply.code(400).send({ error: "INVALID_AMOUNT" });

    const lockId = parseLockId(body.lockId ?? body.lock);
    const tx: TxBundle = {
      to: vault.vaultAddress as Address,
      data: encodeFunctionData({
        abi: stakingVaultAbi,
        functionName: "unstake",
        args: [amount, lockId],
      }),
      value: "0",
    };

    const pending = await savePendingAction({
      kind: "staking_unstake",
      wallet,
      idempotency: body.idempotencyKey,
      payload: {
        wallet,
        vaultId: vault.vaultId.toString(),
        vaultDbId: vault.id,
        amount: amount.toString(),
        lockId,
        tx,
      },
    });

    return { actionId: pending.id, tx };
  });

  app.post("/api/staking/unstake/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "staking_unstake") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceiptSafe(body.txHash as Hex);
    if (!receipt || receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    const payload = pending.payload as {
      vaultId: string;
      vaultDbId: string;
      amount: string;
      lockId: number;
      wallet: string;
    };

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    await recordStakingActivity({
      vaultId: payload.vaultId,
      vaultDbId: payload.vaultDbId,
      walletAddress: payload.wallet,
      kind: "unstake",
      lockId: payload.lockId,
      amount: payload.amount,
      txHash: body.txHash,
    });

    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });

  app.post("/api/staking/claim/prepare", async (req, reply) => {
    const body = req.body as {
      wallet: string;
      vaultId: string;
      lock?: string | number;
      lockId?: string | number;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const reusedClaim = await replyIfReused(reply, body.idempotencyKey, "staking_claim", wallet);
    if (reusedClaim) return reusedClaim;

    const vault = await resolveVault(body.vaultId);
    if (!vault) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });

    const lockId = parseLockId(body.lockId ?? body.lock);
    const tx: TxBundle = {
      to: vault.vaultAddress as Address,
      data: encodeFunctionData({
        abi: stakingVaultAbi,
        functionName: "claimRewards",
        args: [lockId],
      }),
      value: "0",
    };

    const pending = await savePendingAction({
      kind: "staking_claim",
      wallet,
      idempotency: body.idempotencyKey,
      payload: {
        wallet,
        vaultId: vault.vaultId.toString(),
        vaultDbId: vault.id,
        lockId,
        tx,
      },
    });

    return { actionId: pending.id, tx };
  });

  app.post("/api/staking/claim/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "staking_claim") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceipt(body.txHash as Hex);
    if (receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    const payload = pending.payload as {
      vaultId: string;
      vaultDbId: string;
      lockId: number;
      wallet: string;
    };

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    await recordStakingActivity({
      vaultId: payload.vaultId,
      vaultDbId: payload.vaultDbId,
      walletAddress: payload.wallet,
      kind: "claim",
      lockId: payload.lockId,
      amount: "0",
      reward: rewardFromClaimReceipt(receipt.logs, payload.lockId),
      txHash: body.txHash,
    });

    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });
}

export async function registerDevLockClaimRoutes(app: FastifyInstance) {
  app.post("/api/devlock/claim/prepare", async (req, reply) => {
    if (!contractsConfigured() || !env.DEV_LOCK_ADDRESS) {
      return reply.code(503).send({ error: "CONTRACTS_NOT_CONFIGURED" });
    }

    const body = req.body as {
      wallet: string;
      lockId: string | number;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const reusedLock = await replyIfReused(reply, body.idempotencyKey, "devlock_claim", wallet);
    if (reusedLock) return reusedLock;

    const lockId = BigInt(String(body.lockId));
    const lock = await prisma.devLock.findUnique({
      where: { chainId_lockId: { chainId: env.CHAIN_ID, lockId } },
    });
    if (!lock) return reply.code(404).send({ error: "LOCK_NOT_FOUND" });
    if (lock.owner !== wallet) return reply.code(403).send({ error: "NOT_OWNER" });

    const tx: TxBundle = {
      to: env.DEV_LOCK_ADDRESS as Address,
      data: encodeFunctionData({
        abi: devLockAbi,
        functionName: "claim",
        args: [lockId],
      }),
      value: "0",
    };

    const pending = await savePendingAction({
      kind: "devlock_claim",
      wallet,
      idempotency: body.idempotencyKey,
      payload: { wallet, lockId: lockId.toString(), tx },
    });

    return { actionId: pending.id, tx };
  });

  app.post("/api/devlock/claim/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "devlock_claim") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceiptSafe(body.txHash as Hex);
    if (!receipt || receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });
}
