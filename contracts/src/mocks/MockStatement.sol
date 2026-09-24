// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface ICreditsBurn {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory seeds);
}

/// @notice Stand-in for Jack's unpublished Statement contract, built to the interface requested from him:
///         make() burns exactly 80 of the caller's Credits through Credits.burn (caller must have approved this
///         contract as operator) and safe-mints the Statement to the caller. Seeds are kept in call order.
///         `royaltyBps` lets tests exercise the ERC-2981 path; `hostile` makes make() try to re-enter the party.
contract MockStatement is ERC721 {
    ICreditsBurn public immutable credits;
    uint256 public next = 1;
    mapping(uint256 => bytes21[]) internal _seeds;
    address public royaltyReceiver;
    uint96 public royaltyBps;

    constructor(address credits_) ERC721("Statements (mock)", "STMT") {
        credits = ICreditsBurn(credits_);
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        require(ids.length == 80, "80");
        bytes21[] memory seeds = credits.burn(msg.sender, ids);
        id = next++;
        for (uint256 i; i < seeds.length; ++i) _seeds[id].push(seeds[i]);
        _safeMint(msg.sender, id);
    }

    function seedsOf(uint256 id) external view returns (bytes21[] memory) {
        return _seeds[id];
    }

    function setRoyalty(address to, uint96 bps) external {
        royaltyReceiver = to;
        royaltyBps = bps;
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        return (royaltyReceiver, price * royaltyBps / 10_000);
    }
}
