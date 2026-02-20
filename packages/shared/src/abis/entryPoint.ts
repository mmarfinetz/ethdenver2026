export const entryPointAbi = [
  {
    type: "function",
    name: "handleOps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" }
        ]
      },
      { name: "beneficiary", type: "address" }
    ],
    outputs: []
  },
  {
    type: "event",
    name: "UserOperationEvent",
    anonymous: false,
    inputs: [
      { indexed: true, name: "userOpHash", type: "bytes32" },
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "paymaster", type: "address" },
      { indexed: false, name: "nonce", type: "uint256" },
      { indexed: false, name: "success", type: "bool" },
      { indexed: false, name: "actualGasCost", type: "uint256" },
      { indexed: false, name: "actualGasUsed", type: "uint256" }
    ]
  }
] as const;
