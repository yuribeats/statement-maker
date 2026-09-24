// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Who may burn: any card holder for presets; the host for Manual within MANUAL_GRACE (1 day) of FULL, after which
/// any card holder burns in Time order (so a host cannot stall a Manual party).
contract ManualGraceTest is UnitBase {
    address host; // holders[3] hosts scrambledParty parties and holds 40 cards; holders[2] holds the other 40

    function setUp() public override {
        super.setUp();
        host = holders[3];
    }

    function _timeOrder(Party party) internal view returns (uint256[] memory) {
        return sortBy(CreditKeys.Preset.Time, party.depositOrder());
    }

    function test_preset_nonHostMemberBurns() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Time));
        uint256[] memory want = _timeOrder(party);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bad("card holders only"));
        party.assemble(want, noFloor());
        vm.prank(holders[2]); // a member, not the host
        party.assemble(want, noFloor());
        assertTrue(party.assembled());
    }

    function test_manual_withinGrace_hostOnly() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual));
        uint256[] memory dep = party.depositOrder();
        uint256[] memory mine = swapped(dep, 0, 79);
        uint256[] memory time = _timeOrder(party);
        vm.warp(uint256(party.fullAt()) + 1 days); // last second of the host's window
        vm.prank(holders[2]);
        vm.expectRevert(bad("host only"));
        party.assemble(time, noFloor());
        vm.prank(host);
        party.assemble(mine, noFloor());
        assertEq(party.burnOrder()[0], dep[79]);
    }

    function test_manual_afterGrace_anyMemberBurnsTimeOrder() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual));
        uint256[] memory time = _timeOrder(party);
        uint256[] memory other = swapped(time, 0, 79);
        vm.warp(uint256(party.fullAt()) + 1 days + 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bad("card holders only"));
        party.assemble(time, noFloor());
        vm.prank(holders[2]);
        vm.expectRevert(); // not the Time order
        party.assemble(other, noFloor());
        vm.prank(holders[2]);
        party.assemble(time, noFloor());
        assertEq(party.burnOrder()[0], time[0]);
    }

    function test_manual_afterGrace_hostHasNoOrderPower() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual));
        uint256[] memory time = _timeOrder(party);
        uint256[] memory mine = swapped(time, 0, 79);
        vm.warp(uint256(party.fullAt()) + 1 days + 1);
        vm.prank(host);
        vm.expectRevert(); // its own order is no longer accepted
        party.assemble(mine, noFloor());
        // a host without cards is no longer entitled to burn at all
        uint256[] memory hc = cardsOf(party, host);
        for (uint256 i; i < hc.length; ++i) { vm.prank(host); cards.transferFrom(host, holders[2], hc[i]); }
        vm.prank(host);
        vm.expectRevert(bad("card holders only"));
        party.assemble(time, noFloor());
    }

    /// Filling always leaves FILL_GRACE (2 days) before the deadline, longer than MANUAL_GRACE (1 day), so the
    /// fallback burn is always reachable before the party expires.
    function test_manual_fallbackReachableBeforeDeadline() public {
        Party.Params memory p = params(CreditKeys.Preset.Manual);
        p.durationDays = 1;
        Party party = scrambledParty(p);
        assertEq(party.MANUAL_GRACE(), 1 days);
        assertGe(uint256(party.deadline()), uint256(party.fullAt()) + party.FILL_GRACE());
        vm.warp(uint256(party.fullAt()) + 1 days + 1);
        assertEq(uint8(party.status()), uint8(Party.Status.FULL));
        uint256[] memory time = _timeOrder(party);
        vm.prank(holders[2]);
        party.assemble(time, noFloor());
        assertTrue(party.assembled());
    }
}
