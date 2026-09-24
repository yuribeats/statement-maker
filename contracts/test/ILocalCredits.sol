// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of Jack's Credits (test/credits/Credits.sol) the local harness calls. The harness deploys
///         Credits from its artifact (vm.deployCode) and talks to it through this interface, so test files do not
///         import the art sources, which only compile with via-IR; everything else can then build with any codegen.
interface ILocalCredits {
    function distribute(address[] calldata to, bytes21[] calldata seeds, uint64[] calldata timestamps) external;
    function seal() external;
    function isSealed() external view returns (bool);
    function tokensOf(address owner_) external view returns (uint256[] memory);
    function seedOf(uint256 id) external view returns (bytes21);
    function timestampOf(uint256 id) external view returns (uint64);
    function art() external view returns (address);
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
    function ownerOf(uint256 id) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id) external;
    function approve(address to, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
