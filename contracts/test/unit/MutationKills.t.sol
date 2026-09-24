// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase, EthRejecter} from "./UnitBase.t.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Party} from "../../src/Party.sol";
import {CreditCards} from "../../src/CreditCards.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// Stands in for a factory with an arbitrary time unit, to reach Party.initialize's bounds check.
contract UnitFactory {
    ICredits public credits;
    CreditCards public cards;
    IStatement public statement;
    uint256 public timeUnit;

    constructor(ICredits c, CreditCards k, uint256 u) {
        credits = c;
        cards = k;
        timeUnit = u;
    }

    function init(Party impl, address host, Party.Params calldata p) external returns (Party party) {
        party = Party(payable(Clones.clone(address(impl))));
        party.initialize(host, p);
    }
}

interface ICreditsBurnK {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
}

/// A Statement contract that misbehaves in make(): mode 0 mints without burning, mode 1 burns but mints elsewhere.
contract BadStatement is ERC721 {
    ICreditsBurnK immutable credits;
    uint8 immutable mode;
    uint256 next = 1;

    constructor(address c, uint8 m) ERC721("B", "B") {
        credits = ICreditsBurnK(c);
        mode = m;
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        id = next++;
        if (mode == 0) {
            _mint(msg.sender, id);
        } else {
            credits.burn(msg.sender, ids);
            _mint(address(0xdead), id);
        }
    }
}

/// Tests added to kill surviving mutants from the slither-mutate campaign (contracts/audit/mutation/).
contract MutationKillsTest is UnitBase {
    function test_initialize_timeUnitBounds() public {
        Party impl = factory.implementation();
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        UnitFactory zero = new UnitFactory(ICredits(address(credits)), cards, 0);
        vm.expectRevert(bad("timeUnit"));
        zero.init(impl, holders[0], p);
        UnitFactory big = new UnitFactory(ICredits(address(credits)), cards, 1 hours + 1);
        vm.expectRevert(bad("timeUnit"));
        big.init(impl, holders[0], p);
        UnitFactory ok = new UnitFactory(ICredits(address(credits)), cards, 1 hours);
        Party party = ok.init(impl, holders[0], p);
        assertEq(party.timeUnit(), 1 hours);
        UnitFactory one_ = new UnitFactory(ICredits(address(credits)), cards, 1);
        assertEq(one_.init(impl, holders[0], p).timeUnit(), 1);
    }

    function test_events_depositRedeem() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit)); // card 1 -> holders[0]
        uint256 id = first(holders[1], 1)[0];
        vm.startPrank(holders[1]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectEmit(address(party));
        emit Party.Deposited(holders[1], id, 2);
        factory.deposit(party, one(id), new bytes32[][](0));
        vm.expectEmit(address(party));
        emit Party.Redeemed(holders[1], id, 2);
        party.redeem(one(2));
        vm.stopPrank();
    }

    function test_events_raiseAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 0);
        Party party = newParty(p);
        fill(party);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory f = floorSig(2 ether, 0);
        vm.prank(holders[0]);
        party.assemble(dep, f);
        vm.warp(block.timestamp + 1);
        Party.Floor memory up = floorSig(3 ether, 0);
        vm.expectEmit(address(party));
        emit Party.AskSet(3 ether, false);
        party.raiseAsk(up);
    }

    // ------------------------------------------------------------------ assembly guards

    function _badStatementParty(uint8 mode) internal returns (Party party) {
        BadStatement st = new BadStatement(address(credits), mode);
        PartyFactory f2 = new PartyFactory(ICredits(address(credits)), IStatement(address(st)), feeTo, vm.addr(signerKey), collectionOwner, traits);
        party = openPartyWith(f2, params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
    }

    function test_assemble_statementMustBurnAll80() public {
        Party party = _badStatementParty(0);
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        vm.expectRevert(bad("not burned"));
        party.assemble(dep, noFloor());
    }

    function test_assemble_statementMustBeReceived() public {
        Party party = _badStatementParty(1);
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        vm.expectRevert(bad("statement not received"));
        party.assemble(dep, noFloor());
    }

    function test_onERC721Received_closedAgainAfterAssembly() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.prank(address(statement));
        vm.expectRevert(bad("unexpected token"));
        party.onERC721Received(address(statement), address(0), 2, "");
    }

    // ------------------------------------------------------------------ sale accounting

    function _assembled() internal returns (Party party) {
        party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.warp(party.buyableAt());
    }

    function test_buy_refundIsExcess_notRemainder() public {
        Party party = _assembled();
        address b = makeAddr("buyer");
        vm.deal(b, 10 ether);
        vm.prank(b);
        party.buy{value: 7 ether}(3 ether); // 7 - 3 = 4 back (7 % 3 would be 1)
        assertEq(b.balance, 7 ether);
    }

    function test_buy_royaltyToFeeRecipient_sumsOwed() public {
        statement.setRoyalty(feeTo, 500);
        Party party = _assembled();
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        assertEq(party.owed(feeTo), 3 ether - 80 * party.perCard(), "royalty + fee + dust, none overwritten");
    }

    function test_claim_and_claimFor_clearCreditOfCard() public {
        Party party = _assembled();
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        assertTrue(party.creditOfCard(1) != 0 && party.creditOfCard(2) != 0);
        vm.prank(holders[0]);
        party.claim(one(1));
        party.claimFor(one(2));
        assertEq(party.creditOfCard(1), 0);
        assertEq(party.creditOfCard(2), 0);
    }

    function test_claimFor_rejectingHolderWithTwoCards_owedAccumulates() public {
        Party party = _assembled();
        EthRejecter r = new EthRejecter();
        vm.startPrank(holders[0]);
        cards.transferFrom(holders[0], address(r), 1);
        cards.transferFrom(holders[0], address(r), 2);
        vm.stopPrank();
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        party.claimFor(c2(1, 2));
        assertEq(party.owed(address(r)), 2 * party.perCard());
    }

    // ------------------------------------------------------------------ events

    function test_events_lifecycle() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        uint256[] memory dep = party.depositOrder();
        vm.expectEmit(address(party));
        emit Party.Assembled(holders[0], 1, dep);
        vm.expectEmit(address(party));
        emit Party.AskSet(3 ether, false);
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        roll();

        uint256 end = block.timestamp + 24 hours;
        vm.expectEmit(address(party));
        emit Party.Proposed(0, holders[0], false, Party.PriceMode.Fixed, 5 ether, uint64(end), false);
        vm.expectEmit(address(party));
        emit Party.Voted(0, holders[0], true, 60);
        vm.prank(holders[0]);
        party.propose(fixedPrice(5 ether), false, 24, 1);
        vm.expectEmit(address(party));
        emit Party.Voted(0, holders[1], true, 20);
        vm.prank(holders[1]);
        party.vote(0, true);
        vm.warp(end);
        vm.expectEmit(address(party));
        emit Party.AskSet(5 ether, true);
        vm.expectEmit(address(party));
        emit Party.Executed(0, holders[1]);
        vm.prank(holders[1]);
        party.execute(0, noFloor());

        vm.warp(party.buyableAt());
        address b = makeAddr("buyer");
        vm.deal(b, 5 ether);
        uint256 fee = 5 ether / 100;
        uint256 share = (5 ether - fee) / 80;
        vm.expectEmit(address(party));
        emit Party.Sold(b, 5 ether, 0, fee, share);
        vm.prank(b);
        party.buy{value: 5 ether}(5 ether);
        vm.expectEmit(address(party));
        emit Party.Claimed(holders[0], 1, share);
        vm.prank(holders[0]);
        party.claim(one(1));
    }

    // ------------------------------------------------------------------ round-2 kills (boundary and bookkeeping gaps)

    function test_initialize_zeroHostRejected() public {
        UnitFactory uf = new UnitFactory(ICredits(address(credits)), cards, 1 hours);
        Party impl = factory.implementation();
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        vm.expectRevert(bad("host"));
        uf.init(impl, address(0), p);
    }

    function test_redeem_removesExactCredit_descendingIds() public {
        uint256[] memory asc = first(holders[0], 4);
        uint256[] memory desc = new uint256[](4);
        for (uint256 i; i < 4; ++i) desc[i] = asc[3 - i]; // larger ids deposited first
        Party party = openParty(params(CreditKeys.Preset.Deposit), holders[0], desc); // cards 1..4
        vm.prank(holders[0]);
        party.redeem(one(3)); // card 3 holds desc[2]; an earlier slot holds a larger id
        uint256[] memory o = party.depositOrder();
        assertEq(o.length, 3);
        assertEq(o[0], desc[0]);
        assertEq(o[1], desc[1]);
        assertEq(o[2], desc[3]);
        assertEq(credits.ownerOf(desc[2]), holders[0]);
    }

    function _gov(uint256[] memory counts) internal returns (Party party, address[] memory v) {
        (party, v) = assembledWithVoters(counts);
    }

    function test_vote_closedAfterEnd() public {
        (Party party, address[] memory v) = _gov(c2(50, 30));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 24, 0);
        vm.warp(uint256(party.proposal(id).endsAt) + 1);
        vm.prank(v[1]);
        vm.expectRevert(bad("closed"));
        party.vote(id, true);
    }

    function test_cancel_ignoresFloorArgument() public {
        (Party party, address[] memory v) = _gov(one(80));
        Party.PriceSpec memory z;
        vm.prank(v[0]);
        uint256 id = party.propose(z, true, 0, 0);
        vm.warp(party.proposal(id).endsAt);
        vm.prank(v[0]);
        party.execute(id, Party.Floor(1, 1, hex"deadbeef")); // junk reading is never read for a cancel
        assertEq(party.ask(), 0);
    }

    function test_fixedWithFloor_notClampedToMinAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 1 ether;
        Party party = newParty(p);
        fill(party);
        assembleDeposit(party);
        address[] memory v = spread(party, one(80));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(0.2 ether), false, 24, 0);
        vm.warp(party.proposal(id).endsAt);
        Party.Floor memory f = floorSig(0.1 ether, 0);
        vm.prank(v[0]);
        party.execute(id, f);
        assertEq(party.ask(), 0.2 ether);
    }

    function test_countBlocked_fourthCountStillDeadlocks() public {
        (Party party, address[] memory v) = _gov(c3(50, 25, 5));
        uint256[4] memory ids;
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[0]);
            ids[i] = party.propose(fixedPrice(5 ether), false, 24, 0);
            vm.prank(v[2]);
            party.vote(ids[i], false);
        }
        vm.prank(v[1]);
        ids[3] = party.propose(fixedPrice(5 ether), false, 24, 0);
        vm.prank(v[0]);
        party.vote(ids[3], true);
        vm.prank(v[2]);
        party.vote(ids[3], false);
        vm.warp(party.proposal(ids[3]).endsAt);
        for (uint256 i; i < 4; ++i) party.countBlocked(ids[i]);
        assertEq(party.blockedPriceProposals(), 4);
        vm.prank(v[0]);
        uint256 d = party.propose(fixedPrice(5 ether), false, 24, 0);
        assertTrue(party.proposal(d).deadlock, "more than 3 blocked is still deadlock");
    }

    function test_openList_freedWellAfterClose() public {
        (Party party, address[] memory v) = _gov(one(80));
        uint256 first_;
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[0]);
            uint256 id = party.propose(fixedPrice(5 ether), false, 24, 0);
            if (i == 0) first_ = id;
        }
        vm.warp(uint256(party.proposal(first_).endsAt) + 1 hours);
        vm.prank(v[0]);
        party.propose(fixedPrice(5 ether), false, 24, 0);
        assertEq(party.openProposalsOf(v[0]).length, 1);
    }

    function test_buy_openAfterWait() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.warp(uint256(party.buyableAt()) + 5 hours);
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        assertTrue(party.sold());
    }

    function test_claimFor_paidHolderNotAlsoCredited() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.warp(party.buyableAt());
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        party.claimFor(c2(1, 61));
        assertEq(party.owed(holders[0]), 0);
        assertEq(party.owed(holders[1]), 0);
        assertEq(address(party).balance, party.owed(feeTo) + 78 * party.perCard());
    }

    function test_floorPct_belowMinus100PercentRejected() public {
        (Party party, address[] memory v) = _gov(one(80));
        int256[3] memory badPct = [int256(-10_000), -10_001, -1e24];
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[0]);
            vm.expectRevert(bad("price"));
            party.propose(Party.PriceSpec(Party.PriceMode.FloorPct, badPct[i]), false, 24, 0);
        }
    }

    /// Timestamps past 2^32 (year 2106): every stored time keeps its full value (no narrowing).
    function test_timesBeyond32Bits() public {
        uint256 t = 5_000_000_000;
        vm.warp(t);
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        assertEq(party.createdAt(), t);
        assertEq(party.deadline(), t + 14 days);
        vm.warp(t + 13 days);
        fill(party);
        assertEq(party.fullAt(), t + 13 days);
        assertEq(party.deadline(), t + 15 days, "fill grace from a 64-bit now");
        assembleDeposit(party);
        assertEq(party.assembledAt(), t + 13 days);
        assertEq(party.askLiveAt(), t + 13 days);
        assertEq(party.buyableAt(), t + 13 days + 24 hours);
        address[] memory v = spread(party, one(80));
        vm.prank(v[0]);
        uint256 id = party.propose(fixedPrice(5 ether), false, 24, 2);
        vm.warp(party.proposal(id).endsAt);
        vm.prank(v[0]);
        party.execute(id, noFloor());
        uint256 now_ = t + 14 days;
        assertEq(party.lastPriceExecutedAt(), now_);
        assertEq(party.askLiveAt(), now_);
        assertEq(party.buyableAt(), now_ + 2 hours);
        vm.warp(now_ + 30 days + 1);
        vm.prank(v[0]);
        uint256 d = party.propose(fixedPrice(6 ether), false, 24, 0);
        assertTrue(party.proposal(d).deadlock);
    }

    function _st(Party party, uint256 card) internal view returns (string memory st) {
        (,, st) = party.cardView(card);
    }

    function test_cardView_statusEveryState() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        assertEq(_st(party, 1), "FILLING");
        (string memory name, uint256 credit,) = party.cardView(1);
        assertEq(name, "Local Party");
        assertEq(credit, party.creditOfCard(1));
        fill(party);
        assertEq(_st(party, 1), "FULL");
        uint256 snap = vm.snapshotState();
        vm.warp(uint256(party.deadline()) + 1);
        assertEq(_st(party, 1), "EXPIRED / REDEEMABLE");
        vm.revertToState(snap);
        assembleDeposit(party);
        assertEq(_st(party, 1), "STATEMENT MADE");
        vm.warp(party.buyableAt());
        address b = makeAddr("buyer");
        vm.deal(b, 3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        assertEq(_st(party, 1), "SOLD / CLAIMABLE");
    }
}
