// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import {ChampionRegistry} from "../src/ChampionRegistry.sol";

contract UnauthorizedChampionCaller {
    function callRegister(ChampionRegistry registry) external returns (uint256) {
        return registry.registerChampion(
            0,
            keccak256("lineage"),
            keccak256("candidate"),
            keccak256("provenance"),
            keccak256("gate"),
            false
        );
    }

    function callPromote(ChampionRegistry registry, uint256 championId) external {
        registry.promoteChampion(championId);
    }
}

contract ChampionRegistryTest {
    ChampionRegistry internal registry;
    UnauthorizedChampionCaller internal unauthorized;

    bytes32 internal constant LINEAGE_ARCHIVE_ROOT = keccak256("lineage-archive-v1");
    bytes32 internal constant PROVENANCE_ARCHIVE_ROOT = keccak256("provenance-archive-v1");

    function setUp() public {
        registry = new ChampionRegistry(address(this), LINEAGE_ARCHIVE_ROOT, PROVENANCE_ARCHIVE_ROOT);
        unauthorized = new UnauthorizedChampionCaller();
    }

    function testConstructorSetsImmutableArchiveRootsAndOwner() public {
        require(registry.owner() == address(this), "owner mismatch");
        require(registry.lineageArchiveRoot() == LINEAGE_ARCHIVE_ROOT, "lineage archive root mismatch");
        require(
            registry.provenanceArchiveRoot() == PROVENANCE_ARCHIVE_ROOT,
            "provenance archive root mismatch"
        );
        require(registry.currentChampionId() == 0, "current champion should be empty");
    }

    function testRegisterChampionStoresRecordWithoutImplicitPromotion() public {
        uint256 championId = registry.registerChampion(
            0,
            keccak256("lineage-1"),
            keccak256("candidate-1"),
            keccak256("provenance-1"),
            keccak256("gate-pass-1"),
            false
        );

        require(championId == 1, "champion id mismatch");
        require(registry.championCount() == 1, "champion count mismatch");
        require(registry.currentChampionId() == 0, "current champion should not change");

        ChampionRegistry.Champion memory stored = registry.getChampion(championId);
        require(stored.championId == 1, "stored champion id mismatch");
        require(stored.parentChampionId == 0, "stored parent id mismatch");
        require(stored.submitter == address(this), "stored submitter mismatch");
    }

    function testRegisterChampionCanPromoteAndPointerCanMoveForward() public {
        uint256 championIdOne = registry.registerChampion(
            0,
            keccak256("lineage-1"),
            keccak256("candidate-1"),
            keccak256("provenance-1"),
            keccak256("gate-pass-1"),
            true
        );
        require(championIdOne == 1, "first champion id mismatch");
        require(registry.currentChampionId() == championIdOne, "first champion not promoted");

        uint256 championIdTwo = registry.registerChampion(
            championIdOne,
            keccak256("lineage-2"),
            keccak256("candidate-2"),
            keccak256("provenance-2"),
            keccak256("gate-pass-2"),
            false
        );
        require(championIdTwo == 2, "second champion id mismatch");
        require(registry.currentChampionId() == championIdOne, "pointer should remain on champion one");

        registry.promoteChampion(championIdTwo);
        require(registry.currentChampionId() == championIdTwo, "promotion pointer mismatch");
    }

    function testRegisterChampionWithUnknownParentReverts() public {
        (bool ok,) = address(registry).call(
            abi.encodeWithSelector(
                ChampionRegistry.registerChampion.selector,
                99,
                keccak256("lineage"),
                keccak256("candidate"),
                keccak256("provenance"),
                keccak256("gate"),
                false
            )
        );
        require(!ok, "expected registerChampion to revert for unknown parent");
    }

    function testPromoteChampionRequiresExistingRecord() public {
        (bool ok,) = address(registry).call(
            abi.encodeWithSelector(ChampionRegistry.promoteChampion.selector, 1)
        );
        require(!ok, "expected promoteChampion to revert for missing champion");
    }

    function testOnlyOwnerCanRegisterAndPromote() public {
        (bool registerOk,) = address(unauthorized).call(
            abi.encodeWithSelector(UnauthorizedChampionCaller.callRegister.selector, registry)
        );
        require(!registerOk, "expected non-owner register to revert");

        uint256 championId = registry.registerChampion(
            0,
            keccak256("lineage-owned"),
            keccak256("candidate-owned"),
            keccak256("provenance-owned"),
            keccak256("gate-owned"),
            false
        );
        require(championId == 1, "owner register failed");

        (bool promoteOk,) = address(unauthorized).call(
            abi.encodeWithSelector(UnauthorizedChampionCaller.callPromote.selector, registry, championId)
        );
        require(!promoteOk, "expected non-owner promote to revert");
    }
}
