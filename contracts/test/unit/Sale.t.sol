// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase, PlainHolder, EthRejecter} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract SaleTest is UnitBase {
    Party party;
    address buyer = makeAddr("buyer");

    function setUp() public override {
        super.setUp();
        party = _assembledAt(3 ether);
        vm.deal(buyer, 100 ether);
    }

    function _assembledAt(uint256 price) internal returns (Party p) {
        Party.Params memory ps = params(CreditKeys.Preset.Deposit);
        ps.defaultPrice = fixedPrice(price);
        p = newParty(ps);
        fill(p);
        assembleDeposit(p);
    }

    function _open() internal {
        vm.warp(uint256(party.askLiveAt()) + 24 hours);
    }

    function _buy(uint256 value, uint256 maxPrice) internal {
        vm.prank(buyer);
        party.buy{value: value}(maxPrice);
    }

    // ------------------------------------------------------------------ buy gates

    function test_buy_delay() public {
        vm.warp(uint256(party.askLiveAt()) + 24 hours - 1);
        vm.prank(buyer);
        vm.expectRevert(bad("not open yet"));
        party.buy{value: 3 ether}(3 ether);
        vm.warp(uint256(party.askLiveAt()) + 24 hours);
        _buy(3 ether, 3 ether);
        assertEq(statement.ownerOf(party.statementId()), buyer);
        assertEq(uint256(party.status()), uint256(Party.Status.SOLD));
        assertTrue(party.sold());
        assertEq(party.ask(), 0);
    }

    function test_buy_maxPriceBelowAsk() public {
        _open();
        vm.prank(buyer);
        vm.expectRevert(bad("price"));
        party.buy{value: 3 ether}(3 ether - 1);
    }

    function test_buy_valueBelowAsk() public {
        _open();
        vm.prank(buyer);
        vm.expectRevert(bad("price"));
        party.buy{value: 3 ether - 1}(3 ether);
    }

    function test_buy_overpayRefunded() public {
        _open();
        _buy(5 ether, 10 ether);
        assertEq(buyer.balance, 97 ether);
        assertEq(address(party).balance, 3 ether);
    }

    function test_buy_refundRejectedReverts() public {
        _open();
        EthRejecter r = new EthRejecter();
        vm.deal(address(r), 10 ether);
        vm.prank(address(r));
        vm.expectRevert(bad("refund"));
        party.buy{value: 4 ether}(3 ether);
        vm.prank(address(r)); // exact value: no refund needed, contract buyer fine
        party.buy{value: 3 ether}(3 ether);
        assertEq(statement.ownerOf(party.statementId()), address(r));
    }

    function test_buy_twice() public {
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(buyer);
        vm.expectRevert(bad("not for sale"));
        party.buy{value: 3 ether}(3 ether);
    }

    function test_buy_notAssembled() public {
        Party p = openParty(params(CreditKeys.Preset.Deposit), holders[2], first(holders[2], 40));
        deposit(p, holders[3], first(holders[3], 40));
        vm.warp(block.timestamp + 2 days);
        vm.prank(buyer);
        vm.expectRevert(bad("not for sale"));
        p.buy{value: 3 ether}(3 ether);
    }

    // ------------------------------------------------------------------ split

    /// No creator royalty: the split is 1% fee (+ dust) and 80 equal shares, whatever the Statement declares.
    function _checkSplit(Party p, uint256 price, uint256, address royaltyTo) internal {
        uint256 royalty = 0;
        uint256 fee = price * 100 / 10_000;
        uint256 pot = price - royalty - fee;
        uint256 share = pot / 80;
        uint256 dust = pot - share * 80;
        assertEq(p.perCard(), share, "perCard");
        assertEq(p.owed(feeTo), fee + dust, "fee + dust");
        if (royaltyTo != address(0) && royaltyTo != feeTo) assertEq(p.owed(royaltyTo), 0, "no royalty paid");
        assertEq(royalty + fee + dust + share * 80, price, "conservation");
        assertEq(address(p).balance, price, "held");
    }

    function test_split_noRoyalty_withDust() public {
        Party p = _assembledAtAlt(3 ether + 7);
        vm.warp(uint256(p.askLiveAt()) + 24 hours);
        vm.prank(buyer);
        p.buy{value: 3 ether + 7}(3 ether + 7);
        _checkSplit(p, 3 ether + 7, 0, address(0));
        assertGt(p.owed(feeTo), uint256(3 ether + 7) / 100, "dust nonzero");
    }

    function _assembledAtAlt(uint256 price) internal returns (Party p) {
        Party.Params memory ps = params(CreditKeys.Preset.Deposit);
        ps.defaultPrice = fixedPrice(price);
        p = openParty(ps, holders[2], first(holders[2], 40));
        deposit(p, holders[3], first(holders[3], 40));
        uint256[] memory dep = p.depositOrder();
        vm.prank(holders[2]);
        p.assemble(dep, noFloor());
    }

    /// The Statement contract declares a 5% ERC-2981 royalty; nothing is paid to it.
    function test_split_declaredRoyaltyIgnored() public {
        address artist = makeAddr("artist");
        statement.setRoyalty(artist, 500);
        _open();
        _buy(3 ether, 3 ether);
        assertEq(party.owed(artist), 0);
        assertEq(party.perCard(), 0.037125 ether, "spec example: 0.03 platform, 2.97 to holders");
        _checkSplit(party, 3 ether, 500, artist);
    }

    function test_split_royaltyReceiverZeroIgnored() public {
        statement.setRoyalty(address(0), 500);
        _open();
        _buy(3 ether, 3 ether);
        assertEq(party.owed(address(0)), 0);
        _checkSplit(party, 3 ether, 0, address(0));
    }

    // ------------------------------------------------------------------ claim / withdraw

    function test_claim_beforeSale() public {
        uint256[] memory mine = cardsOf(party, holders[0]);
        vm.prank(holders[0]);
        vm.expectRevert(bad("not sold"));
        party.claim(mine);
    }

    function test_claim_onlyHolder() public {
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(holders[1]);
        vm.expectRevert(bad("not holder"));
        party.claim(one(1)); // card 1 is holders[0]'s
    }

    function test_claim_foreignCard() public {
        _assembledAtAlt(3 ether); // second party: cards 81..160
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(holders[2]);
        vm.expectRevert(bad("not holder"));
        party.claim(one(81));
    }

    function test_claim_doubleImpossible() public {
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(holders[0]);
        party.claim(one(1));
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        party.claim(one(1));
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 2));
        party.claim(c2(2, 2)); // duplicate within one call
    }

    function test_claim_followsCard_andContractHolder() public {
        PlainHolder ph = new PlainHolder();
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], address(ph), 5);
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(holders[0]);
        vm.expectRevert(bad("not holder"));
        party.claim(one(5));
        ph.claim(party, one(5));
        assertEq(address(ph).balance, party.perCard());
    }

    function test_claim_rejectingContractCannotClaim_butCanTransferCard() public {
        EthRejecter r = new EthRejecter();
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], address(r), 5);
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(address(r));
        vm.expectRevert(bad("send"));
        party.claim(one(5));
        assertEq(cards.ownerOf(5), address(r), "card survives the failed claim");
    }

    function test_fullDrain_exact() public {
        address artist = makeAddr("artist");
        statement.setRoyalty(artist, 333);
        _open();
        _buy(3 ether, 3 ether);
        uint256[] memory a = cardsOf(party, holders[0]);
        uint256[] memory b = cardsOf(party, holders[1]);
        vm.prank(holders[0]);
        party.claim(a);
        vm.prank(holders[1]);
        party.claim(b);
        assertEq(party.cardsOutstanding(), 0);
        vm.prank(feeTo);
        party.withdraw();
        vm.prank(artist); // a declared royalty receiver is owed nothing
        vm.expectRevert(bad("nothing"));
        party.withdraw();
        assertEq(address(party).balance, 0, "nothing stuck");
        assertEq(holders[0].balance, party.perCard() * 60);
        vm.prank(feeTo);
        vm.expectRevert(bad("nothing"));
        party.withdraw();
    }

    function test_withdraw_nothing() public {
        vm.expectRevert(bad("nothing"));
        party.withdraw();
    }

    function test_claim_empty_noop() public {
        _open();
        _buy(3 ether, 3 ether);
        vm.prank(holders[0]);
        party.claim(new uint256[](0));
        assertEq(address(party).balance, 3 ether);
    }

    function test_receive_rejectsEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory ret) = address(party).call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, bad("no direct ETH"));
    }
}
