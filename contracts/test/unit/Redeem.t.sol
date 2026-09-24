// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase, PlainHolder} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract RedeemTest is UnitBase {
    Party party;
    uint256[] ids;

    function setUp() public override {
        super.setUp();
        ids = first(holders[0], 5);
        party = openParty(params(CreditKeys.Preset.Deposit), holders[0], ids); // host's opening deposit: cards 1..5
    }

    function test_redeem_byHolder_open() public {
        vm.prank(holders[0]);
        party.redeem(one(1));
        assertEq(credits.ownerOf(ids[0]), holders[0]);
        assertEq(party.count(), 4);
        assertEq(party.cardsOutstanding(), 4);
        assertEq(party.cardOfCredit(ids[0]), 0);
        assertEq(party.creditOfCard(1), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        cards.ownerOf(1);
    }

    function test_redeem_notHolder() public {
        vm.prank(holders[1]);
        vm.expectRevert(bad("not holder"));
        party.redeem(one(1));
    }

    function test_redeem_cardOfAnotherParty() public {
        Party other = openParty(params(CreditKeys.Preset.Deposit), holders[1], first(holders[1], 1)); // card 6 -> `other`
        vm.prank(holders[1]);
        vm.expectRevert(bad("not holder"));
        party.redeem(one(6));
    }

    function test_redeem_nonexistentCard() public {
        vm.prank(holders[0]);
        vm.expectRevert(bad("not holder"));
        party.redeem(one(999));
    }

    function test_redeem_twice() public {
        vm.prank(holders[0]);
        party.redeem(one(1));
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        party.redeem(one(1));
    }

    function test_redeem_followsTheCard() public {
        address buyer = makeAddr("cardBuyer");
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], buyer, 2);
        vm.prank(holders[0]);
        vm.expectRevert(bad("not holder"));
        party.redeem(one(2));
        vm.prank(buyer);
        party.redeem(one(2));
        assertEq(credits.ownerOf(ids[1]), buyer, "credit goes to card holder, not depositor");
    }

    function test_redeem_compactsDepositOrder() public {
        vm.prank(holders[0]);
        party.redeem(c2(2, 4)); // remove ids[1], ids[3]
        uint256[] memory o = party.depositOrder();
        assertEq(o.length, 3);
        assertEq(o[0], ids[0]);
        assertEq(o[1], ids[2]);
        assertEq(o[2], ids[4]);
        vm.prank(holders[0]);
        party.redeem(one(1)); // remove head
        o = party.depositOrder();
        assertEq(o.length, 2);
        assertEq(o[0], ids[2]);
        assertEq(o[1], ids[4]);
        vm.prank(holders[0]);
        party.redeem(one(5)); // remove tail
        o = party.depositOrder();
        assertEq(o.length, 1);
        assertEq(o[0], ids[2]);
    }

    function test_redeem_thenRedeposit() public {
        vm.prank(holders[0]);
        party.redeem(one(1));
        deposit(party, holders[0], one(ids[0]));
        assertEq(party.cardOfCredit(ids[0]), 6);
        uint256[] memory o = party.depositOrder();
        assertEq(o[o.length - 1], ids[0]);
    }

    function test_redeem_lockedWhenFull() public {
        deposit(party, holders[0], slice(holders[0], 0, 55));
        deposit(party, holders[1], first(holders[1], 20));
        assertEq(uint256(party.status()), uint256(Party.Status.FULL));
        vm.prank(holders[0]);
        vm.expectRevert(bad("locked"));
        party.redeem(one(1));
    }

    function test_redeem_lockedWhenAssembled() public {
        deposit(party, holders[0], slice(holders[0], 0, 55));
        deposit(party, holders[1], first(holders[1], 20));
        assembleDeposit(party);
        vm.prank(holders[0]);
        vm.expectRevert(bad("locked"));
        party.redeem(one(1));
    }

    function test_redeem_allowedWhenExpired_fromFull() public {
        deposit(party, holders[0], slice(holders[0], 0, 55));
        deposit(party, holders[1], first(holders[1], 20));
        vm.warp(uint256(party.deadline()) + 1);
        assertEq(uint256(party.status()), uint256(Party.Status.EXPIRED));
        vm.prank(holders[0]);
        party.redeem(one(1));
        assertEq(credits.ownerOf(ids[0]), holders[0]);
    }

    function test_redeemFor_onlyExpired() public {
        vm.expectRevert(bad("not expired"));
        party.redeemFor(one(1));
    }

    function test_redeemFor_paysCurrentHolder_evenContract() public {
        PlainHolder ph = new PlainHolder(); // no onERC721Received
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], address(ph), 3);
        vm.warp(uint256(party.deadline()) + 1);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        party.redeemFor(c2(3, 1));
        assertEq(credits.ownerOf(ids[2]), address(ph));
        assertEq(credits.ownerOf(ids[0]), holders[0]);
        assertEq(party.count(), 3);
    }

    function test_redeemFor_foreignCardRejected() public {
        Party other = openParty(params(CreditKeys.Preset.Deposit), holders[1], first(holders[1], 1)); // card 6
        vm.warp(uint256(party.deadline()) + 1);
        vm.expectRevert(bad("not holder"));
        party.redeemFor(one(6));
    }
}
