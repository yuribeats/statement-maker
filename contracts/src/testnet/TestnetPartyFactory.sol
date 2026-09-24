// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PartyFactory} from "../PartyFactory.sol";
import {ICredits, IStatement} from "../interfaces/IExternal.sol";

/// @notice Testnet-only factory: identical parties with a shorter clock, so a full party can be rehearsed in
///         minutes. Refuses to deploy on Ethereum mainnet.
contract TestnetPartyFactory is PartyFactory {
    uint256 internal immutable _unit;

    constructor(ICredits c, IStatement s, address fee, address signer, uint256 unit)
        PartyFactory(c, s, fee, signer)
    {
        require(block.chainid != 1, "testnet only");
        require(unit > 0 && unit <= 1 hours, "unit");
        _unit = unit;
    }

    function timeUnit() public view override returns (uint256) {
        return _unit;
    }
}
