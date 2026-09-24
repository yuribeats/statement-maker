// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalBase} from "./LocalBase.t.sol";
import {Party} from "../src/Party.sol";
import {CreditKeys} from "../src/CreditKeys.sol";

contract LocalSmokeTest is LocalBase {
    function test_localHarness_fillFromManyHolders_burn() public {
        Party party;
        for (uint256 h; h < 4; ++h) {
            uint256[] memory mine = ownedBy(holders[h]);
            uint256[] memory twenty = new uint256[](20);
            for (uint256 i; i < 20; ++i) twenty[i] = mine[i];
            if (h == 0) party = openParty(params(CreditKeys.Preset.Deposit), holders[0], twenty); // host opens
            else deposit(party, holders[h], twenty);
        }
        assertEq(party.count(), 80);
        uint256[] memory order = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(order, noFloor());
        assertTrue(party.assembled());
    }
}
