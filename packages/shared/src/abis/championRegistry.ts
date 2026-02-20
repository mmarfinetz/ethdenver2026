export const championRegistryAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_lineageArchiveRoot", type: "bytes32" },
      { name: "_provenanceArchiveRoot", type: "bytes32" }
    ]
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "lineageArchiveRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "provenanceArchiveRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "championCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "currentChampionId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "registerChampion",
    stateMutability: "nonpayable",
    inputs: [
      { name: "parentChampionId", type: "uint256" },
      { name: "lineageHash", type: "bytes32" },
      { name: "candidateHash", type: "bytes32" },
      { name: "provenanceHash", type: "bytes32" },
      { name: "gateHash", type: "bytes32" },
      { name: "promote", type: "bool" }
    ],
    outputs: [{ name: "championId", type: "uint256" }]
  },
  {
    type: "function",
    name: "promoteChampion",
    stateMutability: "nonpayable",
    inputs: [{ name: "championId", type: "uint256" }],
    outputs: []
  },
  {
    type: "function",
    name: "getChampion",
    stateMutability: "view",
    inputs: [{ name: "championId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "championId", type: "uint256" },
          { name: "parentChampionId", type: "uint256" },
          { name: "lineageHash", type: "bytes32" },
          { name: "candidateHash", type: "bytes32" },
          { name: "provenanceHash", type: "bytes32" },
          { name: "gateHash", type: "bytes32" },
          { name: "createdAt", type: "uint64" },
          { name: "submitter", type: "address" }
        ]
      }
    ]
  },
  {
    type: "event",
    name: "ChampionRegistered",
    anonymous: false,
    inputs: [
      { name: "championId", type: "uint256", indexed: true },
      { name: "parentChampionId", type: "uint256", indexed: true },
      { name: "candidateHash", type: "bytes32", indexed: true },
      { name: "provenanceHash", type: "bytes32", indexed: false },
      { name: "promoted", type: "bool", indexed: false }
    ]
  },
  {
    type: "event",
    name: "CurrentChampionUpdated",
    anonymous: false,
    inputs: [
      { name: "previousChampionId", type: "uint256", indexed: true },
      { name: "currentChampionId", type: "uint256", indexed: true }
    ]
  }
] as const;
