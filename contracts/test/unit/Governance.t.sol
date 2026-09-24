// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

contract GovernanceTest is UnitBase {
    uint256 constant FLOOR = 3 ether;

    function _prop(Party party, address who, uint256 priceWei) internal returns (uint256 id) {
        vm.prank(who);
        id = party.propose(fixedPrice(priceWei), false, 0, 24);
    }

    function _propSpec(Party party, address who, Party.PriceSpec memory s) internal returns (uint256 id) {
        vm.prank(who);
        id = party.propose(s, false, 0, 24);
    }

    function _cancel(Party party, address who) internal returns (uint256 id) {
        Party.PriceSpec memory z;
        vm.prank(who);
        id = party.propose(z, true, 0, 24);
    }

    function _vote(Party party, address who, uint256 id, bool yes) internal {
        vm.prank(who);
        party.vote(id, yes);
    }

    function _ex(Party party, address who, uint256 id, uint256 floorWei) internal {
        Party.Floor memory f = floorSig(floorWei, 0);
        vm.prank(who);
        party.execute(id, f);
    }

    function _exFail(Party party, address who, uint256 id, uint256 floorWei, bytes memory err) internal {
        Party.Floor memory f = floorSig(floorWei, 0);
        vm.prank(who);
        vm.expectRevert(err);
        party.execute(id, f);
    }

    function _toEnd(Party party, uint256 id) internal {
        vm.warp(party.proposal(id).endsAt);
    }

    // ------------------------------------------------------------------ propose: who / when

    function test_propose_onlyCardHolders() public {
        (Party party,) = assembledWithVoters(c2(40, 40));
        address s = makeAddr("stranger");
        vm.prank(s);
        vm.expectRevert(bad("card holders only"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
    }

    function test_propose_statusOpen() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        deposit(party, holders[0], first(holders[0], 10));
        roll();
        vm.prank(holders[0]);
        vm.expectRevert(bad("status"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
    }

    function test_propose_full_listOk_cancelRejected() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        roll();
        uint256 id = _prop(party, holders[0], 5 ether);
        assertEq(party.proposal(id).yes, 60);
        Party.PriceSpec memory z;
        vm.prank(holders[0]);
        vm.expectRevert(bad("status"));
        party.propose(z, true, 0, 24);
    }

    function test_propose_expired_rejected() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        roll();
        vm.warp(uint256(party.deadline()) + 1);
        vm.prank(holders[0]);
        vm.expectRevert(bad("status"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
    }

    function test_propose_sold_rejected() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        vm.warp(block.timestamp + 24 hours);
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 3 ether);
        vm.prank(buyer);
        party.buy{value: 3 ether}(3 ether);
        vm.prank(v[0]);
        vm.expectRevert(bad("status"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
    }

    function test_propose_badPrice() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        vm.prank(v[0]);
        vm.expectRevert(bad("price"));
        party.propose(fixedPrice(0), false, 0, 24);
        vm.prank(v[0]);
        vm.expectRevert(bad("price"));
        party.propose(Party.PriceSpec(Party.PriceMode.FloorPct, -10_000), false, 0, 24);
    }

    function test_propose_window() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        vm.prank(v[0]);
        vm.expectRevert(bad("window"));
        party.propose(fixedPrice(5 ether), false, 25, 24);
        vm.prank(v[0]);
        uint256 a = party.propose(fixedPrice(5 ether), false, 0, 24);
        assertEq(party.proposal(a).endsAt, block.timestamp + 48 hours, "default window");
        vm.prank(v[0]);
        uint256 b = party.propose(fixedPrice(5 ether), false, 168, 24);
        assertEq(party.proposal(b).endsAt, block.timestamp + 168 hours);
    }

    function test_propose_autoYes_andRecords() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _prop(party, v[0], 5 ether);
        Party.Proposal memory p = party.proposal(id);
        assertEq(p.proposer, v[0]);
        assertEq(p.yes, 41);
        assertEq(p.no, 0);
        assertEq(p.snapshot, block.number - 1);
        assertEq(p.epoch, party.priceEpoch());
        assertFalse(p.deadlock);
        assertEq(party.voteOf(id, v[0]), 1);
        assertEq(party.weightOf(id, v[0]), 41);
    }

    // ------------------------------------------------------------------ cancel

    function test_cancel_requiresListed() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _cancel(party, v[0]);
        _toEnd(party, id);
        vm.prank(v[0]);
        party.execute(id, noFloor()); // cancel needs no floor
        assertEq(party.ask(), 0);
        assertEq(party.askLiveAt(), 0);
        vm.prank(v[0]);
        vm.expectRevert(bad("not listed"));
        party.propose(Party.PriceSpec(Party.PriceMode.Fixed, 0), true, 0, 24);
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        vm.expectRevert(bad("not for sale"));
        party.buy{value: 3 ether}(3 ether);
    }

    function test_cancel_thenRelist() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _cancel(party, v[0]);
        _toEnd(party, id);
        vm.prank(v[0]);
        party.execute(id, noFloor());
        uint256 l = _prop(party, v[0], 4 ether);
        _toEnd(party, l);
        _ex(party, v[0], l, FLOOR);
        assertEq(party.ask(), 4 ether);
        assertEq(party.askLiveAt(), block.timestamp);
    }

    // ------------------------------------------------------------------ open limit / cap

    function test_openLimit_threePerProposer_freesAfterClose() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        uint256 id0 = _prop(party, v[0], 5 ether);
        _prop(party, v[0], 5 ether);
        _prop(party, v[0], 5 ether);
        assertEq(party.openProposalsOf(v[0]).length, 3);
        vm.prank(v[0]);
        vm.expectRevert(bad("open limit"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
        _prop(party, v[1], 5 ether); // another proposer is independent
        vm.warp(party.proposal(id0).endsAt - 1);
        vm.prank(v[0]);
        vm.expectRevert(bad("open limit"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
        vm.warp(party.proposal(id0).endsAt);
        uint256 id4 = _prop(party, v[0], 5 ether);
        uint256[] memory open = party.openProposalsOf(v[0]);
        assertEq(open.length, 1, "3 closed freed, 1 new");
        assertEq(open[0], id4);
    }

    /// MAX_PROPOSALS is gone: one proposer can keep proposing across windows without any lifetime cap.
    function test_noLifetimeProposalCap() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        for (uint256 r; r < 90; ++r) {
            for (uint256 k; k < 3; ++k) {
                vm.prank(v[0]);
                party.propose(fixedPrice(5 ether), false, 24, 24);
            }
            vm.warp(block.timestamp + 24 hours);
        }
        assertEq(party.proposalCount(), 270);
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 24, 24);
        assertEq(id, 270);
        assertEq(party.openProposalsOf(v[0]).length, 1);
    }

    // ------------------------------------------------------------------ snapshot

    function test_snapshot_cardsBoughtInProposalBlockDontCount() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        address late = makeAddr("late");
        uint256 card = cardsOf(party, v[0])[0];
        vm.prank(v[0]);
        cards.transferFrom(v[0], late, card); // same block as the proposal
        uint256 id = _prop(party, v[0], 5 ether);
        assertEq(party.proposal(id).yes, 79, "seller keeps snapshot weight");
        vm.prank(late);
        vm.expectRevert(bad("no weight at snapshot"));
        party.vote(id, true);
        vm.prank(late); // holds now, but not at block-1
        vm.expectRevert(bad("no weight at snapshot"));
        party.propose(fixedPrice(5 ether), false, 0, 24);
        roll();
        uint256 id2 = _prop(party, late, 5 ether);
        assertEq(party.proposal(id2).yes, 1);
        _vote(party, v[0], id2, true);
        assertEq(party.proposal(id2).yes, 79, "78 + 1");
    }

    function test_snapshot_transferAfterVoteNoDoubleCount() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _prop(party, v[0], 5 ether);
        uint256[] memory mine = cardsOf(party, v[0]);
        for (uint256 i; i < mine.length; ++i) {
            vm.prank(v[0]);
            cards.transferFrom(v[0], v[1], mine[i]);
        }
        roll();
        _vote(party, v[1], id, true);
        assertEq(party.proposal(id).yes, 80, "v1 votes with its 39 snapshot cards only");
    }

    // ------------------------------------------------------------------ voting

    function test_vote_changeAdjustsTallies() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(50, 30));
        uint256 id = _prop(party, v[0], 5 ether);
        _vote(party, v[1], id, true);
        assertEq(party.proposal(id).yes, 80);
        _vote(party, v[1], id, false);
        assertEq(party.proposal(id).yes, 50);
        assertEq(party.proposal(id).no, 30);
        assertEq(party.voteOf(id, v[1]), 2);
        _vote(party, v[0], id, false);
        assertEq(party.proposal(id).yes, 0);
        assertEq(party.proposal(id).no, 80);
        _vote(party, v[1], id, false); // repeat same vote: idempotent
        assertEq(party.proposal(id).no, 80);
        _vote(party, v[0], id, true);
        _vote(party, v[1], id, true);
        assertEq(party.proposal(id).yes, 80);
        assertEq(party.proposal(id).no, 0);
        _toEnd(party, id);
        _ex(party, v[0], id, FLOOR); // no residual NO after changing back
        assertEq(party.ask(), 5 ether);
    }

    function test_vote_afterClose() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(50, 30));
        uint256 id = _prop(party, v[0], 5 ether);
        vm.warp(party.proposal(id).endsAt - 1);
        _vote(party, v[1], id, true);
        _toEnd(party, id);
        vm.prank(v[1]);
        vm.expectRevert(bad("closed"));
        party.vote(id, false);
    }

    function test_vote_noWeight() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(50, 30));
        uint256 id = _prop(party, v[0], 5 ether);
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(bad("no weight at snapshot"));
        party.vote(id, true);
    }

    // ------------------------------------------------------------------ thresholds

    function _passCase(uint256 yesW, uint256 price, uint256 floorWei, bool expectPass) internal {
        (Party party, address[] memory v) = assembledWithVoters(c2(yesW, 80 - yesW));
        uint256 id = _prop(party, v[0], price);
        _toEnd(party, id);
        if (expectPass) {
            _ex(party, v[0], id, floorWei);
            assertEq(party.ask(), price);
            assertEq(party.askLiveAt(), block.timestamp);
            assertEq(party.priceEpoch(), 2);
            assertEq(party.lastPriceExecutedAt(), block.timestamp);
            assertTrue(party.proposal(id).executed);
        } else {
            _exFail(party, v[0], id, floorWei, bad("did not pass"));
        }
    }

    function test_threshold_40fails() public { _passCase(40, 5 ether, FLOOR, false); }
    function test_threshold_41passes() public { _passCase(41, 5 ether, FLOOR, true); }
    function test_threshold_atFloor_41passes() public { _passCase(41, FLOOR, FLOOR, true); }
    function test_belowFloor_59fails() public { _passCase(59, 2 ether, FLOOR, false); }
    function test_belowFloor_60passes() public { _passCase(60, 2 ether, FLOOR, true); }
    function test_belowFloor_1wei_41fails() public { _passCase(41, FLOOR - 1, FLOOR, false); }

    function test_belowFloor_pctNegative_needs60() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(59, 21));
        uint256 id = _propSpec(party, v[0], Party.PriceSpec(Party.PriceMode.FloorPct, -1)); // floor - 0.01%
        _toEnd(party, id);
        _exFail(party, v[0], id, FLOOR, bad("did not pass"));
        (Party p2, address[] memory w) = _second(c2(60, 20));
        uint256 id2 = _propSpec(p2, w[0], Party.PriceSpec(Party.PriceMode.FloorPct, -1));
        _toEnd(p2, id2);
        _ex(p2, w[0], id2, FLOOR);
        assertEq(p2.ask(), FLOOR * 9_999 / 10_000);
    }

    /// A second assembled party from holders[2]/[3].
    function _second(uint256[] memory counts) internal returns (Party party, address[] memory voters) {
        party = openParty(params(CreditKeys.Preset.Deposit), holders[2], first(holders[2], 40));
        deposit(party, holders[3], first(holders[3], 40));
        nextCardIdx = 0;
        assembleDeposit(party);
        voters = new address[](counts.length);
        for (uint256 i; i < counts.length; ++i) {
            voters[i] = makeAddr(string.concat("w", vm.toString(i)));
            give(party, voters[i], counts[i]);
        }
        roll();
    }

    function test_oneNoBlocks() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        uint256 id = _prop(party, v[0], 5 ether);
        _vote(party, v[1], id, false);
        _toEnd(party, id);
        _exFail(party, v[0], id, FLOOR, bad("did not pass"));
    }

    function test_needFor_view() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _prop(party, v[0], 5 ether);
        assertEq(party.needFor(id, 5 ether, FLOOR), 41);
        assertEq(party.needFor(id, 1 ether, FLOOR), 60);
    }

    // ------------------------------------------------------------------ deadlock via countBlocked

    function _blockThree(Party party, address a, address b) internal {
        uint256[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            ids[i] = _prop(party, a, 5 ether);
            _vote(party, b, ids[i], false);
        }
        vm.expectRevert(bad("not blocked")); // before close
        party.countBlocked(ids[0]);
        _toEnd(party, ids[2]);
        for (uint256 i; i < 3; ++i) party.countBlocked(ids[i]);
        assertEq(party.blockedPriceProposals(), 3);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(ids[0]); // once only
    }

    function _deadlockCase(uint256 yesW, uint256 price, bool expectPass) internal {
        (Party party, address[] memory v) = assembledWithVoters(c2(yesW, 80 - yesW));
        _blockThree(party, v[0], v[1]);
        uint256 id = _prop(party, v[0], price);
        assertTrue(party.proposal(id).deadlock);
        _vote(party, v[1], id, false);
        _toEnd(party, id);
        if (expectPass) {
            _ex(party, v[0], id, FLOOR);
            assertEq(party.ask(), price);
        } else {
            _exFail(party, v[0], id, FLOOR, bad("did not pass"));
        }
        vm.expectRevert(bad("not blocked")); // a deadlock proposal never counts as blocked
        party.countBlocked(id);
    }

    function test_deadlockBlocks_54passesIgnoringNo() public { _deadlockCase(54, 5 ether, true); }
    function test_deadlockBlocks_53fails() public { _deadlockCase(53, 5 ether, false); }
    function test_deadlockBlocks_belowFloor59fails() public { _deadlockCase(59, 2 ether, false); }
    function test_deadlockBlocks_belowFloor60passes() public { _deadlockCase(60, 2 ether, true); }

    function test_countBlocked_negatives() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 clean = _prop(party, v[0], 5 ether); // no NO
        uint256 cxl = _cancel(party, v[0]);
        _vote(party, v[1], cxl, false);
        _toEnd(party, clean);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(clean);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(cxl); // cancel proposals never count
        _ex(party, v[0], clean, FLOOR);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(clean); // executed
    }

    // ------------------------------------------------------------------ deadlock via time

    function test_deadlockTime_sinceAssembly() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(54, 26));
        uint256 full = party.assembledAt(); // == fullAt here (filled and assembled in one block)
        vm.warp(full + 30 days);
        uint256 a = _prop(party, v[0], 5 ether);
        assertFalse(party.proposal(a).deadlock, "exactly 30 days: not yet");
        vm.warp(full + 30 days + 1);
        uint256 b = _prop(party, v[0], 5 ether);
        assertTrue(party.proposal(b).deadlock);
        _vote(party, v[1], b, false);
        _toEnd(party, b);
        _ex(party, v[0], b, FLOOR);
        assertEq(party.ask(), 5 ether);
    }

    function test_deadlockTime_53fails() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(53, 27));
        vm.warp(uint256(party.fullAt()) + 30 days + 1);
        uint256 b = _prop(party, v[0], 5 ether);
        assertTrue(party.proposal(b).deadlock);
        _toEnd(party, b);
        _exFail(party, v[0], b, FLOOR, bad("did not pass"));
    }

    function test_deadlockTime_belowFloorStillNeeds60() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(59, 21));
        vm.warp(uint256(party.fullAt()) + 30 days + 1);
        uint256 b = _prop(party, v[0], 2 ether);
        assertTrue(party.proposal(b).deadlock);
        _vote(party, v[1], b, false);
        _toEnd(party, b);
        _exFail(party, v[0], b, FLOOR, bad("did not pass"));
    }

    function test_deadlockTime_sinceLastExecution() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(54, 26));
        uint256 id = _prop(party, v[0], 5 ether);
        _vote(party, v[1], id, true);
        _toEnd(party, id);
        _ex(party, v[0], id, FLOOR);
        uint256 e = block.timestamp;
        vm.warp(e + 30 days);
        uint256 a = _prop(party, v[0], 6 ether);
        assertFalse(party.proposal(a).deadlock);
        vm.warp(e + 30 days + 1);
        uint256 b = _prop(party, v[0], 6 ether);
        assertTrue(party.proposal(b).deadlock);
    }

    function test_deadlockTime_whileFull() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 60;
        Party party = newParty(p);
        fill(party);
        roll();
        vm.warp(uint256(party.fullAt()) + 30 days + 1);
        uint256 id = _prop(party, holders[0], 5 ether);
        assertTrue(party.proposal(id).deadlock);
    }

    // ------------------------------------------------------------------ execute

    function test_execute_beforeEnd() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _prop(party, v[0], 5 ether);
        vm.warp(party.proposal(id).endsAt - 1);
        _exFail(party, v[0], id, FLOOR, bad("voting open"));
    }

    function test_execute_lapse() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(41, 39));
        uint256 id = _prop(party, v[0], 5 ether);
        uint256 end = party.proposal(id).endsAt;
        vm.warp(end + 7 days + 1);
        _exFail(party, v[0], id, FLOOR, bad("lapsed"));
        vm.warp(end + 7 days);
        _ex(party, v[0], id, FLOOR);
        assertEq(party.ask(), 5 ether);
    }

    function test_execute_superseded() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        uint256 b = _prop(party, v[0], 6 ether);
        _toEnd(party, b);
        _ex(party, v[0], b, FLOOR);
        _exFail(party, v[0], a, FLOOR, bad("superseded"));
        assertEq(party.ask(), 6 ether);
    }

    function test_execute_twice() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        _toEnd(party, a);
        _ex(party, v[0], a, FLOOR);
        _exFail(party, v[0], a, FLOOR, bad("executed"));
    }

    function test_execute_nonCardHolder() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        _toEnd(party, a);
        _exFail(party, makeAddr("stranger"), a, FLOOR, bad("card holders only"));
    }

    function test_execute_anyCardHolder() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        uint256 a = _prop(party, v[0], 5 ether);
        _toEnd(party, a);
        _ex(party, v[1], a, FLOOR);
        assertEq(party.ask(), 5 ether);
    }

    function test_execute_fixedWithoutFloor_treatedAsBelowFloor() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        _toEnd(party, a);
        vm.prank(v[0]);
        party.execute(a, noFloor()); // 80 YES >= 60: no signer needed
        assertEq(party.ask(), 5 ether);
        assertEq(party.lastFloorAt(), 0, "no reading consumed");
    }

    function test_execute_floorRelativeStillNeedsFloor() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _propSpec(party, v[0], Party.PriceSpec(Party.PriceMode.FloorPct, 0));
        _toEnd(party, a);
        vm.prank(v[0]);
        vm.expectRevert(bad("stale floor"));
        party.execute(a, noFloor());
    }

    function test_execute_afterSold() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 3 ether);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(buyer);
        party.buy{value: 3 ether}(3 ether);
        _toEnd(party, a);
        _exFail(party, v[0], a, FLOOR, bad("status"));
    }

    function test_execute_restartsBuyDelay() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 a = _prop(party, v[0], 5 ether);
        _toEnd(party, a);
        _ex(party, v[0], a, FLOOR);
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectRevert(bad("not open yet"));
        party.buy{value: 5 ether}(5 ether);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.prank(buyer);
        vm.expectRevert(bad("not open yet"));
        party.buy{value: 5 ether}(5 ether);
        vm.warp(block.timestamp + 1);
        vm.prank(buyer);
        party.buy{value: 5 ether}(5 ether);
    }

    // ------------------------------------------------------------------ LIST while FULL

    function _fullWithVoters(uint256[] memory counts) internal returns (Party party, address[] memory v) {
        party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        v = spread(party, counts);
    }

    function test_listWhileFull_setsPending_appliedAtAssembly() public {
        (Party party, address[] memory v) = _fullWithVoters(one(80));
        uint256 a = _prop(party, v[0], 7 ether);
        _toEnd(party, a);
        _ex(party, v[0], a, FLOOR);
        assertTrue(party.hasPendingPrice());
        (Party.PriceMode m, int256 val) = party.pendingPrice();
        assertEq(uint8(m), uint8(Party.PriceMode.Fixed));
        assertEq(val, 7 ether);
        assertEq(party.ask(), 0, "not live until assembly");
        assertEq(party.priceEpoch(), 1);
        uint256[] memory dep = party.depositOrder();
        vm.expectEmit(address(party));
        emit Party.AskSet(7 ether, true);
        vm.prank(v[0]);
        party.assemble(dep, noFloor());
        assertEq(party.ask(), 7 ether);
        assertEq(party.priceEpoch(), 2);
    }

    function test_listWhileFull_floorRelativePending_needsSigAtAssembly() public {
        (Party party, address[] memory v) = _fullWithVoters(one(80));
        uint256 a = _propSpec(party, v[0], Party.PriceSpec(Party.PriceMode.FloorDelta, 1 ether));
        _toEnd(party, a);
        _ex(party, v[0], a, FLOOR);
        uint256[] memory dep = party.depositOrder();
        vm.prank(v[0]);
        vm.expectRevert(bad("stale floor"));
        party.assemble(dep, noFloor());
        Party.Floor memory f = floorSig(10 ether, 0);
        vm.prank(v[0]);
        party.assemble(dep, f);
        assertEq(party.ask(), 11 ether);
    }

    function test_proposalFromFull_supersededByAssembly() public {
        (Party party, address[] memory v) = _fullWithVoters(one(80));
        uint256 a = _prop(party, v[0], 7 ether);
        uint256[] memory dep = party.depositOrder();
        vm.prank(v[0]);
        party.assemble(dep, noFloor());
        _toEnd(party, a);
        _exFail(party, v[0], a, FLOOR, bad("superseded"));
    }

    // ------------------------------------------------------------------ raiseAsk

    function _floorParty() internal returns (Party party, address[] memory v) {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 0);
        party = newParty(p);
        fill(party);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory f = floorSig(2 ether, 0);
        vm.prank(holders[0]);
        party.assemble(dep, f);
        v = spread(party, one(80));
    }

    function test_raiseAsk_onlyRaises_anyone() public {
        (Party party,) = _floorParty();
        uint64 live = party.askLiveAt();
        vm.warp(block.timestamp + 1 hours);
        Party.Floor memory up = floorSig(3 ether, 0);
        vm.prank(makeAddr("keeper"));
        party.raiseAsk(up);
        assertEq(party.ask(), 3 ether);
        assertEq(party.askLiveAt(), live, "raise does not restart the buy delay");
        Party.Floor memory same = floorSig(3 ether, 0);
        vm.expectRevert(bad("not higher"));
        party.raiseAsk(same);
        Party.Floor memory down = floorSig(2.5 ether, 0);
        vm.expectRevert(bad("not higher"));
        party.raiseAsk(down);
    }

    function test_raiseAsk_requiresFreshValidSig() public {
        (Party party,) = _floorParty();
        vm.warp(block.timestamp + 2 hours);
        Party.Floor memory old = floorAt(9 ether, 0, uint64(block.timestamp - 1 hours - 1), signerKey, factory);
        vm.expectRevert(bad("stale floor"));
        party.raiseAsk(old);
        Party.Floor memory forged = floorAt(9 ether, 0, uint64(block.timestamp), 0xB0B, factory);
        vm.expectRevert(bad("floor sig"));
        party.raiseAsk(forged);
    }

    function test_raiseAsk_fixedRejected() public {
        (Party party,) = assembledWithVoters(one(80));
        Party.Floor memory f = floorSig(9 ether, 0);
        vm.expectRevert(bad("fixed"));
        party.raiseAsk(f);
    }

    function test_raiseAsk_notAssembledRejected() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 0);
        Party party = newParty(p);
        fill(party);
        Party.Floor memory f = floorSig(9 ether, 0);
        vm.expectRevert(bad("fixed"));
        party.raiseAsk(f);
    }

    function test_raiseAsk_afterCancelRejected() public {
        (Party party, address[] memory v) = _floorParty();
        uint256 id = _cancel(party, v[0]);
        _toEnd(party, id);
        vm.prank(v[0]);
        party.execute(id, noFloor());
        Party.Floor memory f = floorSig(9 ether, 0);
        vm.expectRevert(bad("fixed"));
        party.raiseAsk(f);
    }

    function test_raiseAsk_afterVotedFixedRejected() public {
        (Party party, address[] memory v) = _floorParty();
        uint256 id = _prop(party, v[0], 5 ether);
        _toEnd(party, id);
        _ex(party, v[0], id, FLOOR);
        Party.Floor memory f = floorSig(9 ether, 0);
        vm.expectRevert(bad("fixed"));
        party.raiseAsk(f);
    }
}
