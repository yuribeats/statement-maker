// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// @notice End to end: the site's order for each preset, passed to a real Party.assemble() on the mainnet fork.
contract PresetsE2EDiffTest is Base {
    string json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("data/diff/e2e.json");
    }

    function _run(CreditKeys.Preset p, string memory name) internal {
        uint256[] memory dep = vm.parseJsonUintArray(json, ".deposit");
        for (uint256 i; i < dep.length; ++i) assertEq(CREDITS.ownerOf(dep[i]), WHALE, "fixture: whale no longer holds");
        Party party = openParty(params(p), WHALE, dep); // seed 42, as the fixture; host opens with all 80
        uint256[] memory order = vm.parseJsonUintArray(json, string.concat(".", name));
        vm.prank(WHALE);
        party.assemble(order, noFloor());
        assertTrue(party.assembled(), name);
    }

    function test_e2e_Deposit() public { _run(CreditKeys.Preset.Deposit, "Deposit"); }
    function test_e2e_Number() public { _run(CreditKeys.Preset.Number, "Number"); }
    function test_e2e_Time() public { _run(CreditKeys.Preset.Time, "Time"); }
    function test_e2e_Rarity() public { _run(CreditKeys.Preset.Rarity, "Rarity"); }
    function test_e2e_Colors() public { _run(CreditKeys.Preset.Colors, "Colors"); }
    function test_e2e_Print() public { _run(CreditKeys.Preset.Print, "Print"); }
    function test_e2e_Weight() public { _run(CreditKeys.Preset.Weight, "Weight"); }
    function test_e2e_Eights() public { _run(CreditKeys.Preset.Eights, "Eights"); }
    function test_e2e_Ink() public { _run(CreditKeys.Preset.Ink, "Ink"); }
    function test_e2e_Random() public { _run(CreditKeys.Preset.Random, "Random"); }

    /// Negative control: a site order for one preset must be rejected under another.
    function test_e2e_negativeControl_wrongPresetReverts() public {
        uint256[] memory dep = vm.parseJsonUintArray(json, ".deposit");
        Party party = openParty(params(CreditKeys.Preset.Rarity), WHALE, dep);
        uint256[] memory order = vm.parseJsonUintArray(json, ".Ink");
        vm.prank(WHALE);
        vm.expectRevert(abi.encodeWithSelector(Party.Bad.selector, "order"));
        party.assemble(order, noFloor());
    }
}
