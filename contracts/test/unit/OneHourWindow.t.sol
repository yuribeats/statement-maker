// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixesBase} from "./Fixes.t.sol";
import {Party} from "../../src/Party.sol";
import {TestnetPartyFactory} from "../../src/testnet/TestnetPartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";

/// 1-hour voting windows (allowed windows: 1, 24, 48, 72, 168 h) and how they interact with the other clocks.
contract OneHourWindowTest is FixesBase {
    function test_oneHour_defaultAndPerProposal() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.voteHours = 1;
        (Party party, address[] memory v) = _assembled(p, noFloor(), c2(42, 38));
        vm.prank(v[0]);
        uint256 a = party.propose(fixedPrice(4 ether), false, 0, 0); // party default: 1 h
        assertEq(party.proposal(a).endsAt, block.timestamp + 1 hours);
        vm.prank(v[1]);
        uint256 b = party.propose(fixedPrice(5 ether), false, 1, 0); // explicit 1 h
        assertEq(party.proposal(b).endsAt, block.timestamp + 1 hours);
        vm.prank(v[1]);
        vm.expectRevert(bad("window"));
        party.propose(fixedPrice(5 ether), false, 2, 0);
    }

    /// Cancels still always run 24 h, even in a party whose default window is 1 h.
    function test_oneHour_cancelStill24h() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.voteHours = 1;
        (Party party, address[] memory v) = _assembled(p, noFloor(), c2(42, 38));
        Party.PriceSpec memory z;
        vm.prank(v[0]);
        uint256 c = party.propose(z, true, 1, 0);
        assertEq(party.proposal(c).endsAt, block.timestamp + 24 hours);
    }

    /// Snapshot is still the block before creation: cards bought in the creation block carry no weight.
    function test_oneHour_snapshotAndExecuteAndLapse() public {
        (Party party, address[] memory v) = _assembled(params(CreditKeys.Preset.Deposit), noFloor(), c2(42, 38));
        uint256 id = _prop(party, v[0], fixedPrice(4 ether), 0);
        uint256 card = cardsOf(party, v[0])[0];
        vm.prank(v[0]);
        cards.transferFrom(v[0], makeAddr("late"), card);
        vm.prank(makeAddr("late"));
        vm.expectRevert(bad("no weight at snapshot"));
        party.vote(id, false);
        Party.Floor memory f = floorSig(3 ether, 0);
        vm.prank(v[0]);
        vm.expectRevert(bad("voting open"));
        party.execute(id, f);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(v[1]);
        vm.expectRevert(bad("closed"));
        party.vote(id, false);
        vm.warp(uint256(party.proposal(id).endsAt) + 7 days + 1);
        _exFail(party, v[0], id, floorSig(3 ether, 0), bad("lapsed")); // lapse still 7 days after the 1 h close
    }

    function test_oneHour_countBlockedAfterClose() public {
        (Party party, address[] memory v) = _assembled(params(CreditKeys.Preset.Deposit), noFloor(), c2(42, 38));
        uint256 id = _prop(party, v[0], fixedPrice(4 ether), 0);
        _vote(party, v[1], id, false);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(id);
        vm.warp(block.timestamp + 1 hours);
        party.countBlocked(id);
        assertEq(party.blockedPriceProposals(), 1);
    }

    /// Floor-relative prices still need a >= 1 h buy wait, independent of the vote window.
    function test_oneHour_floorRelativeStillNeedsBuyWait() public {
        (Party party, address[] memory v) = _assembled(params(CreditKeys.Preset.Deposit), noFloor(), c2(42, 38));
        vm.prank(v[0]);
        vm.expectRevert(bad("buyDelay"));
        party.propose(_pct(0), false, 1, 0);
        vm.prank(v[0]);
        party.propose(_pct(0), false, 1, 1);
    }

    /// Testnet time unit scales the 1 h window like every other rule window (60 s per hour -> 60 s).
    function test_oneHour_timeUnitScaled() public {
        TestnetPartyFactory tf = new TestnetPartyFactory(
            ICredits(address(credits)), IStatement(address(statement)), feeTo, vm.addr(signerKey), collectionOwner, 60
        );
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        Party party = openPartyWith(tf, p, holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
        vm.roll(block.number + 1);
        vm.prank(holders[0]);
        uint256 id = party.propose(fixedPrice(4 ether), false, 1, 0);
        assertEq(party.proposal(id).endsAt, block.timestamp + 60);
    }

    // helper: the proposals above use a 1 h window
    function _prop(Party party, address who, Party.PriceSpec memory s, uint16 wait) internal override returns (uint256 id) {
        vm.prank(who);
        id = party.propose(s, false, 1, wait);
    }
}
