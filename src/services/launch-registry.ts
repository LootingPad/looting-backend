import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { env } from "../config/env.js";
import { getKeeperWallet, getPublic } from "../clients/keeper.js";

const registryAbi = parseAbi([
  "function isLaunch(address token) view returns (bool)",
  "function register((address token, address curve, address creator, address creatorFeeRouter, uint16 creatorBps, uint16 luckyBoxBps, uint16 totalCreatorFeeBps, bool holderShareEnabled, address quoteAsset, uint64 launchedAt, uint8 phase, bool rewardsEnabled, bytes32 configHash) config)",
]);

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Snapshot launch reward config on LootingLaunchRegistry (registrar-only).
 * Optional: register launch on-chain so RewardRouter.allocate can split LOOTING-funded ETH.
 */
export async function registerLaunchOnChain(input: {
  token: string;
  curve: string;
  creator: string;
  creatorBps: number;
  luckyBoxBps: number;
  totalCreatorFeeBps: number;
  holderShareEnabled?: boolean;
  quoteAsset?: string;
  configHash: Hex;
}): Promise<Hex | null> {
  if (!env.LAUNCH_REGISTRY_ADDRESS) return null;
  const keeper = getKeeperWallet();
  if (!keeper?.account) {
    console.warn("[launch-registry] keeper unset — skip on-chain register");
    return null;
  }

  const registry = getAddress(env.LAUNCH_REGISTRY_ADDRESS) as Address;
  const token = getAddress(input.token) as Address;
  const client = getPublic();

  try {
    const exists = (await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "isLaunch",
      args: [token],
    })) as boolean;
    if (exists) return null;

    const creatorFeeRouter = env.LOOTING_REWARD_ROUTER
      ? (getAddress(env.LOOTING_REWARD_ROUTER) as Address)
      : (getAddress(input.creator) as Address);

    const hash = await keeper.writeContract({
      address: registry,
      abi: registryAbi,
      functionName: "register",
      args: [
        {
          token,
          curve: getAddress(input.curve) as Address,
          creator: getAddress(input.creator) as Address,
          creatorFeeRouter,
          creatorBps: input.creatorBps,
          luckyBoxBps: input.luckyBoxBps,
          totalCreatorFeeBps: input.totalCreatorFeeBps,
          holderShareEnabled: Boolean(input.holderShareEnabled),
          quoteAsset: getAddress(input.quoteAsset || ZERO) as Address,
          launchedAt: BigInt(Math.floor(Date.now() / 1000)),
          phase: 0,
          rewardsEnabled: true,
          configHash: input.configHash,
        },
      ],
      chain: keeper.chain,
      account: keeper.account,
    });
    return hash;
  } catch (err) {
    console.warn("[launch-registry] register failed", input.token, err);
    return null;
  }
}
