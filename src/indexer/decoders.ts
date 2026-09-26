import {
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
} from "viem";
import {
  devLockAbi,
  launchRegistryAbi,
  stakingFactoryAbi,
  stakingVaultAbi,
} from "../abi/looting.js";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ensureWallet, normalizeAddress } from "../lib/utils.js";

function asAddress(value: unknown): string {
  return normalizeAddress(String(value));
}

export async function handleLog(log: Log, blockTimestamp: Date): Promise<void> {
  const address = log.address.toLowerCase();

  if (env.LAUNCH_REGISTRY_ADDRESS && address === env.LAUNCH_REGISTRY_ADDRESS.toLowerCase()) {
    await handleRegistryLog(log, blockTimestamp);
    return;
  }

  if (env.STAKING_FACTORY_ADDRESS && address === env.STAKING_FACTORY_ADDRESS.toLowerCase()) {
    await handleFactoryLog(log, blockTimestamp);
    return;
  }

  if (env.DEV_LOCK_ADDRESS && address === env.DEV_LOCK_ADDRESS.toLowerCase()) {
    await handleDevLockLog(log, blockTimestamp);
    return;
  }

  // Vault events: match by known vault addresses in DB
  const vault = await prisma.stakingVault.findUnique({
    where: { chainId_vaultAddress: { chainId: env.CHAIN_ID, vaultAddress: address } },
  });
  if (vault) {
    await handleVaultLog(log, vault.id, vault.vaultId);
  }
}

async function handleRegistryLog(log: Log, blockTimestamp: Date) {
  try {
    const decoded = decodeEventLog({
      abi: launchRegistryAbi,
      data: log.data,
      topics: log.topics,
    });

    if (decoded.eventName === "LaunchRegistered") {
      const token = asAddress(decoded.args.token);
      const creator = asAddress(decoded.args.creator);
      await prisma.launch.upsert({
        where: { chainId_token: { chainId: env.CHAIN_ID, token } },
        create: {
          chainId: env.CHAIN_ID,
          token,
          creator,
          launchTxHash: log.transactionHash?.toLowerCase(),
          launchBlock: log.blockNumber ?? undefined,
          launchedAt: blockTimestamp,
        },
        update: {
          creator,
          launchTxHash: log.transactionHash?.toLowerCase(),
          launchBlock: log.blockNumber ?? undefined,
        },
      });
    }

    if (decoded.eventName === "RewardSplitConfigured") {
      const token = asAddress(decoded.args.token);
      await prisma.launch.updateMany({
        where: { chainId: env.CHAIN_ID, token },
        data: {
          creatorBps: Number(decoded.args.creatorBps),
          luckyBoxBps: Number(decoded.args.luckyBoxBps),
          totalCreatorFeeBps:
            Number(decoded.args.creatorBps) + Number(decoded.args.luckyBoxBps),
        },
      });
    }

    if (decoded.eventName === "LaunchPhaseUpdated") {
      const token = asAddress(decoded.args.token);
      const phase = Number(decoded.args.phase) === 1 ? "graduated" : "curve";
      await prisma.launch.updateMany({
        where: { chainId: env.CHAIN_ID, token },
        data: { phase },
      });
    }

    if (decoded.eventName === "RewardProgramPaused") {
      const token = asAddress(decoded.args.token);
      await prisma.launch.updateMany({
        where: { chainId: env.CHAIN_ID, token },
        data: { rewardsEnabled: false, status: "paused" },
      });
    }

    if (decoded.eventName === "RewardProgramResumed") {
      const token = asAddress(decoded.args.token);
      await prisma.launch.updateMany({
        where: { chainId: env.CHAIN_ID, token },
        data: { rewardsEnabled: true, status: "active" },
      });
    }
  } catch {
    // Not a matching event for this ABI topic set.
  }
}

async function handleFactoryLog(log: Log, _blockTimestamp: Date) {
  try {
    const decoded = decodeEventLog({
      abi: stakingFactoryAbi,
      data: log.data,
      topics: log.topics,
    });

    if (decoded.eventName !== "StakingVaultCreated") return;

    const vaultId = BigInt(decoded.args.vaultId);
    const vaultAddress = asAddress(decoded.args.vault);
    const stakeToken = asAddress(decoded.args.stakeToken);
    const creator = asAddress(decoded.args.creator);
    const rewardAmount = decoded.args.rewardAmount.toString();
    const feePaid = decoded.args.feePaid.toString();
    const endsAt = new Date(Number(decoded.args.endsAt) * 1000);
    const lockMask = Number(decoded.args.lockMask);

    const launch = await prisma.launch.findUnique({
      where: { chainId_token: { chainId: env.CHAIN_ID, token: stakeToken } },
    });

    await prisma.stakingVault.upsert({
      where: { chainId_vaultId: { chainId: env.CHAIN_ID, vaultId } },
      create: {
        chainId: env.CHAIN_ID,
        vaultId,
        vaultAddress,
        stakeToken,
        launchId: launch?.id,
        creator,
        rewardFunded: rewardAmount,
        rewardRemaining: rewardAmount,
        endsAt,
        lockMask,
        createTxHash: log.transactionHash?.toLowerCase(),
        createBlock: log.blockNumber ?? undefined,
        feePaidWei: feePaid,
      },
      update: {
        vaultAddress,
        rewardFunded: rewardAmount,
        rewardRemaining: rewardAmount,
        endsAt,
        lockMask,
      },
    });
  } catch {
    // ignore unrelated topics
  }
}

async function handleVaultLog(log: Log, vaultDbId: string, vaultId: bigint) {
  try {
    const decoded = decodeEventLog({
      abi: stakingVaultAbi,
      data: log.data,
      topics: log.topics,
    });

    const wallet = asAddress(decoded.args.wallet);
    const lockId = Number(decoded.args.lockId);
    const amount = decoded.args.amount;
    const user = await ensureWallet(env.CHAIN_ID, wallet);

    if (decoded.eventName === "Staked") {
      const existing = await prisma.stakingPosition.findUnique({
        where: {
          vaultId_walletAddress_lockId: {
            vaultId: vaultDbId,
            walletAddress: wallet,
            lockId,
          },
        },
      });
      const nextAmount = (existing ? BigInt(existing.amount.toFixed(0)) : 0n) + amount;
      await prisma.stakingPosition.upsert({
        where: {
          vaultId_walletAddress_lockId: {
            vaultId: vaultDbId,
            walletAddress: wallet,
            lockId,
          },
        },
        create: {
          vaultId: vaultDbId,
          walletId: user.id,
          walletAddress: wallet,
          lockId,
          amount: nextAmount.toString(),
          lockStartedAt: new Date(),
        },
        update: {
          amount: nextAmount.toString(),
          lockStartedAt: new Date(),
        },
      });

      await prisma.stakingVault.update({
        where: { id: vaultDbId },
        data: {
          totalStaked: { increment: amount.toString() },
          stakerCount: existing ? undefined : { increment: 1 },
        },
      });

      await prisma.stakingActivity.create({
        data: {
          chainId: env.CHAIN_ID,
          vaultId: vaultId.toString(),
          vaultDbId,
          walletAddress: wallet,
          kind: "stake",
          lockId,
          amount: amount.toString(),
          txHash: log.transactionHash?.toLowerCase(),
        },
      });
    }

    if (decoded.eventName === "Unstaked") {
      const existing = await prisma.stakingPosition.findUnique({
        where: {
          vaultId_walletAddress_lockId: {
            vaultId: vaultDbId,
            walletAddress: wallet,
            lockId,
          },
        },
      });
      if (!existing) return;
      const next = BigInt(existing.amount.toFixed(0)) - amount;
      if (next <= 0n) {
        await prisma.stakingPosition.delete({ where: { id: existing.id } });
        await prisma.stakingVault.update({
          where: { id: vaultDbId },
          data: {
            totalStaked: { decrement: amount.toString() },
            stakerCount: { decrement: 1 },
          },
        });
      } else {
        await prisma.stakingPosition.update({
          where: { id: existing.id },
          data: { amount: next.toString() },
        });
        await prisma.stakingVault.update({
          where: { id: vaultDbId },
          data: { totalStaked: { decrement: amount.toString() } },
        });
      }

      await prisma.stakingActivity.create({
        data: {
          chainId: env.CHAIN_ID,
          vaultId: vaultId.toString(),
          vaultDbId,
          walletAddress: wallet,
          kind: "unstake",
          lockId,
          amount: amount.toString(),
          txHash: log.transactionHash?.toLowerCase(),
        },
      });
    }

    if (decoded.eventName === "StakingRewardsClaimed") {
      await prisma.stakingPosition.updateMany({
        where: { vaultId: vaultDbId, walletAddress: wallet, lockId },
        data: { rewardsClaimed: { increment: amount.toString() } },
      });
      await prisma.stakingVault.update({
        where: { id: vaultDbId },
        data: { rewardRemaining: { decrement: amount.toString() } },
      });
      await prisma.stakingActivity.create({
        data: {
          chainId: env.CHAIN_ID,
          vaultId: vaultId.toString(),
          vaultDbId,
          walletAddress: wallet,
          kind: "claim",
          lockId,
          amount: "0",
          reward: amount.toString(),
          txHash: log.transactionHash?.toLowerCase(),
        },
      });
    }

    void vaultId;
  } catch {
    // ignore
  }
}

async function handleDevLockLog(log: Log, blockTimestamp: Date) {
  try {
    const decoded = decodeEventLog({
      abi: devLockAbi,
      data: log.data,
      topics: log.topics,
    });

    if (decoded.eventName === "DevLockCreated") {
      const lockId = BigInt(decoded.args.lockId);
      const owner = asAddress(decoded.args.owner);
      const token = asAddress(decoded.args.token);
      const mode = Number(decoded.args.mode) === 1 ? "vest" : "time";
      const amount = decoded.args.amount.toString();
      const cliffAt = new Date(Number(decoded.args.cliff) * 1000);
      const unlockAt = new Date(Number(decoded.args.unlock) * 1000);
      const launch = await prisma.launch.findUnique({
        where: { chainId_token: { chainId: env.CHAIN_ID, token } },
      });

      await prisma.devLock.upsert({
        where: { chainId_lockId: { chainId: env.CHAIN_ID, lockId } },
        create: {
          chainId: env.CHAIN_ID,
          lockId,
          owner,
          token,
          launchId: launch?.id,
          mode,
          amount,
          startAt: blockTimestamp,
          cliffAt,
          unlockAt,
          createTxHash: log.transactionHash?.toLowerCase(),
        },
        update: {
          amount,
          cliffAt,
          unlockAt,
        },
      });
    }

    if (decoded.eventName === "DevLockClaimed") {
      const lockId = BigInt(decoded.args.lockId);
      const amount = decoded.args.amount;
      const lock = await prisma.devLock.findUnique({
        where: { chainId_lockId: { chainId: env.CHAIN_ID, lockId } },
      });
      if (!lock) return;
      const claimed = BigInt(lock.claimed.toFixed(0)) + amount;
      const fully = claimed >= BigInt(lock.amount.toFixed(0));
      await prisma.devLock.update({
        where: { id: lock.id },
        data: {
          claimed: claimed.toString(),
          status: fully ? "closed" : "active",
        },
      });
    }
  } catch {
    // ignore
  }
}

export function watchedAddresses(): Address[] {
  const addrs: Address[] = [];
  if (env.LAUNCH_REGISTRY_ADDRESS) addrs.push(env.LAUNCH_REGISTRY_ADDRESS as Address);
  if (env.STAKING_FACTORY_ADDRESS) addrs.push(env.STAKING_FACTORY_ADDRESS as Address);
  if (env.DEV_LOCK_ADDRESS) addrs.push(env.DEV_LOCK_ADDRESS as Address);
  return addrs;
}

export type { Hex };
