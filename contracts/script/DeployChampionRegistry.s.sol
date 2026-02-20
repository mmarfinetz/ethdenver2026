// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import {ChampionRegistry} from "../src/ChampionRegistry.sol";

interface Vm {
    function envUint(string calldata key) external returns (uint256);
    function envOr(string calldata key, address defaultValue) external returns (address);
    function envBytes32(string calldata key) external returns (bytes32);
    function addr(uint256 privateKey) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

abstract contract Script {
    Vm internal constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

contract DeployChampionRegistry is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envOr("CHAMPION_REGISTRY_OWNER", vm.addr(deployerKey));
        bytes32 lineageArchiveRoot = vm.envBytes32("CHAMPION_LINEAGE_ARCHIVE_ROOT");
        bytes32 provenanceArchiveRoot = vm.envBytes32("CHAMPION_PROVENANCE_ARCHIVE_ROOT");

        vm.startBroadcast(deployerKey);
        new ChampionRegistry(owner, lineageArchiveRoot, provenanceArchiveRoot);
        vm.stopBroadcast();
    }
}
