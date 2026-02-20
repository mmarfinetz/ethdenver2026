// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import {SimpleAccountFactory} from "../src/SimpleAccountFactory.sol";

interface Vm {
    function envUint(string calldata key) external returns (uint256);
    function envAddress(string calldata key) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

abstract contract Script {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

contract DeployAA is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address entryPoint = vm.envAddress("ENTRYPOINT_ADDRESS");

        vm.startBroadcast(deployerKey);
        new SimpleAccountFactory(entryPoint);
        vm.stopBroadcast();
    }
}
