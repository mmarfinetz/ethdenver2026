// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

contract ChampionRegistry {
    struct Champion {
        uint256 championId;
        uint256 parentChampionId;
        bytes32 lineageHash;
        bytes32 candidateHash;
        bytes32 provenanceHash;
        bytes32 gateHash;
        uint64 createdAt;
        address submitter;
    }

    address public immutable owner;
    bytes32 public immutable lineageArchiveRoot;
    bytes32 public immutable provenanceArchiveRoot;

    uint256 public championCount;
    uint256 public currentChampionId;

    mapping(uint256 => Champion) private champions;

    error InvalidOwner();
    error InvalidArchiveRoot();
    error NotOwner();
    error ChampionNotFound(uint256 championId);

    event ChampionRegistered(
        uint256 indexed championId,
        uint256 indexed parentChampionId,
        bytes32 indexed candidateHash,
        bytes32 provenanceHash,
        bool promoted
    );

    event CurrentChampionUpdated(uint256 indexed previousChampionId, uint256 indexed currentChampionId);

    constructor(address _owner, bytes32 _lineageArchiveRoot, bytes32 _provenanceArchiveRoot) {
        if (_owner == address(0)) revert InvalidOwner();
        if (_lineageArchiveRoot == bytes32(0) || _provenanceArchiveRoot == bytes32(0)) {
            revert InvalidArchiveRoot();
        }
        owner = _owner;
        lineageArchiveRoot = _lineageArchiveRoot;
        provenanceArchiveRoot = _provenanceArchiveRoot;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function registerChampion(
        uint256 parentChampionId,
        bytes32 lineageHash,
        bytes32 candidateHash,
        bytes32 provenanceHash,
        bytes32 gateHash,
        bool promote
    ) external onlyOwner returns (uint256 championId) {
        if (parentChampionId != 0 && !_exists(parentChampionId)) {
            revert ChampionNotFound(parentChampionId);
        }

        championId = championCount + 1;
        championCount = championId;
        champions[championId] = Champion({
            championId: championId,
            parentChampionId: parentChampionId,
            lineageHash: lineageHash,
            candidateHash: candidateHash,
            provenanceHash: provenanceHash,
            gateHash: gateHash,
            createdAt: uint64(block.timestamp),
            submitter: msg.sender
        });

        emit ChampionRegistered(championId, parentChampionId, candidateHash, provenanceHash, promote);
        if (promote) _setCurrentChampion(championId);
    }

    function promoteChampion(uint256 championId) external onlyOwner {
        if (!_exists(championId)) revert ChampionNotFound(championId);
        _setCurrentChampion(championId);
    }

    function getChampion(uint256 championId) external view returns (Champion memory) {
        if (!_exists(championId)) revert ChampionNotFound(championId);
        return champions[championId];
    }

    function _exists(uint256 championId) internal view returns (bool) {
        return championId != 0 && championId <= championCount;
    }

    function _setCurrentChampion(uint256 championId) internal {
        uint256 previous = currentChampionId;
        currentChampionId = championId;
        emit CurrentChampionUpdated(previous, championId);
    }
}
