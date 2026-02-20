// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint {
    function getNonce(address sender, uint192 key) external view returns (uint256);
}

contract SimpleAccount {
    address public immutable entryPoint;
    address public owner;

    error NotAuthorized();
    error InvalidSignature();
    error CallFailed();

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);

    constructor(address _owner, address _entryPoint) {
        owner = _owner;
        entryPoint = _entryPoint;
        emit OwnerUpdated(address(0), _owner);
    }

    receive() external payable {}

    modifier onlyOwnerOrEntryPoint() {
        if (msg.sender != owner && msg.sender != entryPoint) revert NotAuthorized();
        _;
    }

    function execute(address dest, uint256 value, bytes calldata func) external onlyOwnerOrEntryPoint {
        (bool ok,) = dest.call{value: value}(func);
        if (!ok) revert CallFailed();
    }

    function executeBatch(address[] calldata dest, bytes[] calldata func) external onlyOwnerOrEntryPoint {
        if (dest.length != func.length) revert CallFailed();

        for (uint256 i = 0; i < dest.length; i++) {
            (bool ok,) = dest[i].call(func[i]);
            if (!ok) revert CallFailed();
        }
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotAuthorized();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function getNonce() external view returns (uint256) {
        return IEntryPoint(entryPoint).getNonce(address(this), 0);
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != entryPoint) revert NotAuthorized();

        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash)
        );

        if (!_isValidSignature(digest, userOp.signature)) revert InvalidSignature();

        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }

        validationData = 0;
    }

    function _isValidSignature(bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signature.length != 65) return false;

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;

        return ecrecover(digest, v, r, s) == owner;
    }
}
