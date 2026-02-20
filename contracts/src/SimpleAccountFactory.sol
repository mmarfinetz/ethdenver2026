// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import {SimpleAccount} from "./SimpleAccount.sol";

contract SimpleAccountFactory {
    address public immutable entryPoint;

    event AccountCreated(address indexed owner, uint256 indexed salt, address account);

    constructor(address _entryPoint) {
        entryPoint = _entryPoint;
    }

    function createAccount(address owner, uint256 salt) external returns (SimpleAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length > 0) {
            return SimpleAccount(payable(predicted));
        }

        account = new SimpleAccount{salt: bytes32(salt)}(owner, entryPoint);
        emit AccountCreated(owner, salt, address(account));
    }

    function getAddress(address owner, uint256 salt) public view returns (address predicted) {
        bytes memory bytecode = abi.encodePacked(type(SimpleAccount).creationCode, abi.encode(owner, entryPoint));
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), keccak256(bytecode))
        );
        predicted = address(uint160(uint256(hash)));
    }
}
