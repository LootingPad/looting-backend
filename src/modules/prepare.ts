import type { FastifyInstance } from "fastify";
import type { Address, Hex, Log } from "viem";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, toBytes } from "viem";
import { devLockAbi, stakingFactoryAbi } from "../abi/looting.js";
import { quoteAndPrepareSwap } from "../clients/uniswap.js";
import { getPublicClient } from "../clients/rpc.js";
import { contractsConfigured, env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  buildApproveIfNeeded,
  findReusablePending,
  parseRawAmount,
  savePendingAction,
} from "../lib/actions.js";
import { normalizeAddress } from "../lib/utils.js";
import { launchViaLootingEvent, tokenAbi, tokenLaunchedEvent } from "../pons-adapter/abi.js";
import { publishTrenchPair } from "../pons-adapter/hub.js";
import { LaunchPrepareError, preparePonsLaunch } from "../pons-adapter/launch.js";
import { registerLaunchOnChain } from "../services/launch-registry.js";

type TxBundle = {
  to: Address;
  data: Hex;
  value: string;
};

async function waitForReceipt(txHash: Hex) {
  const client = getPublicClient();
  return client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 120_000 });
}

function parseTokenLaunched(logs: Log[]) {
  let launched: {
    token: string;
    curve: string;
    deployer: string;
    pairToken: string;
    launchConfigId: string;
    logIndex: number;
  } | null = null;

  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [tokenLaunchedEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "TokenLaunched") continue;
      const args = decoded.args as {
        token: Address;
        curve: Address;
        deployer: Address;
        pairToken: Address;
        launchConfigId: bigint;
        graduationThreshold: bigint;
      };
      launched = {
        token: getAddress(args.token).toLowerCase(),
        curve: getAddress(args.curve).toLowerCase(),
        deployer: getAddress(args.deployer).toLowerCase(),
        pairToken: getAddress(args.pairToken).toLowerCase(),
        launchConfigId: args.launchConfigId.toString(),
        logIndex: Number(log.logIndex ?? 0),
      };
      break;
    } catch {
      /* not this event */
    }
  }
  if (!launched) return null;

  // Prefer LOOTING router event so creator = the user wallet, not the router deployer.
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [launchViaLootingEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "LaunchViaLooting") continue;
      const args = decoded.args as { creator: Address; token: Address; curve: Address };
      if (getAddress(args.token).toLowerCase() !== launched.token) continue;
      launched.deployer = getAddress(args.creator).toLowerCase();
      break;
    } catch {
      /* not this event */
    }
  }

  return launched;
}

async function hydrateTokenMeta(token: Address) {
  const client = getPublicClient();
  try {
    const [name, symbol, decimals, totalSupply, info] = await Promise.all([
      client.readContract({ address: token, abi: tokenAbi, functionName: "name" }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "getTokenInfo" }),
    ]);
    const socials = info[3];
    return {
      name: name || "",
      symbol: symbol || "",
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
      logo: (info[1] || "").trim(),
      description: (info[2] || "").trim(),
      twitter: socials?.twitter ?? "",
      telegram: socials?.telegram ?? "",
      discord: socials?.discord ?? "",
      website: socials?.website ?? "",
      farcaster: socials?.farcaster ?? "",
    };
  } catch {
    return null;
  }
}

async function persistLaunchToDb(input: {
  launched: NonNullable<ReturnType<typeof parseTokenLaunched>>;
  payload: {
    wallet: string;
    name?: string;
    symbol?: string;
    description?: string;
    logo?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    farcaster?: string;
    creatorBps?: number;
    luckyBoxBps?: number;
    totalCreatorFeeBps?: number;
    creatorTaxBps?: number;
    holderShareEnabled?: boolean;
    creatorFeeRecipient?: string;
    pairToken?: string;
    launchConfigId?: string;
  };
  txHash: string;
  blockNumber: bigint;
  configHash: string;
}) {
  const { launched, payload, txHash, blockNumber, configHash } = input;
  const onchain = await hydrateTokenMeta(launched.token as Address);
  const name = (onchain?.name || payload.name || "Untitled").trim();
  const symbol = (onchain?.symbol || payload.symbol || "TOKEN").trim().toUpperCase();
  const description = onchain?.description || payload.description || "";
  const logo = onchain?.logo || payload.logo || "";
  const creatorTaxBps = payload.creatorTaxBps ?? payload.totalCreatorFeeBps ?? 0;

  const [launchRow, trenchRow] = await prisma.$transaction([
    prisma.launch.upsert({
      where: {
        chainId_token: { chainId: env.CHAIN_ID, token: launched.token },
      },
      create: {
        chainId: env.CHAIN_ID,
        token: launched.token,
        creator: payload.wallet.toLowerCase(),
        curve: launched.curve,
        creatorFeeRouter: payload.creatorFeeRecipient
          ? normalizeAddress(payload.creatorFeeRecipient)
          : null,
        creatorBps: payload.creatorBps ?? 0,
        luckyBoxBps: payload.luckyBoxBps ?? 0,
        totalCreatorFeeBps: payload.totalCreatorFeeBps ?? 0,
        holderShareEnabled: Boolean(payload.holderShareEnabled),
        quoteAsset: payload.pairToken ?? launched.pairToken,
        launchTxHash: txHash.toLowerCase(),
        launchBlock: blockNumber,
        launchedAt: new Date(),
        configHash,
        name,
        symbol,
        description,
        imageUrl: logo || null,
      },
      update: {
        curve: launched.curve,
        launchTxHash: txHash.toLowerCase(),
        launchBlock: blockNumber,
        launchedAt: new Date(),
        status: "active",
        name,
        symbol,
        description,
        imageUrl: logo || undefined,
        creatorBps: payload.creatorBps ?? undefined,
        luckyBoxBps: payload.luckyBoxBps ?? undefined,
        totalCreatorFeeBps: payload.totalCreatorFeeBps ?? undefined,
        holderShareEnabled: Boolean(payload.holderShareEnabled),
      },
    }),
    prisma.trenchPair.upsert({
      where: {
        chainId_token: { chainId: env.CHAIN_ID, token: launched.token },
      },
      create: {
        chainId: env.CHAIN_ID,
        token: launched.token,
        name,
        symbol,
        decimals: onchain?.decimals ?? 18,
        totalSupply: onchain?.totalSupply ?? "0",
        logo,
        description,
        twitter: onchain?.twitter || payload.twitter || "",
        telegram: onchain?.telegram || payload.telegram || "",
        discord: onchain?.discord || payload.discord || "",
        website: onchain?.website || payload.website || "",
        farcaster: onchain?.farcaster || payload.farcaster || "",
        deployer: launched.deployer || payload.wallet.toLowerCase(),
        curve: launched.curve,
        pairToken: launched.pairToken,
        launchConfigId: launched.launchConfigId || payload.launchConfigId || "0",
        txHash: txHash.toLowerCase(),
        blockNumber,
        logIndex: launched.logIndex,
        launchedAt: new Date(),
        stage: "new",
        creatorTaxBps,
        taxPercent: creatorTaxBps / 100,
      },
      update: {
        name,
        symbol,
        decimals: onchain?.decimals ?? undefined,
        totalSupply: onchain?.totalSupply ?? undefined,
        logo: logo || undefined,
        description,
        twitter: onchain?.twitter || payload.twitter || undefined,
        telegram: onchain?.telegram || payload.telegram || undefined,
        discord: onchain?.discord || payload.discord || undefined,
        website: onchain?.website || payload.website || undefined,
        farcaster: onchain?.farcaster || payload.farcaster || undefined,
        deployer: launched.deployer,
        curve: launched.curve,
        pairToken: launched.pairToken,
        launchConfigId: launched.launchConfigId || payload.launchConfigId || "0",
        txHash: txHash.toLowerCase(),
        blockNumber,
        logIndex: launched.logIndex,
        creatorTaxBps,
        taxPercent: creatorTaxBps / 100,
      },
    }),
  ]);

  return { launchRow, trenchRow };
}

export async function registerPrepareRoutes(app: FastifyInstance) {
  app.post("/api/launch/prepare", async (req, reply) => {
    if (!env.PONS_V2_FACTORY) {
      return reply.code(503).send({ error: "PONS_NOT_CONFIGURED", message: "Pons factory is not configured." });
    }

    const body = req.body as {
      wallet?: string;
      name?: string;
      symbol?: string;
      description?: string;
      logo?: string;
      website?: string;
      twitter?: string;
      telegram?: string;
      discord?: string;
      farcaster?: string;
      creatorTax?: number;
      creatorFee?: number;
      luckyShare?: number;
      holderShareEnabled?: boolean;
      holders?: boolean;
      creatorWallet?: string;
      creatorFeeRecipient?: string;
      pair?: string;
      pairToken?: string;
      launchConfigId?: number;
      initialBuy?: string;
      buy?: string;
      exemptions?: string[];
      buybackEnabled?: boolean;
      idempotencyKey?: string;
    };

    let wallet: string;
    try {
      wallet = normalizeAddress(body.wallet ?? "");
    } catch {
      return reply.code(400).send({ error: "INVALID_ADDRESS", message: "Connect a wallet first." });
    }

    const creatorTax = Number(body.creatorTax ?? body.creatorFee ?? 1);
    const luckyShare = Math.min(100, Math.max(0, Number(body.luckyShare ?? 0)));
    const totalCreatorFeeBps = Math.round(creatorTax * 100);
    const luckyBoxBps = Math.round((luckyShare / 100) * totalCreatorFeeBps);
    const creatorBps = Math.max(0, totalCreatorFeeBps - luckyBoxBps);

    try {
      const prepared = await preparePonsLaunch({
        wallet: wallet as Address,
        name: String(body.name ?? ""),
        symbol: String(body.symbol ?? ""),
        description: body.description,
        logo: body.logo,
        website: body.website,
        twitter: body.twitter,
        telegram: body.telegram,
        discord: body.discord,
        farcaster: body.farcaster,
        creatorTaxPercent: creatorTax,
        luckyShare,
        holderShareEnabled: Boolean(body.holderShareEnabled ?? body.holders),
        creatorFeeRecipient: body.creatorFeeRecipient || body.creatorWallet,
        pair: body.pair,
        pairToken: body.pairToken,
        launchConfigId: body.launchConfigId,
        initialBuy: body.initialBuy ?? body.buy,
        exemptions: body.exemptions,
        buybackEnabled: body.buybackEnabled,
      });

      const pending = await prisma.pendingAction.create({
        data: {
          kind: "launch",
          wallet,
          idempotency: body.idempotencyKey,
          payload: {
            wallet,
            name: String(body.name ?? "").trim(),
            symbol: String(body.symbol ?? "")
              .trim()
              .toUpperCase(),
            description: body.description ?? "",
            logo: body.logo ?? "",
            website: body.website ?? "",
            twitter: body.twitter ?? "",
            telegram: body.telegram ?? "",
            discord: body.discord ?? "",
            farcaster: body.farcaster ?? "",
            creatorTaxBps: prepared.creatorTaxBps,
            creatorBps,
            luckyBoxBps,
            totalCreatorFeeBps,
            luckyShare,
            holderShareEnabled: Boolean(body.holderShareEnabled ?? body.holders),
            creatorFeeRecipient: body.creatorFeeRecipient || body.creatorWallet || wallet,
            pairToken: prepared.pairToken.toLowerCase(),
            launchConfigId: prepared.launchConfigId,
            salt: prepared.salt,
            expectedEconomics: prepared.expectedEconomics,
            mode: prepared.mode,
            quoteInWei: prepared.quoteInWei,
            launchFeeWei: prepared.launchFeeWei,
            ponsFeeWei: prepared.ponsFeeWei,
            lootingFeeWei: prepared.lootingFeeWei,
            calls: prepared.calls,
          },
        },
      });

      return {
        data: {
          actionId: pending.id,
          calls: prepared.calls,
          launchFeeWei: prepared.launchFeeWei,
          launchFeeEth: prepared.launchFeeEth,
          ponsFeeWei: prepared.ponsFeeWei,
          lootingFeeWei: prepared.lootingFeeWei,
          quoteInWei: prepared.quoteInWei,
          pairToken: prepared.pairToken,
          launchConfigId: prepared.launchConfigId,
          mode: prepared.mode,
          creatorTaxBps: prepared.creatorTaxBps,
        },
      };
    } catch (err) {
      if (err instanceof LaunchPrepareError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
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
      const prior = pending.payload as { token?: string; curve?: string };
      return {
        status: "already_confirmed",
        txHash: pending.txHash,
        token: prior.token,
        curve: prior.curve,
      };
    }

    const receipt = await waitForReceipt(body.txHash as Hex);
    if (receipt.status !== "success") {
      await prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: "failed", txHash: body.txHash },
      });
      return reply.code(400).send({ error: "TX_FAILED", message: "Launch transaction reverted." });
    }

    const launched = parseTokenLaunched(receipt.logs);
    if (!launched) {
      return reply.code(400).send({
        error: "LAUNCH_EVENT_MISSING",
        message: "Launch confirmed on-chain but TokenLaunched was not found in the receipt.",
      });
    }

    const payload = pending.payload as {
      wallet: string;
      name?: string;
      symbol?: string;
      description?: string;
      logo?: string;
      website?: string;
      twitter?: string;
      telegram?: string;
      discord?: string;
      farcaster?: string;
      creatorBps?: number;
      luckyBoxBps?: number;
      totalCreatorFeeBps?: number;
      creatorTaxBps?: number;
      holderShareEnabled?: boolean;
      creatorFeeRecipient?: string;
      pairToken?: string;
      launchConfigId?: string;
    };

    const configHash = keccak256(
      toBytes(
        JSON.stringify({
          token: launched.token,
          creatorBps: payload.creatorBps ?? 0,
          luckyBoxBps: payload.luckyBoxBps ?? 0,
          totalCreatorFeeBps: payload.totalCreatorFeeBps ?? 0,
          holderShareEnabled: Boolean(payload.holderShareEnabled),
        }),
      ),
    );

    const { trenchRow } = await persistLaunchToDb({
      launched,
      payload,
      txHash: body.txHash,
      blockNumber: receipt.blockNumber,
      configHash,
    });

    // On-chain registry snapshot so RewardRouter.allocate can split tax for this token.
    void registerLaunchOnChain({
      token: launched.token,
      curve: launched.curve,
      creator: payload.wallet,
      creatorBps: payload.creatorBps ?? 0,
      luckyBoxBps: payload.luckyBoxBps ?? 0,
      totalCreatorFeeBps: payload.totalCreatorFeeBps ?? 0,
      holderShareEnabled: Boolean(payload.holderShareEnabled),
      quoteAsset: payload.pairToken ?? launched.pairToken,
      configHash: configHash as Hex,
    }).catch((err) => {
      req.log.warn({ err, token: launched.token }, "on-chain LaunchRegistry.register failed");
    });

    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: {
        status: "confirmed",
        txHash: body.txHash.toLowerCase(),
        payload: { ...payload, token: launched.token, curve: launched.curve, configHash },
      },
    });

    // Fan out to Explore / trenches WS without waiting for the indexer poll.
    void publishTrenchPair(trenchRow).catch((err) => {
      req.log.warn({ err, token: launched.token }, "trench publish after launch confirm failed");
    });

    return {
      status: "confirmed",
      txHash: body.txHash.toLowerCase(),
      token: launched.token,
      curve: launched.curve,
      pairToken: launched.pairToken,
      launchConfigId: launched.launchConfigId,
    };
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

    const reused = await findReusablePending(body.idempotencyKey, "staking_create", wallet);
    if (reused && "conflict" in reused) return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT" });
    if (reused && "action" in reused) {
      const payload = reused.action.payload as {
        tx: TxBundle;
        approveTx?: TxBundle | null;
        fee: string;
      };
      return {
        actionId: reused.action.id,
        tx: payload.tx,
        approveTx: payload.approveTx ?? null,
        needsApproval: Boolean(payload.approveTx),
        feeWei: payload.fee,
      };
    }

    let rewardAmount: bigint;
    try {
      rewardAmount = parseRawAmount(body.rewardAmount);
    } catch {
      return reply.code(400).send({ error: "INVALID_AMOUNT" });
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
        rewardAmount,
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
    const approveTx = await buildApproveIfNeeded({
      wallet,
      token: stakeToken,
      spender: env.STAKING_FACTORY_ADDRESS,
      amount: rewardAmount,
    });

    const pending = await savePendingAction({
      kind: "staking_create",
      wallet,
      idempotency: body.idempotencyKey,
      payload: { ...body, wallet, stakeToken, fee: fee.toString(), tx, approveTx },
    });

    return {
      actionId: pending.id,
      tx,
      approveTx: approveTx ?? null,
      needsApproval: Boolean(approveTx),
      feeWei: fee.toString(),
    };
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

    const reused = await findReusablePending(body.idempotencyKey, "devlock_create", wallet);
    if (reused && "conflict" in reused) return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT" });
    if (reused && "action" in reused) {
      const payload = reused.action.payload as {
        tx: TxBundle;
        approveTx?: TxBundle | null;
        fee: string;
      };
      return {
        actionId: reused.action.id,
        tx: payload.tx,
        approveTx: payload.approveTx ?? null,
        needsApproval: Boolean(payload.approveTx),
        feeWei: payload.fee,
      };
    }

    let amount: bigint;
    try {
      amount = parseRawAmount(body.amount);
    } catch {
      return reply.code(400).send({ error: "INVALID_AMOUNT" });
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
              amount,
              BigInt(body.cliffAt ?? body.unlockAt),
              BigInt(body.unlockAt),
              body.cadence ?? 0,
            ],
          })
        : encodeFunctionData({
            abi: devLockAbi,
            functionName: "createTimeLock",
            args: [token as Address, amount, BigInt(body.unlockAt)],
          });

    const tx: TxBundle = {
      to: env.DEV_LOCK_ADDRESS as Address,
      data,
      value: fee.toString(),
    };
    const approveTx = await buildApproveIfNeeded({
      wallet,
      token,
      spender: env.DEV_LOCK_ADDRESS,
      amount,
    });

    const pending = await savePendingAction({
      kind: "devlock_create",
      wallet,
      idempotency: body.idempotencyKey,
      payload: { ...body, wallet, token, fee: fee.toString(), tx, approveTx },
    });

    return {
      actionId: pending.id,
      tx,
      approveTx: approveTx ?? null,
      needsApproval: Boolean(approveTx),
      feeWei: fee.toString(),
    };
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
