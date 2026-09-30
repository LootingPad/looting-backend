import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { env } from "../config/env.js";
import { getEthUsd } from "../clients/eth-price.js";
import { getPublic } from "../clients/keeper.js";
import { prisma } from "../db/prisma.js";
import { toFeLuckyBox } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import { ensureActiveRewardTable, outcomesFromConfig } from "./config-public.js";
import {
  countOutstandingBoxes,
  encodeClaimEthPrize,
  rollPrizeAmountWei,
  settlePrize,
} from "../services/lucky-box-prize.js";

/**
 * Deterministic sealed-table pick (spec §14 without VRF):
 * hash(boxId + tableId) mod totalWeight → outcome. Verifiable against stored config.
 */
function pickOutcome(
  boxId: string,
  tableId: string,
  outcomes: ReturnType<typeof outcomesFromConfig>,
): { outcome: (typeof outcomes)[number]; index: number; digest: string } {
  const total = outcomes.reduce((sum, o) => sum + Math.max(1, o.weight), 0);
  const digest = createHash("sha256").update(`${boxId}:${tableId}`).digest("hex");
  const n = Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(Math.max(1, total)));
  let cursor = 0;
  for (let i = 0; i < outcomes.length; i++) {
    cursor += Math.max(1, outcomes[i].weight);
    if (n < cursor) return { outcome: outcomes[i], index: i, digest };
  }
  const last = outcomes[outcomes.length - 1]!;
  return { outcome: last, index: outcomes.length - 1, digest };
}

const rewardRouterAbi = parseAbi([
  "function luckyBoxClaimable(address token) view returns (uint256)",
]);

const ethModuleAbi = parseAbi([
  "function pendingEth(address winner, address token) view returns (uint256)",
]);

function boxIdBytes32(boxId: string): Hex {
  return keccak256(stringToHex(boxId));
}

async function prizeMetaForToken(prizeToken: string | null | undefined) {
  if (!prizeToken || prizeToken === "ETH") return { prizeLabel: "ETH" as string | null, prizeDecimals: 18 };
  const row = await prisma.rewardPrizeToken.findFirst({
    where: { token: prizeToken.toLowerCase() },
  });
  return {
    prizeLabel: row?.label ?? null,
    prizeDecimals: row?.decimals ?? 18,
  };
}

export async function registerLuckyBoxRoutes(app: FastifyInstance) {
  /** Open an exited/unclaimed box against the active sealed reward table. */
  app.post("/api/lucky-boxes/:boxId/open", async (req, reply) => {
    const { boxId } = req.params as { boxId: string };
    const body = (req.body ?? {}) as { wallet?: string };

    const box = await prisma.luckyBox.findUnique({
      where: { boxId },
      include: { wallet: true, launch: true, rewards: true },
    });
    if (!box) return reply.code(404).send({ error: "NOT_FOUND" });

    if (body.wallet) {
      let wallet: string;
      try {
        wallet = normalizeAddress(body.wallet);
      } catch {
        return reply.code(400).send({ error: "INVALID_ADDRESS" });
      }
      if (box.wallet.wallet !== wallet) return reply.code(403).send({ error: "NOT_OWNER" });
    }

    if (box.openedAt) {
      const shaped = toFeLuckyBox(box, { token: box.launch?.token, symbol: box.launch?.symbol });
      const last = box.rewards[box.rewards.length - 1];
      if (last?.rewardType) shaped.reward = last.rewardType;
      return {
        data: shaped,
        already: box.status === "claimed" ? "claimed" : "opened",
        reward: last?.rewardType ?? shaped.reward,
      };
    }

    if (box.status === "claimed" && box.openedAt) {
      return { data: toFeLuckyBox(box, { token: box.launch?.token, symbol: box.launch?.symbol }), already: "claimed" };
    }
    if (box.status === "in_market") {
      return reply.code(409).send({ error: "STILL_IN_MARKET", message: "Exit the position before opening." });
    }
    if (box.status === "not_eligible") {
      return reply.code(409).send({ error: "NOT_ELIGIBLE" });
    }

    const table = await ensureActiveRewardTable();
    const outcomes = outcomesFromConfig(table.config);
    const pick = pickOutcome(box.boxId, table.id, outcomes);
    const outcome = pick.outcome;
    const isMiss = outcome.kind === "miss";

    let creditedWei = 0n;
    let settle: Awaited<ReturnType<typeof settlePrize>> | null = null;

    if (!isMiss && box.launch?.token && env.LOOTING_REWARD_ROUTER && env.LOOTING_LUCKY_BOX_ETH_MODULE) {
      try {
        const client = getPublic();
        const claimable = (await client.readContract({
          address: getAddress(env.LOOTING_REWARD_ROUTER) as Address,
          abi: rewardRouterAbi,
          functionName: "luckyBoxClaimable",
          args: [getAddress(box.launch.token) as Address],
        })) as bigint;

        const outstanding = await countOutstandingBoxes(box.launchId!);
        creditedWei = rollPrizeAmountWei({
          poolWei: claimable,
          outstandingBoxes: outstanding,
          outcome,
          digestHex: pick.digest,
        });

        if (creditedWei > 0n) {
          settle = await settlePrize({
            launchToken: box.launch.token,
            winner: box.wallet.wallet,
            boxId: box.boxId,
            boxIdBytes32: boxIdBytes32(box.boxId),
            amountWei: creditedWei,
            outcome,
          });

          // Quote/module missing — leave box sealed so user can retry.
          if (settle.abortOpen) {
            return reply.code(503).send({
              error: "PRIZE_SETTLE_UNAVAILABLE",
              message:
                "Prize token has no swap route right now. Try again shortly, or ask admin to switch odds to ETH.",
              kind: outcome.kind,
              label: outcome.label,
              creditedWei: creditedWei.toString(),
            });
          }

          if (!settle.creditTx && !settle.swapTx && !settle.settled) {
            creditedWei = 0n;
            settle = null;
          }
        }
      } catch (err) {
        console.warn("[lucky-boxes] open credit skipped", box.boxId, err);
        return reply.code(503).send({
          error: "PRIZE_SETTLE_ERROR",
          message: "Could not settle prize. Box left unopened — try again.",
        });
      }
    }

    const paidAsEth = settle?.paidAs === "eth" || outcome.kind === "eth";
    const paidAsErc20 = settle?.paidAs === "erc20";
    const prizeTokenStored = paidAsErc20
      ? outcome.prizeToken ?? null
      : creditedWei > 0n && (paidAsEth || settle?.claimableOnChain)
        ? "ETH"
        : null;

    const ethClaimPending = Boolean(settle?.claimableOnChain && creditedWei > 0n);
    const erc20Failed =
      outcome.kind === "erc20" && creditedWei > 0n && settle && !settle.settled && !settle.abortOpen;
    const rewardStatus = ethClaimPending
      ? "pending"
      : erc20Failed
        ? "failed"
        : "claimed";

    const updated = await prisma.$transaction(async (tx) => {
      await tx.reward.create({
        data: {
          walletId: box.walletId,
          launchId: box.launchId,
          luckyBoxId: box.id,
          rewardType: settle?.paidAs === "eth" && outcome.kind === "erc20" ? "ETH" : outcome.label,
          token: prizeTokenStored,
          amount: creditedWei > 0n ? creditedWei.toString() : null,
          status: rewardStatus,
          swapTxHash: settle?.swapTx ?? settle?.creditTx ?? undefined,
          swapInput: creditedWei > 0n ? creditedWei.toString() : undefined,
          swapOutput: settle?.swapOutput != null ? settle.swapOutput.toString() : undefined,
        },
      });

      await tx.luckyBox.update({
        where: { id: box.id },
        data: {
          status: ethClaimPending ? "exited" : "claimed",
          openedAt: new Date(),
          claimedAt: ethClaimPending ? null : new Date(),
          rewardConfigHash: pick.digest,
        },
      });

      return tx.luckyBox.findUniqueOrThrow({
        where: { id: box.id },
        include: { rewards: true, launch: true },
      });
    });

    const ethUsd = await getEthUsd().catch(() => 0);
    const meta = await prizeMetaForToken(
      outcome.kind === "erc20" ? outcome.prizeToken : outcome.kind === "eth" ? "ETH" : null,
    );

    const shaped = toFeLuckyBox(updated, { token: updated.launch?.token, symbol: updated.launch?.symbol }, {
      ethUsd,
      prizeLabel: meta.prizeLabel ?? (outcome.kind === "eth" ? "ETH" : outcome.label),
      prizeDecimals: meta.prizeDecimals,
    });
    shaped.reward = settle?.paidAs === "eth" && outcome.kind === "erc20" ? "ETH" : outcome.label;
    shaped.prizeKind = settle?.paidAs === "erc20" ? "erc20" : settle?.paidAs === "eth" || outcome.kind === "eth" ? "eth" : outcome.kind;
    if (outcome.prizeToken && shaped.prizeKind === "erc20") shaped.prizeToken = outcome.prizeToken;
    if (creditedWei > 0n) {
      shaped.creditedWei = creditedWei.toString();
      const eth = Number(creditedWei) / 1e18;
      if (ethUsd > 0 && eth > 0) shaped.payoutUsd = eth * ethUsd;
    }
    if (settle?.swapOutput != null && settle.swapOutput > 0n && settle.paidAs === "erc20") {
      shaped.prizeAmount = Number(settle.swapOutput) / 10 ** meta.prizeDecimals;
      shaped.prizeSymbol = meta.prizeLabel ?? outcome.label;
    } else if ((settle?.paidAs === "eth" || outcome.kind === "eth") && creditedWei > 0n) {
      shaped.prizeAmount = Number(creditedWei) / 1e18;
      shaped.prizeSymbol = "ETH";
    }
    shaped.claimableOnChain = Boolean(settle?.claimableOnChain);
    shaped.status = ethClaimPending ? "opened" : "claimed";
    if (settle?.swapTx) shaped.tx = settle.swapTx;
    else if (settle?.creditTx) shaped.tx = settle.creditTx;

    await prisma.pendingAction.create({
      data: {
        kind: "lucky_box_open",
        wallet: box.wallet.wallet,
        payload: {
          boxId: box.boxId,
          reward: outcome.label,
          kind: outcome.kind,
          prizeToken: outcome.prizeToken ?? null,
          digest: pick.digest,
          tableId: table.id,
          index: pick.index,
          creditedWei: creditedWei.toString(),
          payoutUsd: shaped.payoutUsd ?? null,
          prizeAmount: shaped.prizeAmount ?? null,
          prizeSymbol: shaped.prizeSymbol ?? null,
          creditTx: settle?.creditTx ?? null,
          swapTx: settle?.swapTx ?? null,
          outstandingReserved: true,
        },
        status: "confirmed",
      },
    });

    return {
      data: shaped,
      // Actual payout (ETH fallback when ERC-20 route is missing), not the table roll label alone.
      reward: shaped.reward ?? outcome.label,
      kind: shaped.prizeKind ?? outcome.kind,
      digest: pick.digest,
      tableId: table.id,
      creditedWei: creditedWei.toString(),
      payoutUsd: shaped.payoutUsd ?? null,
      prizeAmount: shaped.prizeAmount ?? null,
      prizeSymbol: shaped.prizeSymbol ?? null,
      creditTx: settle?.creditTx ?? null,
      swapTx: settle?.swapTx ?? null,
      claimableOnChain: Boolean(settle?.claimableOnChain),
    };
  });

  /**
   * Prepare on-chain claim of credited ETH prize (LootingLuckyBoxEthModule.claimEthPrize).
   */
  app.post("/api/lucky-boxes/:boxId/claim", async (req, reply) => {
    const { boxId } = req.params as { boxId: string };
    const body = (req.body ?? {}) as { wallet?: string };

    const box = await prisma.luckyBox.findUnique({
      where: { boxId },
      include: { wallet: true, launch: true, rewards: true },
    });
    if (!box) return reply.code(404).send({ error: "NOT_FOUND" });

    let wallet = box.wallet.wallet;
    if (body.wallet) {
      try {
        wallet = normalizeAddress(body.wallet);
      } catch {
        return reply.code(400).send({ error: "INVALID_ADDRESS" });
      }
      if (box.wallet.wallet !== wallet) return reply.code(403).send({ error: "NOT_OWNER" });
    }

    if (!box.openedAt && box.status !== "claimed") {
      return reply.code(409).send({ error: "NOT_OPENED", message: "Open the box first." });
    }

    const token = box.launch?.token;
    if (!token || !env.LOOTING_LUCKY_BOX_ETH_MODULE) {
      await prisma.reward.updateMany({
        where: { luckyBoxId: box.id, status: { in: ["pending", "swapping"] } },
        data: { status: "claimed" },
      });
      const updated = await prisma.luckyBox.update({
        where: { id: box.id },
        data: { status: "claimed", claimedAt: box.claimedAt ?? new Date() },
        include: { rewards: true, launch: true },
      });
      return {
        data: toFeLuckyBox(updated, { token: updated.launch?.token, symbol: updated.launch?.symbol }),
        onChain: false,
        reason: "ETH_MODULE_NOT_SET",
      };
    }

    const pendingReward = box.rewards.find((r) => r.status === "pending" || r.status === "swapping");
    // ERC-20 prizes settle at open — nothing left to claim on-chain.
    if (pendingReward?.token && pendingReward.token !== "ETH" && pendingReward.token.startsWith("0x")) {
      await prisma.reward.updateMany({
        where: { luckyBoxId: box.id, status: { in: ["pending", "swapping"] } },
        data: { status: "claimed" },
      });
      const updated = await prisma.luckyBox.update({
        where: { id: box.id },
        data: { status: "claimed", claimedAt: box.claimedAt ?? new Date() },
        include: { rewards: true, launch: true },
      });
      return {
        data: toFeLuckyBox(updated, { token: updated.launch?.token, symbol: updated.launch?.symbol }),
        onChain: false,
        reason: "ERC20_ALREADY_SETTLED",
        message: "ERC-20 prize was sent at open; no ETH claim needed.",
      };
    }

    const module = getAddress(env.LOOTING_LUCKY_BOX_ETH_MODULE) as Address;
    const client = getPublic();
    const pending = (await client.readContract({
      address: module,
      abi: ethModuleAbi,
      functionName: "pendingEth",
      args: [getAddress(wallet) as Address, getAddress(token) as Address],
    })) as bigint;

    if (pending === 0n) {
      await prisma.reward.updateMany({
        where: { luckyBoxId: box.id, status: { in: ["pending", "swapping"] } },
        data: { status: "claimed" },
      });
      const updated = await prisma.luckyBox.update({
        where: { id: box.id },
        data: { status: "claimed", claimedAt: box.claimedAt ?? new Date() },
        include: { rewards: true, launch: true },
      });
      return {
        data: toFeLuckyBox(updated, { token: updated.launch?.token, symbol: updated.launch?.symbol }),
        onChain: false,
        reason: "NOTHING_PENDING",
        message: "No on-chain ETH prize pending (miss or already claimed).",
      };
    }

    const call = {
      to: module,
      data: encodeClaimEthPrize(getAddress(token) as Address),
      value: "0",
    };

    return {
      data: toFeLuckyBox(box, { token: box.launch?.token, symbol: box.launch?.symbol }),
      onChain: true,
      mode: "eth_module",
      pendingWei: pending.toString(),
      calls: [call],
      message: "Confirm in wallet to claim ETH prize from LootingLuckyBoxEthModule.",
    };
  });

  /** Mark DB claimed after user confirms claimEthPrize. */
  app.post("/api/lucky-boxes/:boxId/claim/confirm", async (req, reply) => {
    const { boxId } = req.params as { boxId: string };
    const body = (req.body ?? {}) as { wallet?: string; txHash?: string };

    const box = await prisma.luckyBox.findUnique({
      where: { boxId },
      include: { wallet: true, launch: true, rewards: true },
    });
    if (!box) return reply.code(404).send({ error: "NOT_FOUND" });

    if (body.wallet) {
      let wallet: string;
      try {
        wallet = normalizeAddress(body.wallet);
      } catch {
        return reply.code(400).send({ error: "INVALID_ADDRESS" });
      }
      if (box.wallet.wallet !== wallet) return reply.code(403).send({ error: "NOT_OWNER" });
    }

    await prisma.reward.updateMany({
      where: { luckyBoxId: box.id, status: { in: ["pending", "swapping"] } },
      data: { status: "claimed", swapTxHash: body.txHash?.toLowerCase() || undefined },
    });

    const updated = await prisma.luckyBox.update({
      where: { id: box.id },
      data: { status: "claimed", claimedAt: new Date() },
      include: { rewards: true, launch: true },
    });

    return { data: toFeLuckyBox(updated, { token: updated.launch?.token, symbol: updated.launch?.symbol }) };
  });
}
