import type { FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import { devLockAbi, launchRegistryAbi, stakingFactoryAbi } from "../abi/looting.js";
import { quoteAndPrepareSwap } from "../clients/uniswap.js";
import { getPublicClient } from "../clients/rpc.js";
import { contractsConfigured, env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { normalizeAddress } from "../lib/utils.js";

type TxBundle = {
  to: Address;
  data: Hex;
  value: string;
};

async function waitForReceipt(txHash: Hex) {
  const client = getPublicClient();
  return client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 120_000 });
}

export async function registerPrepareRoutes(app: FastifyInstance) {
  app.post("/api/launch/prepare", async (req, reply) => {
    if (!contractsConfigured() || !env.LAUNCH_REGISTRY_ADDRESS) {
      return reply.code(503).send({ error: "CONTRACTS_NOT_CONFIGURED" });
    }

    const body = req.body as {
      wallet: string;
      token: string;
      curve?: string;
      creatorFeeRouter?: string;
      creatorBps?: number;
      luckyBoxBps?: number;
      totalCreatorFeeBps?: number;
      holderShareEnabled?: boolean;
      quoteAsset?: string;
      name?: string;
      symbol?: string;
      idempotencyKey?: string;
    };

    let wallet: string;
    let token: string;
    try {
      wallet = normalizeAddress(body.wallet);
      token = normalizeAddress(body.token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const creatorBps = body.creatorBps ?? 5000;
    const luckyBoxBps = body.luckyBoxBps ?? 5000;
    const totalCreatorFeeBps = body.totalCreatorFeeBps ?? creatorBps + luckyBoxBps;
    if (creatorBps + luckyBoxBps !== totalCreatorFeeBps || totalCreatorFeeBps > 10_000) {
      return reply.code(400).send({ error: "INVALID_FEE_SPLIT" });
    }

    const configHash = keccak256(
      toBytes(
        JSON.stringify({
          token,
          creatorBps,
          luckyBoxBps,
          totalCreatorFeeBps,
          holderShareEnabled: Boolean(body.holderShareEnabled),
        }),
      ),
    );

    const data = encodeFunctionData({
      abi: launchRegistryAbi,
      functionName: "register",
      args: [
        {
          token: token as Address,
          curve: (body.curve ? normalizeAddress(body.curve) : wallet) as Address,
          creator: wallet as Address,
          creatorFeeRouter: (body.creatorFeeRouter
            ? normalizeAddress(body.creatorFeeRouter)
            : wallet) as Address,
          creatorBps,
          luckyBoxBps,
          totalCreatorFeeBps,
          holderShareEnabled: Boolean(body.holderShareEnabled),
          quoteAsset: (body.quoteAsset
            ? normalizeAddress(body.quoteAsset)
            : "0x0000000000000000000000000000000000000000") as Address,
          launchedAt: BigInt(Math.floor(Date.now() / 1000)),
          phase: 0,
          rewardsEnabled: true,
          configHash,
        },
      ],
    });

    const tx: TxBundle = {
      to: env.LAUNCH_REGISTRY_ADDRESS as Address,
      data,
      value: "0",
    };

    const pending = await prisma.pendingAction.create({
      data: {
        kind: "launch",
        wallet,
        idempotency: body.idempotencyKey,
        payload: {
          ...body,
          token,
          wallet,
          configHash,
          name: body.name,
          symbol: body.symbol,
          tx,
        },
      },
    });

    return { actionId: pending.id, tx };
  });

  app.post("/api/launch/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    if (!body.actionId || !body.txHash?.startsWith("0x")) {
      return reply.code(400).send({ error: "INVALID_BODY" });
    }

    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "launch") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceipt(body.txHash as Hex);
    if (receipt.status !== "success") {
      await prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: "failed", txHash: body.txHash },
      });
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    const payload = pending.payload as {
      token: string;
      wallet: string;
      curve?: string;
      creatorFeeRouter?: string;
      creatorBps?: number;
      luckyBoxBps?: number;
      totalCreatorFeeBps?: number;
      holderShareEnabled?: boolean;
      quoteAsset?: string;
      configHash?: string;
      name?: string;
      symbol?: string;
    };

    await prisma.launch.upsert({
      where: {
        chainId_token: { chainId: env.CHAIN_ID, token: payload.token },
      },
      create: {
        chainId: env.CHAIN_ID,
        token: payload.token,
        creator: payload.wallet,
        curve: payload.curve ? normalizeAddress(payload.curve) : null,
        creatorFeeRouter: payload.creatorFeeRouter
          ? normalizeAddress(payload.creatorFeeRouter)
          : null,
        creatorBps: payload.creatorBps ?? 0,
        luckyBoxBps: payload.luckyBoxBps ?? 0,
        totalCreatorFeeBps: payload.totalCreatorFeeBps ?? 0,
        holderShareEnabled: Boolean(payload.holderShareEnabled),
        quoteAsset: payload.quoteAsset ? normalizeAddress(payload.quoteAsset) : null,
        launchTxHash: body.txHash.toLowerCase(),
        launchBlock: receipt.blockNumber,
        launchedAt: new Date(),
        configHash: payload.configHash,
        name: payload.name,
        symbol: payload.symbol,
      },
      update: {
        launchTxHash: body.txHash.toLowerCase(),
        launchBlock: receipt.blockNumber,
        launchedAt: new Date(),
        status: "active",
      },
    });

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });

  app.post("/api/staking/events/prepare", async (req, reply) => {
    if (!contractsConfigured() || !env.STAKING_FACTORY_ADDRESS) {
      return reply.code(503).send({ error: "CONTRACTS_NOT_CONFIGURED" });
    }

    const body = req.body as {
      wallet: string;
      stakeToken: string;
      rewardAmount: string;
      endsAt: number;
      lockMask: number;
      aprBps: [number, number, number];
      idempotencyKey?: string;
    };

    let wallet: string;
    let stakeToken: string;
    try {
      wallet = normalizeAddress(body.wallet);
      stakeToken = normalizeAddress(body.stakeToken);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const client = getPublicClient();
    const fee = (await client.readContract({
      address: env.STAKING_FACTORY_ADDRESS as Address,
      abi: stakingFactoryAbi,
      functionName: "fee",
    })) as bigint;

    const data = encodeFunctionData({
      abi: stakingFactoryAbi,
      functionName: "createVault",
      args: [
        stakeToken as Address,
        BigInt(body.rewardAmount),
        BigInt(body.endsAt),
        body.lockMask,
        body.aprBps,
      ],
    });

    const tx: TxBundle = {
      to: env.STAKING_FACTORY_ADDRESS as Address,
      data,
      value: fee.toString(),
    };

    const pending = await prisma.pendingAction.create({
      data: {
        kind: "staking_create",
        wallet,
        idempotency: body.idempotencyKey,
        payload: { ...body, wallet, stakeToken, fee: fee.toString(), tx },
      },
    });

    return { actionId: pending.id, tx, feeWei: fee.toString() };
  });

  app.post("/api/staking/events/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "staking_create") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForReceipt(body.txHash as Hex);
    if (receipt.status !== "success") {
      return reply.code(400).send({ error: "TX_FAILED" });
    }

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: "confirmed", txHash: body.txHash.toLowerCase() },
    });

    // Vault row is primarily filled by the indexer from StakingVaultCreated.
    return { status: "confirmed", txHash: body.txHash.toLowerCase() };
  });

  app.post("/api/devlock/prepare", async (req, reply) => {
    if (!contractsConfigured() || !env.DEV_LOCK_ADDRESS) {
      return reply.code(503).send({ error: "CONTRACTS_NOT_CONFIGURED" });
    }

    const body = req.body as {
      wallet: string;
      token: string;
      amount: string;
      mode: "time" | "vest";
      unlockAt: number;
      cliffAt?: number;
      cadence?: number;
      idempotencyKey?: string;
    };

    let wallet: string;
    let token: string;
    try {
      wallet = normalizeAddress(body.wallet);
      token = normalizeAddress(body.token);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    const client = getPublicClient();
    const fee = (await client.readContract({
      address: env.DEV_LOCK_ADDRESS as Address,
      abi: devLockAbi,
      functionName: "fee",
    })) as bigint;

    const data =
      body.mode === "vest"
        ? encodeFunctionData({
            abi: devLockAbi,
            functionName: "createVesting",
            args: [
              token as Address,
              BigInt(body.amount),
              BigInt(body.cliffAt ?? body.unlockAt),
              BigInt(body.unlockAt),
              body.cadence ?? 0,
            ],
          })
        : encodeFunctionData({
            abi: devLockAbi,
            functionName: "createTimeLock",
            args: [token as Address, BigInt(body.amount), BigInt(body.unlockAt)],
          });

    const tx: TxBundle = {
      to: env.DEV_LOCK_ADDRESS as Address,
      data,
      value: fee.toString(),
    };

    const pending = await prisma.pendingAction.create({
      data: {
        kind: "devlock_create",
        wallet,
        idempotency: body.idempotencyKey,
        payload: { ...body, wallet, token, fee: fee.toString(), tx },
      },
    });

    return { actionId: pending.id, tx, feeWei: fee.toString() };
  });

  app.post("/api/devlock/confirm", async (req, reply) => {
    const body = req.body as { actionId: string; txHash: string };
    const pending = await prisma.pendingAction.findUnique({ where: { id: body.actionId } });
    if (!pending || pending.kind !== "devlock_create") {
      return reply.code(404).send({ error: "ACTION_NOT_FOUND" });
    }
    if (pending.status === "confirmed") {
      return { status: "already_confirmed", txHash: pending.txHash };
    }

    const receipt = await waitForTransactionReceiptSafe(body.txHash as Hex);
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

async function waitForTransactionReceiptSafe(txHash: Hex) {
  try {
    return await waitForReceipt(txHash);
  } catch {
    return null;
  }
}

export async function registerSwapRoutes(app: FastifyInstance) {
  app.post("/api/swap/quote", async (req, reply) => {
    const body = req.body as {
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      recipient: string;
      fee?: number;
      slippageBps?: number;
    };

    try {
      const result = await quoteAndPrepareSwap({
        tokenIn: normalizeAddress(body.tokenIn) as Address,
        tokenOut: normalizeAddress(body.tokenOut) as Address,
        amountIn: BigInt(body.amountIn),
        recipient: normalizeAddress(body.recipient) as Address,
        fee: body.fee,
        slippageBps: body.slippageBps,
      });

      return {
        data: {
          amountOut: result.amountOut.toString(),
          amountOutMin: result.amountOutMin.toString(),
          fee: result.fee,
          deadline: result.deadline,
        },
      };
    } catch (err) {
      return reply.code(400).send({
        error: "QUOTE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/swap/prepare", async (req, reply) => {
    const body = req.body as {
      wallet: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      fee?: number;
      slippageBps?: number;
      deadlineSeconds?: number;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet);
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS" });
    }

    try {
      const result = await quoteAndPrepareSwap({
        tokenIn: normalizeAddress(body.tokenIn) as Address,
        tokenOut: normalizeAddress(body.tokenOut) as Address,
        amountIn: BigInt(body.amountIn),
        recipient: wallet as Address,
        fee: body.fee,
        slippageBps: body.slippageBps,
        deadlineSeconds: body.deadlineSeconds,
      });

      const tx: TxBundle = {
        to: result.to,
        data: result.data,
        value: result.value.toString(),
      };

      const pending = await prisma.pendingAction.create({
        data: {
          kind: "swap",
          wallet,
          idempotency: body.idempotencyKey,
          payload: {
            ...body,
            wallet,
            amountOut: result.amountOut.toString(),
            amountOutMin: result.amountOutMin.toString(),
            deadline: result.deadline,
            tx,
          },
        },
      });

      return {
        actionId: pending.id,
        tx,
        amountOut: result.amountOut.toString(),
        amountOutMin: result.amountOutMin.toString(),
        deadline: result.deadline,
      };
    } catch (err) {
      return reply.code(400).send({
        error: "SWAP_PREPARE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
