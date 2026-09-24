// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditKeys} from "../CreditKeys.sol";
import {ICredits, ICreditTraits} from "../interfaces/IExternal.sol";

/// @notice Read-only helper for the UI: the exact keys and shuffle the Party verifies, so the site can build a valid
///         order. Keys come from the factory's sealed CreditTraits table (the same call Party makes at the burn).
contract KeyProbe {
    ICreditTraits public immutable traits;

    constructor(ICreditTraits traits_) {
        traits = traits_;
    }

    /// `c` is ignored (kept for the old ABI); Number/Time keys are the ids themselves.
    function keys(CreditKeys.Preset p, ICredits c, uint256[] calldata ids) external view returns (uint256[] memory) {
        c;
        return traits.keys(uint8(p), ids);
    }

    function shuffle(uint256[] calldata ids, uint256 seed) external pure returns (uint256[] memory) {
        return CreditKeys.shuffle(ids, seed);
    }
}
