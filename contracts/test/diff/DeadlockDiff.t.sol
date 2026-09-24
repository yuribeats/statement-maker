// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalBase} from "../LocalBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// @notice Scripted scenarios for the deadlock rule, supersession and ask movement. Each test asserts the CONTRACT's
///         behaviour; scripts/diff/scenarios.mjs runs the same scenario through the site's copied code.
contract DeadlockDiffTest is LocalBase {
    Party party;
    address[] v;
    uint256 fullAt;

    function setUp() public override {
        super.setUp();
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 60;
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 1000); // floor + 10%
        uint256[] memory a = ownedBy(holders[0]);
        uint256[] memory b = ownedBy(holders[1]);
        uint256[] memory b20 = new uint256[](20);
        for (uint256 i; i < 20; ++i) b20[i] = b[i];
        party = openParty(p, holders[0], a); // host opens with its 60
        deposit(party, holders[1], b20);
        fullAt = block.timestamp;
        for (uint256 c = 1; c < cards.nextId(); ++c) {
            address x = makeAddr(string.concat("dv", vm.toString(v.length)));
            v.push(x);
            address o = cards.ownerOf(c);
            vm.prank(o);
            cards.transferFrom(o, x, c);
        }
        vm.roll(block.number + 2);
    }

    function _fixed(uint256 eth) internal pure returns (Party.PriceSpec memory) {
        return Party.PriceSpec(Party.PriceMode.Fixed, int256(eth * 1 ether));
    }

    /// proposer v[k], `y` YES total, `n` NO; returns id after the window has closed
    function _prop(uint256 k, Party.PriceSpec memory ps, bool cancel, uint256 y, uint256 n) internal returns (uint256 id) {
        vm.prank(v[k]);
        id = party.propose(ps, cancel, 24, 24);
        uint256 j;
        for (uint256 c; c < 80 && j + 1 < y; ++c) if (c != k) { vm.prank(v[c]); party.vote(id, true); ++j; }
        uint256 m;
        for (uint256 c = 79; m < n; --c) if (c != k) { vm.prank(v[c]); party.vote(id, false); ++m; }
        vm.warp(party.proposal(id).endsAt);
        vm.roll(block.number + 1);
    }

    function _assemble() internal {
        uint256[] memory order = party.depositOrder();
        Party.Floor memory f = floorSig(100 ether, 0); // before prank: floorSig makes an external call
        vm.prank(v[0]);
        party.assemble(order, f);
    }

    // S1: 3 counted NO-blocked proposals, then one executes under the deadlock rule; executing resets the counter,
    //     so the next proposal is NOT a deadlock proposal. Site: any executed proposal ends the deadlock (now equal).
    function test_S1_executionResetsBlockedCounter() public {
        for (uint256 k; k < 3; ++k) party.countBlocked(_prop(k, _fixed(300), false, 50, 1));
        uint256 d = _prop(3, _fixed(300), false, 60, 1);
        assertTrue(party.proposal(d).deadlock);
        Party.Floor memory f = floorSig(100 ether, 0);
        vm.prank(v[3]);
        party.execute(d, f);
        vm.prank(v[4]);
        uint256 e = party.propose(_fixed(400), false, 24, 24);
        assertEq(party.blockedPriceProposals(), 0, "counter reset by execute");
        assertFalse(party.proposal(e).deadlock, "contract: deadlock ends once a price executes");
    }

    // S2: blocked CANCEL_LISTING proposals do not count on the contract. Site: kindOf(CANCEL_LISTING) == LIST, counted.
    function test_S2_blockedCancelNotCounted() public {
        _assemble();
        uint256 id = _prop(0, _fixed(0), true, 50, 1);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not blocked"));
        party.countBlocked(id);
    }

    // S3: 30-day clock. FULL at t, assembled at t+20d, proposal at t+31d: no deadlock (clock from assembly,
    //     11 days). Site: clock from assembly (p.assembled.at || p.fullAt): the two now agree.
    function test_S3_clockFromAssembly() public {
        vm.warp(fullAt + 20 days);
        _assemble();
        vm.warp(fullAt + 31 days);
        vm.prank(v[0]);
        uint256 id = party.propose(_fixed(300), false, 24, 24);
        assertFalse(party.proposal(id).deadlock, "contract: 11 days after assembly is not a deadlock");
        vm.warp(fullAt + 50 days);
        vm.prank(v[1]);
        id = party.propose(_fixed(300), false, 24, 24);
        assertFalse(party.proposal(id).deadlock, "exactly 30 days after assembly: not yet");
        vm.warp(fullAt + 50 days + 1);
        vm.prank(v[2]);
        id = party.propose(_fixed(300), false, 24, 24);
        assertTrue(party.proposal(id).deadlock, "30 days + 1 s after assembly");
    }

    // S4: 3 NO-blocked proposals nobody reports via countBlocked: contract NOT deadlocked. Site counts automatically.
    function test_S4_blockedNeedsCountBlocked() public {
        for (uint256 k; k < 3; ++k) _prop(k, _fixed(300), false, 50, 1);
        vm.prank(v[5]);
        uint256 id = party.propose(_fixed(300), false, 24, 24);
        assertFalse(party.proposal(id).deadlock, "contract: uncounted blocks do not deadlock");
    }

    // S5: a LIST that passed while FULL is superseded by assembly on the contract (epoch bump). Site: still executable.
    /// Since Pashov H2 the burn APPLIES a LIST that passed while FULL and was not executed (as if executed), so it
    /// can no longer be executed afterwards ("executed"); the site must mirror this (the scenario row stays false).
    function test_S5_assemblySupersedesFullTimeProposals() public {
        uint256 id = _prop(0, _fixed(300), false, 41, 0);
        _assemble();
        assertTrue(party.proposal(id).executed, "the passed FULL-time LIST went live at the burn");
        assertEq(party.ask(), 300 ether);
        Party.Floor memory f = floorSig(100 ether, 0);
        vm.prank(v[0]);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "executed"));
        party.execute(id, f);
    }

    // S6: floor-relative ask never goes down on the contract. Site: buy() charges priceEth(listing) at the current floor.
    function test_S6_askNeverFalls() public {
        _assemble(); // floor 100 ETH, +10% → 110 ETH
        assertEq(party.ask(), 110 ether);
        Party.Floor memory f = floorSig(50 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not higher"));
        party.raiseAsk(f);
        vm.warp(block.timestamp + 24 hours);
        assertEq(party.ask(), 110 ether, "contract: ask unchanged when floor halves");
    }
}
