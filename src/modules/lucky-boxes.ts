import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { toFeLuckyBox } from "../lib/fe-shape.js";
import { normalizeAddress } from "../lib/utils.js";
import { ensureActiveRewardTable, outcomesFromConfig } from "./config-public.js";

/**
 * Deterministic sealed-table pick (spec §14 without VRF):
 * hash(boxId + tableId) mod totalWeight → outcome. Verifiable against stored config.
 */
function pickOutcome(
  boxId: string,
  tableId: string,
  outcomes: Array<{ label: string; weight: number }>,
): { label: string; index: number; digest: string } {
  const total = outcomes.reduce((sum, o) => sum + Math.max(1, o.weight), 0);
  const digest = createHash("sha256").update(`${boxId}:${tableId}`).digest("hex");
  const n = Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(Math.max(1, total)));
  let cursor = 0;
  for (let i = 0; i < outcomes.length; i++) {
    cursor += Math.max(1, outcomes[i].weight);
    if (n < cursor) return { label: outcomes[i].label, index: i, digest };
  }
  return { label: outcomes[outcomes.length - 1]?.label ?? "No reward", index: outcomes.length - 1, digest };
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

    if (box.status === "claimed") {
      return { data: toFeLuckyBox(box, box.launch?.symbol ?? ""), already: "claimed" };
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

    const isMiss = pick.label.toLowerCase() === "no reward" || pick.label === "—";

    const updated = await prisma.$transaction(async (tx) => {
      const reward = await tx.reward.create({
        data: {
          walletId: box.walletId,
          launchId: box.launchId,
          luckyBoxId: box.id,
          rewardType: isMiss ? "none" : "table",
          token: null,
          amount: null,
          status: isMiss ? "claimed" : "pending",
        },
      });

      const next = await tx.luckyBox.update({
        where: { id: box.id },
        data: {
          status: isMiss ? "claimed" : "claimed",
          openedAt: new Date(),
          claimedAt: new Date(),
          rewardConfigHash: pick.digest,
        },
        include: { rewards: true, launch: true },
      });

      // Store display label on reward via note-less field: encode in rewardType token-ish
      await tx.reward.update({
        where: { id: reward.id },
        data: {
          rewardType: pick.label,
          status: "claimed",
        },
      });

      return tx.luckyBox.findUniqueOrThrow({
        where: { id: next.id },
        include: { rewards: true, launch: true },
      });
    });

    const shaped = toFeLuckyBox(updated, updated.launch?.symbol ?? "");
    shaped.reward = pick.label;
    shaped.status = "claimed";

    await prisma.pendingAction.create({
      data: {
        kind: "lucky_box_open",
        wallet: box.wallet.wallet,
        payload: {
          boxId: box.boxId,
          reward: pick.label,
          digest: pick.digest,
          tableId: table.id,
          index: pick.index,
        },
        status: "confirmed",
      },
    });

    return {
      data: shaped,
      reward: pick.label,
      digest: pick.digest,
      tableId: table.id,
    };
  });

  /**
   * Claim is a no-op settle after open until LootingLuckyBox / RewardRouter ship.
   * Marks any pending reward rows claimed and returns the FE box shape.
   */
  app.post("/api/lucky-boxes/:boxId/claim", async (req, reply) => {
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

    if (!box.openedAt && box.status !== "claimed") {
      return reply.code(409).send({ error: "NOT_OPENED", message: "Open the box first." });
    }

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
      data: toFeLuckyBox(updated, updated.launch?.symbol ?? ""),
      onChain: false,
      reason: "REWARD_ROUTER_NOT_DEPLOYED",
    };
  });
}
