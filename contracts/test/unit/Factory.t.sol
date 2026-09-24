// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";
import {CreditCards} from "../../src/CreditCards.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FactoryTest is UnitBase {
    ICredits C;
    IStatement S;
    address signer;

    function setUp() public override {
        super.setUp();
        C = ICredits(address(credits));
        S = IStatement(address(statement));
        signer = vm.addr(signerKey);
    }

    // ------------------------------------------------------------------ constructor

    function test_ctor_zeroCredits() public {
        vm.expectRevert(bytes("zero"));
        new PartyFactory(ICredits(address(0)), S, feeTo, signer, collectionOwner);
    }

    function test_ctor_zeroStatement() public {
        vm.expectRevert(bytes("zero"));
        new PartyFactory(C, IStatement(address(0)), feeTo, signer, collectionOwner);
    }

    function test_ctor_zeroFee() public {
        vm.expectRevert(bytes("zero"));
        new PartyFactory(C, S, address(0), signer, collectionOwner);
    }

    function test_ctor_zeroSigner() public {
        vm.expectRevert(bytes("zero"));
        new PartyFactory(C, S, feeTo, address(0), collectionOwner);
    }

    function test_ctor_zeroCollectionOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PartyFactory(C, S, feeTo, signer, address(0));
    }

    function test_ctor_wiring() public view {
        assertEq(address(factory.credits()), address(credits));
        assertEq(address(factory.statement()), address(statement));
        assertEq(factory.feeRecipient(), feeTo);
        assertEq(factory.floorSigner(), signer);
        assertEq(cards.factory(), address(factory));
        assertEq(factory.FEE_BPS(), 100);
        assertEq(cards.owner(), collectionOwner);
    }

    // ------------------------------------------------------------------ createParty

    /// holders[0] hosts; opening deposit = its first max(minDeposit, 1) Credits (capped at what it owns).
    function _create(Party.Params memory p) internal returns (Party) {
        uint256 n = p.minDeposit == 0 ? 1 : p.minDeposit;
        uint256 own = ownedBy(holders[0]).length;
        return openParty(p, holders[0], first(holders[0], n > own ? own : n));
    }

    function test_create_ok_registersAndRecords() public {
        address host = holders[0];
        address predicted = factory.predictParty(host);
        vm.prank(host);
        credits.setApprovalForAll(address(factory), true);
        uint256[] memory ids = first(host, 1); // before the prank: first() makes an external call
        Party.Params memory ps = params(CreditKeys.Preset.Deposit);
        vm.expectEmit(address(cards));
        emit CreditCards.PartyRegistered(predicted);
        vm.expectEmit(address(factory));
        emit PartyFactory.PartyCreated(predicted, host, 0);
        vm.prank(host);
        Party p = factory.createParty(ps, ids, new bytes32[][](0));
        vm.prank(host);
        credits.setApprovalForAll(address(factory), false);
        assertEq(address(p), predicted, "deterministic clone at the predicted address");
        assertEq(p.host(), host);
        assertEq(factory.nonces(host), 1);
        assertTrue(factory.predictParty(host) != predicted, "next prediction moves on");
        assertEq(p.count(), 1, "opening deposit made in the same tx");
        assertEq(cards.ownerOf(1), host);
        assertFalse(credits.isApprovedForAll(host, address(p)), "harness revoked");
        assertTrue(cards.isParty(address(p)));
        assertEq(factory.partiesCount(), 1);
        assertEq(factory.parties(0), address(p));
        assertEq(p.deadline(), block.timestamp + 14 days);
        assertEq(p.createdAt(), block.timestamp);
        assertEq(uint256(p.status()), uint256(Party.Status.OPEN));
        assertEq(address(p.factory()), address(factory));
    }

    function _expectCreateBad(Party.Params memory p, string memory why) internal {
        uint256 n = p.minDeposit == 0 ? 1 : p.minDeposit;
        uint256 own = ownedBy(holders[0]).length;
        uint256[] memory ids = first(holders[0], n > own ? own : n);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectRevert(bad(why));
        factory.createParty(p, ids, new bytes32[][](0));
        credits.setApprovalForAll(address(factory), false);
        vm.stopPrank();
    }

    function test_create_minDeposit_bounds() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minDeposit = 0;
        _expectCreateBad(p, "minDeposit");
        p.minDeposit = 81;
        _expectCreateBad(p, "minDeposit");
        p.minDeposit = 1;
        _create(p);
        // minDeposit 80: the host opens with all 80, so the party is FULL at creation
        uint256[] memory more = first(holders[1], 21);
        vm.startPrank(holders[1]);
        for (uint256 i; i < 20; ++i) credits.transferFrom(holders[1], holders[0], more[i]);
        vm.stopPrank();
        p.minDeposit = 80;
        _expectCreateBad(p, "count"); // owns 79 < 80
        vm.prank(holders[1]);
        credits.transferFrom(holders[1], holders[0], more[20]);
        Party full = openParty(p, holders[0], first(holders[0], 80));
        assertEq(uint256(full.status()), uint256(Party.Status.FULL));
        assertEq(full.fullAt(), block.timestamp);
    }

    function test_create_duration_bounds() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 0;
        _expectCreateBad(p, "duration");
        p.durationDays = 61;
        _expectCreateBad(p, "duration");
        p.durationDays = 60;
        Party party = _create(p);
        assertEq(party.deadline(), block.timestamp + 60 days);
        p.durationDays = 1;
        _create(p);
    }

    function test_create_voteHours() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        uint16[8] memory badH = [uint16(0), 1, 23, 25, 47, 96, 167, 169];
        for (uint256 i; i < badH.length; ++i) {
            p.voteHours = badH[i];
            _expectCreateBad(p, "voteHours");
        }
        uint16[4] memory ok = [uint16(24), 48, 72, 168];
        for (uint256 i; i < ok.length; ++i) {
            p.voteHours = ok[i];
            _create(p);
        }
    }

    function test_create_defaultPrice_fixed() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 0);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, -1);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 1e24 + 1);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 1e24);
        _create(p);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 1);
        _create(p);
    }

    function test_create_defaultPrice_floorPct() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, -10_000);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 1_000_001);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, -9_999);
        _create(p);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 1_000_000);
        _create(p);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 0);
        _create(p);
    }

    function test_create_defaultPrice_floorDelta() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, -1e24 - 1);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, 1e24 + 1);
        _expectCreateBad(p, "price");
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, -1e24);
        _create(p);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, 1e24);
        _create(p);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, 0);
        _create(p);
    }

    function test_create_name() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.name = "";
        _expectCreateBad(p, "name");
        p.name = string(new bytes(61));
        _expectCreateBad(p, "name");
        p.name = string(new bytes(60));
        _create(p);
        p.name = "x";
        _create(p);
    }

    function test_create_description() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.description = string(new bytes(1001));
        _expectCreateBad(p, "description");
        p.description = string(new bytes(1000));
        _create(p);
    }

    function test_create_paramsStored() public {
        Party.Params memory p = params(CreditKeys.Preset.Rarity);
        p.description = "desc";
        p.filters = "Colors=CMYK";
        uint256[] memory ids = first(holders[0], 5);
        bytes32[] memory leaves = new bytes32[](5);
        for (uint256 i; i < 5; ++i) leaves[i] = leafOf(ids[i]);
        p.eligibleRoot = merkleRoot(leaves);
        p.minDeposit = 5;
        p.seed = 99;
        p.floorMode = Party.FloorMode.Latest;
        p.minAskWei = 0.5 ether;
        bytes32[][] memory proofs = new bytes32[][](5);
        for (uint256 i; i < 5; ++i) proofs[i] = merkleProof(leaves, i);
        Party party = openPartyWith(factory, p, holders[0], ids, proofs);
        Party.Params memory q = party.params();
        assertEq(q.name, p.name);
        assertEq(q.description, "desc");
        assertEq(q.filters, "Colors=CMYK");
        assertEq(q.eligibleRoot, p.eligibleRoot);
        assertEq(q.minDeposit, 5);
        assertEq(q.seed, 99);
        assertEq(uint8(q.arrangement), uint8(CreditKeys.Preset.Rarity));
        assertEq(uint8(q.floorMode), uint8(Party.FloorMode.Latest));
        assertEq(q.minAskWei, 0.5 ether);
        assertEq(party.count(), 5);
    }

    // ------------------------------------------------------------------ initializer

    function test_clone_cannotReinitialize() public {
        Party party = _create(params(CreditKeys.Preset.Deposit));
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        party.initialize(address(this), p);
        vm.prank(address(factory));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        party.initialize(address(this), p);
    }

    function test_implementation_cannotInitialize() public {
        Party impl = factory.implementation();
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), p);
        vm.prank(address(factory));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), p);
    }

    function test_implementation_notRegisteredParty() public view {
        assertFalse(cards.isParty(address(factory.implementation())));
    }

    function test_transferHost() public {
        Party party = _create(params(CreditKeys.Preset.Deposit));
        address nh = makeAddr("newHost");
        vm.prank(nh);
        vm.expectRevert(bad("host"));
        party.transferHost(nh);
        vm.prank(holders[0]);
        vm.expectRevert(bad("host"));
        party.transferHost(address(0));
        vm.expectEmit(address(party));
        emit Party.HostTransferred(holders[0], nh);
        vm.prank(holders[0]);
        party.transferHost(nh);
        assertEq(party.host(), nh);
    }
}
