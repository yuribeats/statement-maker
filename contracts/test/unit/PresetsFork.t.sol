// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Every auto preset on 80 REAL mainnet Credits (real seeds and payment times): the exact order is accepted and
/// adjacent-swap perturbations are rejected. Needs ETH_RPC_URL.
contract PresetsForkTest is Base {
    function setUp() public override {
        if (!vm.envExists("ETH_RPC_URL")) {
            vm.skip(true);
            return;
        }
        super.setUp();
    }

    function _bad(string memory why) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Party.Bad.selector, why);
    }

    function _case(CreditKeys.Preset p) internal {
        uint256[] memory mine = holdings(WHALE);
        // deposit a reversed slice so deposit order differs from id/time order
        uint256[] memory ids = new uint256[](80);
        for (uint256 i; i < 80; ++i) ids[i] = mine[79 - i];
        Party party = openParty(params(p), WHALE, ids);
        uint256[] memory dep = party.depositOrder();
        uint256[] memory want;
        if (p == CreditKeys.Preset.Deposit) want = dep;
        else if (p == CreditKeys.Preset.Random) want = probe.shuffle(dep, 42);
        else want = sortBy(p, _copy(dep));

        for (uint256 s; s < 79; s += 13) {
            uint256[] memory w = _copy(want);
            (w[s], w[s + 1]) = (w[s + 1], w[s]);
            vm.prank(WHALE);
            vm.expectRevert(_bad("order"));
            party.assemble(w, noFloor());
        }
        vm.prank(WHALE);
        party.assemble(want, noFloor());
        uint256[] memory burned = party.burnOrder();
        for (uint256 i; i < 80; ++i) assertEq(burned[i], want[i]);
    }

    function _copy(uint256[] memory a) internal pure returns (uint256[] memory b) {
        b = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) b[i] = a[i];
    }

    function test_fork_Deposit() public { _case(CreditKeys.Preset.Deposit); }
    function test_fork_Number() public { _case(CreditKeys.Preset.Number); }
    function test_fork_Time() public { _case(CreditKeys.Preset.Time); }
    function test_fork_Rarity() public { _case(CreditKeys.Preset.Rarity); }
    function test_fork_Colors() public { _case(CreditKeys.Preset.Colors); }
    function test_fork_Print() public { _case(CreditKeys.Preset.Print); }
    function test_fork_Weight() public { _case(CreditKeys.Preset.Weight); }
    function test_fork_Eights() public { _case(CreditKeys.Preset.Eights); }
    function test_fork_Ink() public { _case(CreditKeys.Preset.Ink); }
    function test_fork_Random() public { _case(CreditKeys.Preset.Random); }
}
