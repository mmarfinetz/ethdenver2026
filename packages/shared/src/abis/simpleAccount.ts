export const simpleAccountAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address[]" },
      { name: "func", type: "bytes[]" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "entryPoint",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

export const simpleAccountFactoryAbi = [
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" }
    ],
    outputs: [{ name: "ret", type: "address" }]
  },
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" }
    ],
    outputs: [{ name: "", type: "address" }]
  }
] as const;
