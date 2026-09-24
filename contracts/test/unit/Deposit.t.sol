// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase, PlainHolder} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract DepositTest is UnitBase {
    function _dep(Party party, address who, uint256[] memory ids, bytes32[][] memory proofs) internal {
        vm.startPrank(who);
        credits.setApprovalForAll(address(party), true);
        party.deposit(ids, proofs);
        vm.stopPrank();
    }

    function _depExpect(Party party, address who, uint256[] memory ids, bytes32[][] memory proofs, bytes memory err) internal {
        vm.startPrank(who);
        credits.setApprovalForAll(address(party), true);
        vm.expectRevert(err);
        party.deposit(ids, proofs);
        vm.stopPrank();
    }

    function _none() internal pure returns (bytes32[][] memory) {
        return new bytes32[][](0);
    }

    address opener; // holders[5]: hosts and opens each party here, leaving holders[0..3] untouched

    function setUp() public override {
        super.setUp();
        opener = holders[5];
    }

    /// Party opened by `opener` with its first `minDeposit` Credits (count starts at minDeposit).
    function _open(Party.Params memory p) internal returns (Party) {
        return openParty(p, opener, first(opener, p.minDeposit));
    }

    function test_deposit_mintsCardsAndRecords() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256[] memory ids = first(holders[0], 3);
        _dep(party, holders[0], ids, _none());
        assertEq(party.count(), 4, "1 opening + 3");
        assertEq(party.cardsOutstanding(), 4);
        assertEq(cards.balanceOf(holders[0]), 3);
        assertEq(cards.ownerOf(1), opener, "opening card");
        uint256[] memory order = party.depositOrder();
        for (uint256 i; i < 3; ++i) {
            assertEq(order[i + 1], ids[i]);
            assertEq(credits.ownerOf(ids[i]), address(party));
            uint256 card = party.cardOfCredit(ids[i]);
            assertEq(card, i + 2);
            assertEq(party.creditOfCard(card), ids[i]);
            assertEq(cards.partyOf(card), address(party));
        }
        assertEq(party.fullAt(), 0);
    }

    function test_minDeposit_enforced() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minDeposit = 10;
        Party party = _open(p);
        _depExpect(party, holders[0], first(holders[0], 9), _none(), bad("count"));
        _dep(party, holders[0], first(holders[0], 10), _none());
        assertEq(party.count(), 20, "10 opening + 10");
    }

    function test_minDeposit_remainderExemption() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minDeposit = 10;
        Party party = _open(p);
        _dep(party, holders[0], first(holders[0], 55), _none()); // 10 opening + 55
        _dep(party, holders[1], first(holders[1], 10), _none()); // 75 filled
        // 5 remain < min 10: exactly 5 allowed, 4 rejected, 6 rejected
        _depExpect(party, holders[2], first(holders[2], 4), _none(), bad("count"));
        _depExpect(party, holders[2], first(holders[2], 6), _none(), bad("count"));
        _dep(party, holders[2], first(holders[2], 5), _none());
        assertEq(party.count(), 80);
        assertEq(uint256(party.status()), uint256(Party.Status.FULL));
        assertEq(party.fullAt(), block.timestamp);
    }

    function test_moreThanRemaining_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        _dep(party, holders[0], first(holders[0], 49), _none()); // 1 + 49 = 50
        _depExpect(party, holders[1], first(holders[1], 31), _none(), bad("count"));
        _dep(party, holders[1], first(holders[1], 30), _none());
        assertEq(party.count(), 80);
    }

    function test_over80_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256[] memory a = first(holders[0], 60);
        uint256[] memory b = first(holders[1], 21);
        uint256[] memory ids = new uint256[](81);
        for (uint256 i; i < 60; ++i) ids[i] = a[i];
        for (uint256 i; i < 21; ++i) ids[60 + i] = b[i];
        _depExpect(party, holders[0], ids, _none(), bad("count"));
    }

    function test_empty_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        _depExpect(party, holders[0], new uint256[](0), _none(), bad("count"));
    }

    function test_duplicateInOneCall() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256[] memory a = first(holders[0], 2);
        _depExpect(party, holders[0], c3(a[0], a[1], a[0]), _none(), bad("duplicate"));
    }

    function test_alreadyInParty() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256[] memory a = first(holders[0], 2);
        _dep(party, holders[0], a, _none());
        _depExpect(party, holders[0], one(a[0]), _none(), bad("duplicate"));
    }

    function test_notOwner() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256 theirs = first(holders[1], 1)[0];
        // holders[1] approved the party too, so the only thing stopping holders[0] is ownership
        vm.prank(holders[1]);
        credits.setApprovalForAll(address(party), true);
        _depExpect(
            party,
            holders[0],
            one(theirs),
            _none(),
            abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, holders[0], theirs, holders[1])
        );
        assertEq(credits.ownerOf(theirs), holders[1]);
    }

    function test_notApproved() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256 id = first(holders[0], 1)[0];
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(party), id));
        party.deposit(one(id), _none());
    }

    function test_singleTokenApprovalWorks() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        uint256 id = first(holders[0], 1)[0];
        vm.startPrank(holders[0]);
        credits.approve(address(party), id);
        party.deposit(one(id), _none());
        vm.stopPrank();
        assertEq(party.count(), 2);
    }

    function test_afterDeadline_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        vm.warp(party.deadline());
        _dep(party, holders[0], first(holders[0], 1), _none()); // at deadline: still OPEN
        vm.warp(uint256(party.deadline()) + 1);
        _depExpect(party, holders[0], slice(holders[0], 1, 1), _none(), bad("not open"));
    }

    function test_whenFull_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        fill(party);
        _depExpect(party, holders[2], first(holders[2], 1), _none(), bad("not open"));
    }

    function test_afterAssembled_rejected() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        _depExpect(party, holders[2], first(holders[2], 1), _none(), bad("not open"));
    }

    function test_depositorCanBeContract_cardMintedWithoutCallback() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        PlainHolder ph = new PlainHolder();
        uint256 id = first(holders[0], 1)[0];
        vm.prank(holders[0]);
        credits.transferFrom(holders[0], address(ph), id);
        vm.startPrank(address(ph));
        credits.setApprovalForAll(address(party), true);
        party.deposit(one(id), _none());
        vm.stopPrank();
        assertEq(cards.balanceOf(address(ph)), 1);
    }

    // ------------------------------------------------------------------ Merkle eligibility

    function _eligibleSetup() internal returns (Party party, uint256[] memory ids, bytes32[] memory leaves) {
        ids = first(holders[0], 6);
        uint256 openId = first(opener, 1)[0];
        leaves = new bytes32[](7); // odd count exercises the promoted-node path
        for (uint256 i; i < 6; ++i) leaves[i] = leafOf(ids[i]);
        leaves[6] = leafOf(openId);
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.eligibleRoot = merkleRoot(leaves);
        bytes32[][] memory op = new bytes32[][](1);
        op[0] = merkleProof(leaves, 6); // the host's opening deposit must meet the criteria too
        party = openPartyWith(factory, p, opener, one(openId), op);
    }

    function test_merkle_validProofs() public {
        (Party party, uint256[] memory ids, bytes32[] memory leaves) = _eligibleSetup();
        bytes32[][] memory proofs = new bytes32[][](6);
        for (uint256 i; i < 6; ++i) proofs[i] = merkleProof(leaves, i);
        _dep(party, holders[0], ids, proofs);
        assertEq(party.count(), 7, "1 opening + 6");
    }

    function test_merkle_wrongProof() public {
        (Party party, uint256[] memory ids, bytes32[] memory leaves) = _eligibleSetup();
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = merkleProof(leaves, 1); // proof for another leaf
        _depExpect(party, holders[0], one(ids[0]), proofs, bad("not eligible"));
    }

    function test_merkle_ineligibleId() public {
        (Party party,, bytes32[] memory leaves) = _eligibleSetup();
        uint256 outsider = slice(holders[0], 10, 1)[0];
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = merkleProof(leaves, 0);
        _depExpect(party, holders[0], one(outsider), proofs, bad("not eligible"));
    }

    function test_merkle_singleHashedLeafRejected() public {
        // a tree built from single-hashed leaves must not validate
        uint256[] memory ids = first(holders[0], 4);
        bytes32[] memory leaves = new bytes32[](4);
        for (uint256 i; i < 4; ++i) leaves[i] = keccak256(abi.encode(ids[i]));
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.eligibleRoot = merkleRoot(leaves);
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = merkleProof(leaves, 0);
        // the host cannot even open with it: the opening deposit is checked against the same root
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(predicted, true);
        vm.expectRevert(bad("not eligible"));
        factory.createParty(p, one(ids[0]), proofs);
        vm.stopPrank();
    }

    function test_merkle_missingProofs() public {
        (Party party, uint256[] memory ids, bytes32[] memory leaves) = _eligibleSetup();
        _depExpect(party, holders[0], c2(ids[0], ids[1]), _none(), bad("proofs"));
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = merkleProof(leaves, 0);
        _depExpect(party, holders[0], c2(ids[0], ids[1]), proofs, bad("proofs"));
    }

    function test_merkle_ignoredWhenRootZero() public {
        Party party = _open(params(CreditKeys.Preset.Deposit));
        bytes32[][] memory junk = new bytes32[][](5);
        _dep(party, holders[0], first(holders[0], 1), junk); // proofs length irrelevant with no root
        assertEq(party.count(), 2);
    }
}
