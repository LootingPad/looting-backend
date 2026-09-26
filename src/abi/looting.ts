export const launchRegistryAbi = [
  {
    type: "event",
    name: "LaunchRegistered",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RewardSplitConfigured",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creatorBps", type: "uint16", indexed: false },
      { name: "luckyBoxBps", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchPhaseUpdated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "phase", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardProgramPaused",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "reason", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RewardProgramResumed",
    inputs: [{ name: "token", type: "address", indexed: true }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "creator", type: "address" },
          { name: "creatorFeeRouter", type: "address" },
          { name: "creatorBps", type: "uint16" },
          { name: "luckyBoxBps", type: "uint16" },
          { name: "totalCreatorFeeBps", type: "uint16" },
          { name: "holderShareEnabled", type: "bool" },
          { name: "quoteAsset", type: "address" },
          { name: "launchedAt", type: "uint64" },
          { name: "phase", type: "uint8" },
          { name: "rewardsEnabled", type: "bool" },
          { name: "configHash", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "configOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "creator", type: "address" },
          { name: "creatorFeeRouter", type: "address" },
          { name: "creatorBps", type: "uint16" },
          { name: "luckyBoxBps", type: "uint16" },
          { name: "totalCreatorFeeBps", type: "uint16" },
          { name: "holderShareEnabled", type: "bool" },
          { name: "quoteAsset", type: "address" },
          { name: "launchedAt", type: "uint64" },
          { name: "phase", type: "uint8" },
          { name: "rewardsEnabled", type: "bool" },
          { name: "configHash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

export const stakingFactoryAbi = [
  {
    type: "event",
    name: "StakingVaultCreated",
    inputs: [
      { name: "vaultId", type: "uint256", indexed: true },
      { name: "vault", type: "address", indexed: true },
      { name: "stakeToken", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: false },
      { name: "rewardAmount", type: "uint256", indexed: false },
      { name: "feePaid", type: "uint256", indexed: false },
      { name: "endsAt", type: "uint64", indexed: false },
      { name: "lockMask", type: "uint8", indexed: false },
    ],
  },
  {
    type: "function",
    name: "createVault",
    stateMutability: "payable",
    inputs: [
      { name: "stakeToken", type: "address" },
      { name: "rewardAmount", type: "uint256" },
      { name: "endsAt", type: "uint64" },
      { name: "lockMask", type: "uint8" },
      { name: "aprBps", type: "uint16[3]" },
    ],
    outputs: [
      { name: "vault", type: "address" },
      { name: "vaultId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const stakingVaultAbi = [
  {
    type: "event",
    name: "Staked",
    inputs: [
      { name: "vaultId", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "lockId", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Unstaked",
    inputs: [
      { name: "vaultId", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "lockId", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StakingRewardsClaimed",
    inputs: [
      { name: "vaultId", type: "uint256", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "lockId", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "stake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "lockId", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unstake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "lockId", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRewards",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint8" }],
    outputs: [{ name: "paid", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingRewards",
    stateMutability: "view",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "lockId", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "lockId", type: "uint8" },
    ],
    outputs: [
      { name: "staked", type: "uint256" },
      { name: "rewardDebtOrAccrued", type: "uint256" },
      { name: "lockEndsAt", type: "uint64" },
    ],
  },
] as const;

export const devLockAbi = [
  {
    type: "event",
    name: "DevLockCreated",
    inputs: [
      { name: "lockId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "mode", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "cliff", type: "uint64", indexed: false },
      { name: "unlock", type: "uint64", indexed: false },
      { name: "feePaid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DevLockClaimed",
    inputs: [
      { name: "lockId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "createTimeLock",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "unlockAt", type: "uint64" },
    ],
    outputs: [{ name: "lockId", type: "uint256" }],
  },
  {
    type: "function",
    name: "createVesting",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "cliffAt", type: "uint64" },
      { name: "unlockAt", type: "uint64" },
      { name: "cadence", type: "uint8" },
    ],
    outputs: [{ name: "lockId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [{ name: "paid", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimableAmount",
    stateMutability: "view",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "vestedAmount",
    stateMutability: "view",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
