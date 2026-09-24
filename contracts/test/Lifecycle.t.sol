// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {Party} from "../src/Party.sol";
import {CreditKeys} from "../src/CreditKeys.sol";

contract LifecycleTest is Base {
    function test_fullCycle_depositBurnSellClaim() public {
        uint256[] memory mine = holdings(WHALE);
        assertGe(mine.length, 80, "whale");
        uint256[] memory ids = take(mine, 0, 80);

        Party party = openParty(params(CreditKeys.Preset.Deposit), WHALE, ids); // host opens with all 80
        assertEq(uint256(party.status()), uint256(Party.Status.FULL));
        assertEq(cards.balanceOf(WHALE), 80);
        for (uint256 i; i < 80; ++i) assertEq(CREDITS.ownerOf(ids[i]), address(party));

        vm.prank(WHALE);
        party.assemble(ids, noFloor());
        assertEq(uint256(party.status()), uint256(Party.Status.ASSEMBLED));
        assertEq(statement.ownerOf(party.statementId()), address(party));
        for (uint256 i; i < 80; ++i) {
            vm.expectRevert();
            CREDITS.ownerOf(ids[i]); // burned
        }
        assertEq(party.ask(), 3 ether);

        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not open yet"));
        party.buy{value: 3 ether}(3 ether);

        vm.warp(block.timestamp + 24 hours - 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not open yet"));
        party.buy{value: 3 ether}(3 ether);
        vm.warp(block.timestamp + 1); // params().buyDelayHours = 24
        vm.prank(buyer);
        party.buy{value: 3.5 ether}(3 ether);
        assertEq(statement.ownerOf(party.statementId()), buyer);
        assertEq(buyer.balance, 7 ether, "refund of excess");

        uint256 fee = 3 ether / 100;
        uint256 per = (3 ether - fee) / 80;
        assertEq(party.perCard(), per);

        uint256[] memory held = cardsOf(party, WHALE);
        uint256 before = WHALE.balance;
        vm.prank(WHALE);
        party.claim(held);
        assertEq(WHALE.balance - before, per * 80);
        assertEq(cards.balanceOf(WHALE), 0);

        vm.prank(feeTo);
        party.withdraw();
        assertEq(feeTo.balance, 3 ether - per * 80, "fee + dust");
        assertEq(address(party).balance, 0, "nothing stuck");
    }

    function test_rarityPreset_verifiedOnChain() public {
        uint256[] memory ids = take(holdings(WHALE), 0, 80);
        Party party = openParty(params(CreditKeys.Preset.Rarity), WHALE, ids);

        uint256[] memory wrong = new uint256[](80);
        for (uint256 i; i < 80; ++i) wrong[i] = ids[i];
        vm.prank(WHALE);
        vm.expectRevert();
        party.assemble(wrong, noFloor()); // deposit order is (almost surely) not rarity order

        uint256[] memory right = sortBy(CreditKeys.Preset.Rarity, wrong);
        uint256 g = gasleft();
        vm.prank(WHALE);
        party.assemble(right, noFloor());
        emit log_named_uint("assemble gas (rarity, 80)", g - gasleft());
        assertTrue(party.assembled());
    }

    function test_manual_hostOnly_anyPermutation() public {
        uint256[] memory ids = take(holdings(WHALE), 0, 80);
        Party party = openParty(params(CreditKeys.Preset.Manual), WHALE, ids); // host = WHALE
        uint256[] memory rev = new uint256[](80);
        for (uint256 i; i < 80; ++i) rev[i] = ids[79 - i];
        address friend = makeAddr("friend"); // a card holder who is not the host
        uint256 card = cardsOf(party, WHALE)[0];
        vm.prank(WHALE);
        cards.transferFrom(WHALE, friend, card);
        vm.prank(friend);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "host only"));
        party.assemble(rev, noFloor());
        vm.prank(WHALE);
        party.assemble(rev, noFloor());
        uint256[] memory burned = party.burnOrder();
        assertEq(burned[0], ids[79]);
    }

    function test_redeem_followsTheCard() public {
        uint256[] memory ids = take(holdings(WHALE), 0, 3);
        Party party = openParty(params(CreditKeys.Preset.Deposit), WHALE, ids);
        uint256[] memory held = cardsOf(party, WHALE);
        address friend = makeAddr("friend");
        vm.prank(WHALE);
        cards.transferFrom(WHALE, friend, held[0]);

        uint256[] memory one = new uint256[](1);
        one[0] = held[0];
        vm.prank(WHALE);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "not holder"));
        party.redeem(one);
        vm.prank(friend);
        party.redeem(one);
        assertEq(CREDITS.ownerOf(party.creditOfCard(held[0]) == 0 ? ids[0] : ids[0]), friend);
        assertEq(party.count(), 2);
    }
}
