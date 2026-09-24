// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixesBase} from "./Fixes.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface ITransfer721 {
    function transferFrom(address from, address to, uint256 id) external;
}

/// Statement stand-in that mints a Statement but keeps (or forwards) the 80 Credits instead of burning them.
contract KeepingStatement is ERC721 {
    ITransfer721 immutable credits;
    address immutable sink; // 0 = keep them here
    uint256 next = 1;

    constructor(address c, address sink_) ERC721("K", "K") {
        credits = ITransfer721(c);
        sink = sink_;
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        address to = sink == address(0) ? address(this) : sink;
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, to, ids[i]);
        id = next++;
        _mint(msg.sender, id);
    }
}

/// Regression tests for the third external audit: floor freshness and the floor-relative buy wait (finding 2),
/// post-burn verification (finding 3), the royalty gas stipend (b). The market (finding 4) is in test/market.
contract Findings3Test is FixesBase {
    // ================================================================== 2: floor cherry-picking

    function _fixedAssembled() internal returns (Party party, address[] memory v) {
        (party, v) = _assembled(params(CreditKeys.Preset.Deposit), noFloor(), c2(42, 38)); // fixed 3 ETH default
    }

    /// A reading 11 minutes old is refused (it was accepted for up to an hour).
    function test_floor_olderThanTenMinutes_rejected() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        Party party = newParty(p);
        fill(party);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory stale = floorAt(1 ether, 0, uint64(block.timestamp - 10 minutes - 1), signerKey, factory);
        Party.Floor memory edge = floorAt(1 ether, 0, uint64(block.timestamp - 10 minutes), signerKey, factory);
        vm.prank(holders[0]);
        vm.expectRevert(bad("stale floor"));
        party.assemble(dep, stale);
        vm.prank(holders[0]);
        party.assemble(dep, edge);
        assertEq(party.ask(), 1 ether);
    }

    /// The audit scenario: the floor spikes from 1 to 3 ETH. A 2 ETH fixed LIST with 42 YES is below the floor and
    /// needs 60; the executor can no longer clear it at 41 with a 30-minute-old 1 ETH reading.
    function test_floor_staleLowReading_cannotLowerThreshold() public {
        (Party party, address[] memory v) = _fixedAssembled();
        uint256 id = _prop(party, v[0], fixedPrice(2 ether), 0);
        vm.warp(party.proposal(id).endsAt);
        Party.Floor memory low = floorAt(1 ether, 0, uint64(block.timestamp - 30 minutes), signerKey, factory);
        _exFail(party, v[0], id, low, bad("stale floor"));
        _exFail(party, v[0], id, floorSig(3 ether, 0), bad("did not pass")); // current reading: below floor, 42 < 60
        assertEq(party.needFor(id, 2 ether, 3 ether), 60);
        assertEq(party.ask(), 3 ether);
    }

    /// A floor-relative price needs a buy wait of at least 1 hour (default at creation, and every proposal).
    function test_floorRelative_zeroBuyWait_rejected_init() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        p.buyDelayHours = 0;
        uint256[] memory ids = first(holders[0], 1);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(predicted, true);
        vm.expectRevert(bad("buyDelay"));
        factory.createParty(p, ids, new bytes32[][](0));
        p.defaultPrice = _delta(0);
        vm.expectRevert(bad("buyDelay"));
        factory.createParty(p, ids, new bytes32[][](0));
        vm.stopPrank();
        p.buyDelayHours = 1;
        assertEq(newParty(p).params().buyDelayHours, 1);
        p.defaultPrice = fixedPrice(3 ether); // a fixed price may still go live with no wait
        p.buyDelayHours = 0;
        assertEq(newParty(p).params().buyDelayHours, 0);
    }

    function test_floorRelative_zeroBuyWait_rejected_propose() public {
        (Party party, address[] memory v) = _fixedAssembled();
        vm.startPrank(v[0]);
        vm.expectRevert(bad("buyDelay"));
        party.propose(_pct(0), false, 24, 0);
        vm.expectRevert(bad("buyDelay"));
        party.propose(_delta(1 ether), false, 24, 0);
        uint256 a = party.propose(_pct(0), false, 24, 1);
        uint256 b = party.propose(fixedPrice(4 ether), false, 24, 0);
        vm.stopPrank();
        assertEq(party.proposal(a).buyDelayHours, 1);
        assertEq(party.proposal(b).buyDelayHours, 0);
    }

    /// The audit scenario: an assembler uses a stale-low (but still valid) reading for a floor-relative default. No
    /// one can buy before the wait ends, and in the wait anyone can raise the ask with a fresher reading.
    function test_floorRelative_staleLowAsk_raisedBeforeBuyOpens() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        p.buyDelayHours = 1;
        Party party = newParty(p);
        fill(party);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory staleLow = floorAt(1 ether, 0, uint64(block.timestamp - 9 minutes), signerKey, factory);
        vm.prank(holders[0]);
        party.assemble(dep, staleLow);
        assertEq(party.ask(), 1 ether);
        address bot = _buyer(10 ether);
        vm.prank(bot);
        vm.expectRevert(bad("not open yet"));
        party.buy{value: 1 ether}(1 ether);
        vm.warp(block.timestamp + 5 minutes);
        party.raiseAsk(floorSig(3 ether, 0)); // anyone (a keeper, a card holder) with the current reading
        vm.warp(party.buyableAt());
        vm.prank(bot);
        vm.expectRevert(bad("price"));
        party.buy{value: 1 ether}(1 ether);
        vm.prank(bot);
        party.buy{value: 3 ether}(3 ether);
        assertTrue(party.sold());
    }

    // ================================================================== 3: post-burn verification

    function _keeperParty(address sink) internal returns (Party party, KeepingStatement st) {
        st = new KeepingStatement(address(credits), sink);
        PartyFactory f2 = new PartyFactory(ICredits(address(credits)), IStatement(address(st)), feeTo, vm.addr(signerKey), collectionOwner);
        party = openPartyWith(f2, params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
    }

    /// A Statement contract that keeps the Credits (or moves them elsewhere) instead of burning them is refused:
    /// every Credit must no longer exist. Before, only "the party no longer owns it" was checked.
    function test_assemble_statementKeepsCredits_rejected() public {
        address[2] memory sinks = [address(0), makeAddr("elsewhere")];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            (Party party,) = _keeperParty(sinks[i]);
            uint256[] memory dep = party.depositOrder();
            vm.prank(holders[0]);
            vm.expectRevert(bad("not burned"));
            party.assemble(dep, noFloor());
            assertFalse(party.assembled());
            vm.revertToState(snap);
        }
    }

    // ================================================================== b: royalty gas stipend

    /// A royaltyInfo that needs ~100k gas (e.g. it delegates to a registry) is paid; one needing ~330k still counts
    /// as no royalty and the sale goes through.
    function test_royalty_delegatingImplementationPaid() public {
        address artist = makeAddr("artist");
        uint256 snap = vm.snapshotState();
        Party party = _buyWeird3(6, artist, 0.1 ether);
        assertEq(party.owed(artist), 0.1 ether);
        vm.revertToState(snap);
        party = _buyWeird3(7, artist, 0.1 ether);
        assertEq(party.owed(artist), 0);
        assertEq(party.perCard(), (3 ether - 3 ether / 100) / 80);
    }

    function _buyWeird3(uint8 mode, address r, uint256 a) internal returns (Party party) {
        WeirdStatement3 st = new WeirdStatement3(address(credits), mode, r, a);
        PartyFactory f2 = new PartyFactory(ICredits(address(credits)), IStatement(address(st)), feeTo, vm.addr(signerKey), collectionOwner);
        party = openPartyWith(f2, params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        vm.warp(party.buyableAt());
        address b = _buyer(3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
    }
}

interface ICreditsBurn3 {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
}

/// Burns properly; royaltyInfo spends ~100k (mode 6) or ~330k (mode 7) gas on cold reads before answering.
contract WeirdStatement3 is ERC721 {
    ICreditsBurn3 immutable credits;
    uint8 immutable mode;
    address immutable recv;
    uint256 immutable amt;
    uint256 next = 1;

    constructor(address c, uint8 m, address r, uint256 a) ERC721("W3", "W3") {
        credits = ICreditsBurn3(c);
        mode = m;
        recv = r;
        amt = a;
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        credits.burn(msg.sender, ids);
        id = next++;
        _mint(msg.sender, id);
    }

    function royaltyInfo(uint256, uint256) external view returns (address, uint256) {
        uint256 n = mode == 6 ? 45 : 150; // ~2.2k gas per cold SLOAD
        uint256 base = uint256(mode) << 32; // distinct slots per mode: a snapshot revert does not re-cool warm slots
        uint256 x;
        for (uint256 i; i < n; ++i) {
            assembly { x := add(x, sload(add(i, base))) } // used below, so the optimizer keeps the reads
        }
        if (x == type(uint256).max) revert();
        return (recv, amt);
    }
}
