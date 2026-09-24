// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The live Credits ERC-721 (0x97630aa70ab14ed9883b41dafccbc11349723043), only what we use.
interface ICredits {
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function seedOf(uint256 id) external view returns (bytes21);
    function timestampOf(uint256 id) external view returns (uint64);
    function art() external view returns (address);
    function isSealed() external view returns (bool);
}

/// @notice The Credits art contract. describe() is pure; it is the source of truth for every trait.
interface ICreditArt {
    struct Read {
        bytes32 hash;
        uint256 marks;
        uint256 capacity;
        uint256 plates;
        string colors;
        uint256 eights;
        string tier;
        string weight;
        string register;
        string eightsLabel;
    }

    function describe(bytes21 seed, uint64 paidAt) external pure returns (Read memory);
}

/// @notice What Statement Maker needs from Jack's Statement contract (unpublished). The mock in test/ implements
///         exactly this; the real contract gets an adapter once its ABI is known.
///         make() must burn the caller's Credits in the given order and mint the Statement to the caller.
interface IStatement {
    function make(uint256[] calldata creditIds) external returns (uint256 statementId);
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}
