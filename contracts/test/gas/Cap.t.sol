// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Worst-case single transactions vs the 16,777,216 per-transaction gas cap (EIP-7825), on real mainnet Credits.
contract GasCapTest is Base {
    uint256 constant CAP = 16_777_216;

    function _open80(CreditKeys.Preset arr) internal returns (Party party, uint256 gasOpen) {
        uint256[] memory ids = take(holdings(WHALE), 0, 80);
        Party.Params memory p = params(arr);
        vm.startPrank(WHALE);
        CREDITS.setApprovalForAll(factory.predictParty(WHALE), true);
        uint256 g = gasleft();
        party = factory.createParty(p, ids, new bytes32[][](0));
        gasOpen = g - gasleft();
        vm.stopPrank();
    }

    function test_gas_open80_and_burnEveryPreset() public {
        for (uint256 k; k <= 4; ++k) { // the fork whale holds enough Credits for five parties; Rarity (3) is the costliest preset
            CreditKeys.Preset pre = CreditKeys.Preset(k);
            (Party party, uint256 gOpen) = _open80(pre);
            uint256[] memory order = party.depositOrder();
            if (pre == CreditKeys.Preset.Random) order = probe.shuffle(order, 42);
            else if (pre != CreditKeys.Preset.Deposit) order = sortBy(pre, order);
            vm.prank(WHALE);
            uint256 g = gasleft();
            party.assemble(order, noFloor());
            uint256 gBurn = g - gasleft();
            emit log_named_uint(string.concat("preset ", vm.toString(k), " open+deposit 80"), gOpen);
            emit log_named_uint(string.concat("preset ", vm.toString(k), " burn"), gBurn);
            assertLt(gOpen, CAP, "open over cap");
            assertLt(gBurn, CAP, "burn over cap");
            // give the whale its Credits back is impossible (burned); use the next 80 for the next preset
            vm.roll(block.number + 1);
        }
    }
}
