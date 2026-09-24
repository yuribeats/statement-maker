// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface ICreditsBurnF {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
}

/// Statement stand-in with a catch-all fallback (as some proxies/routers have): royaltyInfo() "succeeds" with
/// 32 bytes of return data instead of 64.
contract CatchAllStatement is ERC721 {
    ICreditsBurnF immutable credits;
    uint256 next = 1;

    constructor(address c) ERC721("S", "S") {
        credits = ICreditsBurnF(c);
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        credits.burn(msg.sender, ids);
        id = next++;
        _mint(msg.sender, id);
    }

    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// Regression tests for the first audit round. Each test asserted the behavior the spec intends and failed against
/// the pre-884add5 contracts; all four pass since the audit-fix batch (884add5).
/// Run: forge test --match-contract FindingsTest
contract FindingsTest is UnitBase {
    // F1 (fixed: no lifetime cap, per-proposer open list). One card rotated across fresh addresses used to exhaust
    //     MAX_PROPOSALS (256, lifetime); after that no LIST or CANCEL could ever be proposed again.
    function test_REGRESSION_oneCardCannotExhaustProposals() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        address holder = v[1];
        uint256 card = cardsOf(party, holder)[0];
        for (uint256 s; party.proposalCount() < 256; ++s) {
            address sybil = makeAddr(string.concat("sybil", vm.toString(s)));
            vm.prank(holder);
            cards.transferFrom(holder, sybil, card);
            holder = sybil;
            roll();
            for (uint256 k; k < 3 && party.proposalCount() < 256; ++k) {
                vm.prank(sybil);
                party.propose(fixedPrice(1e24), false, 168, 24);
            }
        }
        // the 79-card majority can still propose a LIST and a CANCEL after 256 griefing proposals
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 0, 24);
        assertEq(id, 256);
        Party.PriceSpec memory z;
        vm.prank(v[0]);
        party.propose(z, true, 0, 24);
        assertEq(party.openProposalsOf(v[0]).length, 2);
    }

    // F2 (fixed: countBlocked needs YES >= 41 stopped by NO). A single card holder could switch the party into
    //     deadlock mode (NO ignored, 54 passes) by NO-voting their own proposals and counting them.
    function test_REGRESSION_selfBlockedProposalsCannotTriggerDeadlock() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        address a = v[1];
        uint256[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            vm.prank(a);
            ids[i] = party.propose(fixedPrice(5 ether), false, 24, 24);
            vm.prank(a);
            party.vote(ids[i], false); // proposer flips own vote to NO
        }
        vm.warp(party.proposal(ids[2]).endsAt);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(bad("not blocked"));
            party.countBlocked(ids[i]);
        }
        assertEq(party.blockedPriceProposals(), 0);
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 0, 24);
        assertFalse(party.proposal(id).deadlock, "deadlock manufactured by one 1-card holder");
    }

    // F3 (fixed: execute resets blockedPriceProposals). The count-based deadlock used to survive an execution.
    function test_REGRESSION_blockedCounterResetsOnExecute() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(60, 20));
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[0]);
            uint256 b = party.propose(fixedPrice(5 ether), false, 24, 24);
            vm.prank(v[1]);
            party.vote(b, false);
        }
        vm.warp(block.timestamp + 24 hours);
        for (uint256 i; i < 3; ++i) party.countBlocked(i);
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 24, 24);
        vm.warp(party.proposal(id).endsAt);
        Party.Floor memory f = floorSig(3 ether, 0);
        assertTrue(party.proposal(id).deadlock);
        vm.prank(v[0]);
        party.execute(id, f); // passes under deadlock (60 >= 54, NO ignored)
        assertEq(party.blockedPriceProposals(), 0);
        vm.prank(v[0]);
        uint256 next = party.propose(fixedPrice(6 ether), false, 24, 24);
        assertFalse(party.proposal(next).deadlock, "deadlock should clear after a price executes");
    }

    // F4 (fixed: raw staticcall, short answers ignored). A Statement whose fallback returned short data used to
    //     make buy() revert forever while decoding royaltyInfo's return value.
    function test_REGRESSION_shortRoyaltyReturnDoesNotBrickBuy() public {
        CatchAllStatement st = new CatchAllStatement(address(credits));
        PartyFactory f2 = new PartyFactory(ICredits(address(credits)), IStatement(address(st)), feeTo, vm.addr(signerKey), collectionOwner);
        Party party = openPartyWith(f2, params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        vm.warp(block.timestamp + 24 hours);
        address buyer = makeAddr("buyer");
        vm.deal(buyer, 3 ether);
        vm.prank(buyer);
        party.buy{value: 3 ether}(3 ether);
        assertEq(st.ownerOf(1), buyer);
        assertEq(party.perCard(), (3 ether - 3 ether / 100) / 80, "no royalty taken");
    }
}
