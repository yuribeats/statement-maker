// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditKeys} from "../CreditKeys.sol";
import {ICredits, ICreditArt} from "../interfaces/IExternal.sol";

/// @notice Read-only helper for the UI: the exact keys and shuffle the Party verifies, so the site can build a valid order.
contract KeyProbe {
    function keys(CreditKeys.Preset p, ICredits c, uint256[] calldata ids) external view returns (uint256[] memory out) {
        ICreditArt art = ICreditArt(c.art());
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeys.key(p, c, art, ids[i]);
    }

    function shuffle(uint256[] calldata ids, uint256 seed) external pure returns (uint256[] memory) {
        return CreditKeys.shuffle(ids, seed);
    }
}
