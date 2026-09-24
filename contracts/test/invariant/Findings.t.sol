// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalBase} from "../LocalBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// @notice Minimal reproductions of issues found while building the invariant suite. Each test asserts the
///         behaviour SPEC.md asks for; all three failed before the audit-fix batch (884add5) and are now
///         regression tests.
contract FindingsTest is LocalBase {
    Party party;

    function _take(address who, uint256 n) internal view returns (uint256[] memory out) {
        uint256[] memory all = ownedBy(who);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = all[i];
    }

    /// holders[0] gets `a` cards, holders[1] `b`, holders[2] the rest of 80.
    function _full(uint256 a, uint256 b, uint32 days_) internal {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = days_;
        party = openParty(p, holders[0], _take(holders[0], a)); // holders[0] hosts with its opening deposit
        deposit(party, holders[1], _take(holders[1], b));
        if (80 - a - b > 0) deposit(party, holders[2], _take(holders[2], 80 - a - b));
        assertEq(uint256(party.status()), uint256(Party.Status.FULL));
        vm.roll(block.number + 1);
    }

    function _list(uint256 wei_) internal pure returns (Party.PriceSpec memory) {
        return Party.PriceSpec(Party.PriceMode.Fixed, int256(wei_));
    }

    /// F1. A single card holder can put the whole party into deadlock mode by NO-voting their own proposals,
    ///     which strips every other member's zero-NO veto (NO is ignored once 54 YES are reached).
    ///     Spec §4: "after 3 NO-blocked proposals" means proposals that were blocked by NO, i.e. that had the
    ///     YES to pass. countBlocked() counts any proposal with a NO, including a 1-card self-block.
    function test_F1_oneCardHolderStripsTheNoVeto() public {
        _full(1, 60, 14); // holders[0]: 1 card, holders[1]: 60, holders[2]: 19
        address lone = holders[0];
        for (uint256 i; i < 3; ++i) {
            vm.prank(lone);
            uint256 id = party.propose(_list(1 ether), false, 24, 24);
            vm.prank(lone);
            party.vote(id, false); // flips own YES to NO
        }
        vm.warp(block.timestamp + 24 hours);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not blocked")); // YES = 0: never counts
            party.countBlocked(i);
        }
        assertEq(party.blockedPriceProposals(), 0);

        // Now the 60-card holder lists over the 19-card holder's NO.
        vm.roll(block.number + 1);
        vm.prank(holders[1]);
        uint256 pid = party.propose(_list(3 ether), false, 24, 24);
        vm.prank(holders[2]);
        party.vote(pid, false);
        vm.warp(block.timestamp + 24 hours);
        Party.Floor memory f = floorSig(1 ether, 0);
        vm.prank(holders[1]);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "did not pass"));
        party.execute(pid, f); // a NO blocks: no deadlock was manufactured
    }

    /// F2. MAX_PROPOSALS caps proposals ever created, not proposals open. One card passed between fresh
    ///     addresses (3 proposals each, one block apart) exhausts all 256 slots in ~86 blocks; after that no
    ///     LIST or CANCEL can ever be proposed again, so the price is frozen at whatever is live (or none).
    function test_F2_oneCardExhaustsProposalCapForever() public {
        _full(1, 59, 60); // holders[2] gets the other 20
        uint256 card = 1; // holders[0]'s only card (first minted)
        assertEq(cards.ownerOf(card), holders[0]);
        address cur = holders[0];
        for (uint256 k; party.proposalCount() < 256; ++k) {
            for (uint256 j; j < 3 && party.proposalCount() < 256; ++j) {
                vm.prank(cur);
                party.propose(_list(1 ether + j), false, 24, 24);
            }
            address next = address(uint160(0x10000 + k));
            vm.prank(cur);
            cards.transferFrom(cur, next, card);
            cur = next;
            vm.roll(block.number + 1);
        }
        vm.warp(block.timestamp + 3 days); // every griefing proposal is closed; party still FULL
        vm.roll(block.number + 1);
        vm.prank(holders[1]); // 59 of 80 cards
        uint256 id = party.propose(_list(3 ether), false, 48, 24); // no lifetime cap any more
        assertEq(id, party.proposalCount() - 1);
        assertGe(id, 256);
    }

    /// F3. Spec §4: deadlock after "30 days since FULL/assembly without one executing". _deadlocked() ignores
    ///     assembly, so a party that filled on day 0 and assembled on day 29 is in deadlock mode (NO ignored)
    ///     two days after its Statement exists.
    function test_F3_deadlockClockIgnoresAssembly() public {
        _full(20, 30, 60);
        vm.warp(block.timestamp + 29 days);
        uint256[] memory order = party.depositOrder();
        vm.prank(holders[1]);
        party.assemble(order, noFloor());
        vm.warp(block.timestamp + 2 days);
        vm.roll(block.number + 1);
        vm.prank(holders[1]);
        uint256 id = party.propose(_list(5 ether), false, 24, 24);
        assertFalse(party.proposal(id).deadlock, "deadlock 2 days after assembly");
    }
}
