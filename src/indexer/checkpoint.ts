import { prisma } from "../db/prisma.js";

export async function getCheckpoint(name: string) {
  return prisma.indexerCheckpoint.findUnique({ where: { name } });
}

export async function setCheckpoint(name: string, blockNumber: bigint, blockHash: string) {
  return prisma.indexerCheckpoint.upsert({
    where: { name },
    create: { name, blockNumber, blockHash },
    update: { blockNumber, blockHash },
  });
}
