// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

contract AssembleTest is UnitBase {
    address arranger; // hosts scrambledParty parties and holds 40 of their cards

    function setUp() public override {
        super.setUp();
        arranger = holders[3];
    }

    function _expected(Party party, CreditKeys.Preset p) internal view returns (uint256[] memory) {
        uint256[] memory dep = party.depositOrder();
        if (p == CreditKeys.Preset.Deposit) return dep;
        if (p == CreditKeys.Preset.Random) return probe.shuffle(dep, party.params().seed);
        return sortBy(p, dep);
    }

    function _presetCase(CreditKeys.Preset p) internal {
        Party party = scrambledParty(params(p));
        uint256[] memory want = _expected(party, p);

        // not a no-op: the preset order differs from deposit order (except Deposit itself)
        if (p != CreditKeys.Preset.Deposit) {
            uint256[] memory dep = party.depositOrder();
            bool differs;
            for (uint256 i; i < 80; ++i) if (dep[i] != want[i]) differs = true;
            assertTrue(differs, "preset equals deposit order");
            vm.prank(arranger);
            vm.expectRevert(bad("order"));
            party.assemble(dep, noFloor());
        }

        // one-swap perturbations anywhere are rejected
        uint256[3][3] memory swaps = [[uint256(0), 1, 0], [uint256(39), 40, 0], [uint256(78), 79, 0]];
        for (uint256 s; s < 3; ++s) {
            uint256[] memory bad_ = swapped(want, swaps[s][0], swaps[s][1]);
            vm.prank(arranger);
            vm.expectRevert(bad("order"));
            party.assemble(bad_, noFloor());
        }
        uint256[] memory far = swapped(want, 3, 70);
        vm.prank(arranger);
        vm.expectRevert(bad("order"));
        party.assemble(far, noFloor());

        vm.prank(arranger);
        party.assemble(want, noFloor());
        assertTrue(party.assembled());
        uint256[] memory burned = party.burnOrder();
        for (uint256 i; i < 80; ++i) assertEq(burned[i], want[i]);
        // Statement received the seeds in exactly this order
        bytes21[] memory seeds = statement.seedsOf(party.statementId());
        for (uint256 i; i < 80; ++i) assertEq(seeds[i], credits.seedOf(want[i]));
    }

    function test_preset_Deposit() public { _presetCase(CreditKeys.Preset.Deposit); }
    function test_preset_Number() public { _presetCase(CreditKeys.Preset.Number); }
    function test_preset_Time() public { _presetCase(CreditKeys.Preset.Time); }
    function test_preset_Rarity() public { _presetCase(CreditKeys.Preset.Rarity); }
    function test_preset_Colors() public { _presetCase(CreditKeys.Preset.Colors); }
    function test_preset_Print() public { _presetCase(CreditKeys.Preset.Print); }
    function test_preset_Weight() public { _presetCase(CreditKeys.Preset.Weight); }
    function test_preset_Eights() public { _presetCase(CreditKeys.Preset.Eights); }
    function test_preset_Ink() public { _presetCase(CreditKeys.Preset.Ink); }
    function test_preset_Random() public { _presetCase(CreditKeys.Preset.Random); }

    function test_preset_Random_seedMatters() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Random));
        uint256[] memory other = probe.shuffle(party.depositOrder(), 8); // party seed is 7
        vm.prank(arranger);
        vm.expectRevert(bad("order"));
        party.assemble(other, noFloor());
    }

    function test_preset_Number_reverseRejected() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Number));
        uint256[] memory w = _expected(party, CreditKeys.Preset.Number);
        uint256[] memory r = new uint256[](80);
        for (uint256 i; i < 80; ++i) r[i] = w[79 - i];
        vm.prank(arranger);
        vm.expectRevert(bad("order"));
        party.assemble(r, noFloor());
    }

    // ------------------------------------------------------------------ Manual

    function test_manual_hostOnly_anyPermutation() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual)); // host = arranger (holders[3])
        uint256[] memory dep = party.depositOrder();
        uint256[] memory mine = swapped(dep, 0, 79);
        vm.prank(holders[2]); // card holder, not host
        vm.expectRevert(bad("host only"));
        party.assemble(mine, noFloor());
        // the host needs no card: it gives all 40 away first
        uint256[] memory hc = cardsOf(party, arranger);
        for (uint256 i; i < hc.length; ++i) { vm.prank(arranger); cards.transferFrom(arranger, holders[2], hc[i]); }
        assertEq(cards.heldNow(address(party), arranger), 0);
        vm.prank(arranger);
        party.assemble(mine, noFloor());
        assertEq(party.burnOrder()[0], dep[79]);
    }

    function test_manual_transferredHostAssembles() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual));
        address nh = makeAddr("newHost");
        vm.prank(arranger);
        party.transferHost(nh);
        uint256[] memory dep = party.depositOrder();
        vm.prank(arranger);
        vm.expectRevert(bad("host only"));
        party.assemble(dep, noFloor());
        vm.prank(nh);
        party.assemble(dep, noFloor());
        assertTrue(party.assembled());
    }

    function test_manual_stillChecksPermutation() public {
        Party party = scrambledParty(params(CreditKeys.Preset.Manual));
        uint256[] memory dep = party.depositOrder();
        uint256[] memory rep = new uint256[](80);
        for (uint256 i; i < 80; ++i) rep[i] = dep[i];
        rep[5] = dep[6];
        vm.prank(arranger);
        vm.expectRevert(bad("repeat"));
        party.assemble(rep, noFloor());
    }

    // ------------------------------------------------------------------ shape checks

    function _full(CreditKeys.Preset p) internal returns (Party party) {
        party = scrambledParty(params(p));
    }

    function test_wrongLength() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        uint256[] memory s = new uint256[](79);
        for (uint256 i; i < 79; ++i) s[i] = dep[i];
        vm.prank(arranger);
        vm.expectRevert(bad("length"));
        party.assemble(s, noFloor());
        uint256[] memory l = new uint256[](81);
        for (uint256 i; i < 80; ++i) l[i] = dep[i];
        l[80] = dep[0];
        vm.prank(arranger);
        vm.expectRevert(bad("length"));
        party.assemble(l, noFloor());
        vm.prank(arranger);
        vm.expectRevert(bad("length"));
        party.assemble(new uint256[](0), noFloor());
    }

    function test_repeats() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        dep[79] = dep[0];
        vm.prank(arranger);
        vm.expectRevert(bad("repeat"));
        party.assemble(dep, noFloor());
    }

    function test_notDeposited() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        dep[40] = first(holders[0], 1)[0];
        vm.prank(arranger);
        vm.expectRevert(bad("not deposited"));
        party.assemble(dep, noFloor());
        dep[40] = 0;
        vm.prank(arranger);
        vm.expectRevert(bad("not deposited"));
        party.assemble(dep, noFloor());
    }

    function test_nonCardHolder_autoPreset() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        // the host (arranger) gives away every card: hosting alone does not let it assemble an auto preset
        uint256[] memory hc = cardsOf(party, arranger);
        for (uint256 i; i < hc.length; ++i) { vm.prank(arranger); cards.transferFrom(arranger, holders[2], hc[i]); }
        vm.prank(arranger);
        vm.expectRevert(bad("card holders only"));
        party.assemble(dep, noFloor());
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bad("card holders only"));
        party.assemble(dep, noFloor());
    }

    function test_cardBuyer_canAssemble() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        address b = makeAddr("b");
        vm.prank(arranger);
        cards.transferFrom(arranger, b, 1);
        uint256[] memory dep = party.depositOrder();
        vm.prank(b);
        party.assemble(dep, noFloor());
        assertTrue(party.assembled());
    }

    function test_notFull() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        deposit(party, holders[0], first(holders[0], 58)); // 1 opening + 58 = 59
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        vm.expectRevert(bad("not full"));
        party.assemble(dep, noFloor());
    }

    function test_afterDeadline() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        vm.warp(party.deadline()); // exactly at deadline still FULL
        uint256 snap = vm.snapshotState();
        vm.prank(arranger);
        party.assemble(dep, noFloor());
        vm.revertToState(snap);
        vm.warp(uint256(party.deadline()) + 1);
        vm.prank(arranger);
        vm.expectRevert(bad("not full"));
        party.assemble(dep, noFloor());
    }

    function test_twice() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        vm.prank(arranger);
        party.assemble(dep, noFloor());
        vm.prank(arranger);
        vm.expectRevert(bad("not full"));
        party.assemble(dep, noFloor());
    }

    function test_effects() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        vm.prank(arranger);
        party.assemble(dep, noFloor());
        assertEq(uint256(party.status()), uint256(Party.Status.ASSEMBLED));
        assertEq(statement.ownerOf(party.statementId()), address(party));
        assertEq(party.ask(), 3 ether);
        assertEq(party.askLiveAt(), block.timestamp);
        assertEq(party.priceEpoch(), 1);
        assertFalse(credits.isApprovedForAll(address(party), address(statement)), "approval revoked");
        for (uint256 i; i < 80; ++i) {
            vm.expectRevert();
            credits.ownerOf(dep[i]);
        }
        // ASSEMBLED never expires
        vm.warp(uint256(party.deadline()) + 365 days);
        assertEq(uint256(party.status()), uint256(Party.Status.ASSEMBLED));
    }

    // ------------------------------------------------------------------ safe-mint callback

    function test_onERC721Received_directCallRejected() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        vm.expectRevert(bad("unexpected token"));
        party.onERC721Received(address(this), address(this), 1, "");
        vm.prank(address(statement)); // even from the Statement contract, outside assemble()
        vm.expectRevert(bad("unexpected token"));
        party.onERC721Received(address(statement), address(0), 1, "");
    }

    function test_onERC721Received_safeTransferRejected() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        vm.prank(arranger);
        vm.expectRevert(bad("unexpected token"));
        cards.safeTransferFrom(arranger, address(party), 1);
    }

    // ------------------------------------------------------------------ floor-relative default

    function _pctParty() internal returns (Party party) {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 1_000); // floor +10%
        party = scrambledParty(p);
    }

    function test_floorDefault_requiresSig() public {
        Party party = _pctParty();
        uint256[] memory dep = party.depositOrder();
        vm.prank(arranger);
        vm.expectRevert(bad("stale floor"));
        party.assemble(dep, noFloor());
        Party.Floor memory f = floorSig(2 ether, 0);
        vm.prank(arranger);
        party.assemble(dep, f);
        assertEq(party.ask(), 2.2 ether);
        (Party.PriceMode m, int256 v) = party.askSpec();
        assertEq(uint8(m), uint8(Party.PriceMode.FloorPct));
        assertEq(v, 1_000);
    }

    function test_floorDelta_nonPositiveRejected() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, -1 ether);
        Party party = scrambledParty(p);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory f = floorSig(1 ether, 0);
        vm.prank(arranger);
        vm.expectRevert(bad("price <= 0"));
        party.assemble(dep, f);
        f = floorSig(1 ether + 1, 0);
        vm.prank(arranger);
        party.assemble(dep, f);
        assertEq(party.ask(), 1);
    }

    function test_fixedDefault_ignoresFloorArg() public {
        Party party = _full(CreditKeys.Preset.Deposit);
        uint256[] memory dep = party.depositOrder();
        Party.Floor memory junk = Party.Floor(1, 1, hex"deadbeef");
        vm.prank(arranger);
        party.assemble(dep, junk);
        assertEq(party.ask(), 3 ether);
    }
}
