// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Regressions for the re-audit (contracts/.solidity-auditor/runs/20260924-155040): M-1 proposal spam vs the burn's
/// gas, M-2 a price voted while FULL goes live at the burn only if it still passes at the burn's floor. The two
/// auditor PoCs (SpamScan, PendingFloor) are kept here with their assertions inverted to the fixed behaviour.
contract ReAuditTest is UnitBase {
    uint256 constant CAP = 16_777_216;

    // ------------------------------------------------------------------ M-1: spam cannot inflate the burn

    function _spam(Party party, uint256 n) internal {
        // one card, moved between fresh addresses: each address opens up to 3 proposals
        uint256 card = partyCards(party)[0];
        address cur = cards.ownerOf(card);
        uint256 made;
        uint256 k;
        while (made < n) {
            address a = address(uint160(0xA000 + k++));
            vm.prank(cur);
            cards.transferFrom(cur, a, card);
            cur = a;
            vm.roll(block.number + 1);
            for (uint256 j; j < 3 && made < n; ++j) {
                vm.prank(a);
                party.propose(fixedPrice(1 ether + made), false, 1, 1);
                ++made;
            }
        }
    }

    function _burnGas(uint256 n) internal returns (uint256 g) {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        vm.roll(block.number + 1);
        vm.pauseGasMetering(); // the spam itself is setup, not what is measured
        _spam(party, n);
        vm.resumeGasMetering();
        vm.warp(block.timestamp + 2 hours);
        uint256[] memory order = party.depositOrder();
        address who = cards.ownerOf(partyCards(party)[1]);
        vm.cool(address(party));
        vm.cool(address(cards));
        vm.cool(address(credits));
        vm.prank(who);
        uint256 g0 = gasleft();
        party.assemble(order, noFloor());
        g = g0 - gasleft();
        assertTrue(party.assembled());
    }

    /// Auditor PoC (was: 1,650 proposals push the burn over the cap). Now the burn goes through under the cap.
    function test_M1_spam1650_burnStillUnderCap() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        vm.roll(block.number + 1);
        _spam(party, 1650);
        vm.warp(block.timestamp + 2 hours);
        uint256[] memory order = party.depositOrder();
        address who = cards.ownerOf(partyCards(party)[1]);
        vm.cool(address(party));
        vm.cool(address(cards));
        vm.cool(address(credits));
        vm.prank(who);
        (bool ok,) = address(party).call{gas: CAP}(abi.encodeCall(Party.assemble, (order, noFloor())));
        assertTrue(ok, "burn fits under the cap despite spam");
        assertEq(uint256(party.status()), uint256(Party.Status.ASSEMBLED));
    }

    /// 5,000 spam proposals do not change the burn's gas materially (bounded candidate list, spam never reaches 41 YES).
    function test_M1_spam5000_burnGasUnchanged() public {
        uint256 snap = vm.snapshotState();
        uint256 g0 = _burnGas(0);
        vm.revertToState(snap);
        uint256 g5000 = _burnGas(5000);
        emit log_named_uint("burn gas, 0 proposals", g0);
        emit log_named_uint("burn gas, 5000 proposals", g5000);
        assertLe(g5000, g0 + 20_000, "spam must not change the burn materially (was ~7,450 gas per proposal)");
    }

    /// Candidates themselves are bounded: with more than BURN_CANDIDATES LISTs at 41+ YES, only the latest are judged.
    function test_M1_candidatesBounded() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        address[] memory v = spread(party, c2(41, 39));
        uint256 last;
        for (uint256 i; i < 12; ++i) {
            vm.roll(block.number + 1);
            if (i % 3 == 0) roll();
            address a = v[0];
            // v0 holds 41 cards: each of its proposals reaches 41 YES at once (3 open at a time; wait for them to close)
            if (party.openProposalsOf(a).length == 3) vm.warp(block.timestamp + 1 hours);
            vm.prank(a);
            last = party.propose(fixedPrice(4 ether + i), false, 1, 1);
        }
        vm.warp(party.proposal(last).endsAt);
        Party.Floor memory f = floorSig(3 ether, 0);
        uint256[] memory order = party.depositOrder();
        vm.prank(v[1]);
        party.assemble(order, f);
        assertEq(party.ask(), 4 ether + 11, "the newest passing LIST went live");
    }

    // ------------------------------------------------------------------ M-2: re-judged at the burn floor

    /// Auditor PoC (was: a floor-relative price passed with 41 at a 0.95 ETH floor went live at 1 ETH vs a 3 ETH
    /// floor). Now, below the burn floor it needs 60: it does not pass, and the host default goes live.
    function test_M2_floorRelativePending_rejudgedAtBurn() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 1 ether;
        Party party = newParty(p);
        fill(party);
        address[] memory v = spread(party, c2(41, 39));
        vm.prank(v[0]);
        uint256 id = party.propose(Party.PriceSpec(Party.PriceMode.FloorPct, -9000), false, 1, 1);
        vm.warp(block.timestamp + 1 hours);
        Party.Floor memory f1 = floorSig(0.95 ether, 0);
        vm.prank(v[0]);
        party.execute(id, f1); // resolves to max(0.095, 1) = 1 ETH >= floor 0.95: 41 is enough while FULL
        assertTrue(party.hasPendingPrice());
        vm.warp(block.timestamp + 10);
        uint256[] memory order = party.depositOrder();
        Party.Floor memory f2 = floorSig(3 ether, 0);
        vm.prank(v[1]);
        party.assemble(order, f2);
        assertEq(party.ask(), 3 ether, "1 ETH < 3 ETH floor with 41 votes: skipped, host default (3 ETH) goes live");
    }

    /// Auditor PoC (was: Fixed 5 ETH passed at a 5 ETH floor went live at a 20 ETH floor with 41 votes).
    function test_M2_fixedPending_rejudgedAtBurn() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        address[] memory v = spread(party, c2(41, 39));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 1, 1);
        vm.warp(block.timestamp + 1 hours);
        Party.Floor memory f1 = floorSig(5 ether, 0);
        vm.prank(v[0]);
        party.execute(id, f1);
        vm.warp(block.timestamp + 10);
        Party.Floor memory f2 = floorSig(20 ether, 0);
        uint256[] memory order = party.depositOrder();
        vm.prank(v[1]);
        party.assemble(order, f2);
        assertEq(party.ask(), 3 ether, "5 ETH below a 20 ETH floor needs 60: default goes live");
    }

    /// The same pending price with 60 votes still goes live below the burn floor (the below-floor rule, not a ban).
    function test_M2_pendingWith60_stillLiveBelowFloor() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        address[] memory v = spread(party, c2(60, 20));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 1, 1);
        vm.warp(block.timestamp + 1 hours);
        Party.Floor memory f1 = floorSig(5 ether, 0);
        vm.prank(v[0]);
        party.execute(id, f1);
        vm.warp(block.timestamp + 10);
        Party.Floor memory f2 = floorSig(20 ether, 0);
        uint256[] memory order = party.depositOrder();
        vm.prank(v[1]);
        party.assemble(order, f2);
        assertEq(party.ask(), 5 ether);
    }

    /// A pending price cannot be forced through by omitting the floor: a Fixed price with 41..59 needs a reading.
    function test_M2_pendingNeedsFloorReading() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        address[] memory v = spread(party, c2(41, 39));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 1, 1);
        vm.warp(block.timestamp + 1 hours);
        Party.Floor memory f1 = floorSig(5 ether, 0);
        vm.prank(v[0]);
        party.execute(id, f1);
        vm.warp(block.timestamp + 10);
        uint256[] memory order = party.depositOrder();
        vm.prank(v[1]);
        vm.expectRevert(bad("floor needed"));
        party.assemble(order, noFloor());
    }
}
