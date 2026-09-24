// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Findings from the post-fix test round (884add5 + 89f4ff3 + 322e50d). Each test asserts the intended behavior and
/// FAILS against the current contracts. Run: forge test --match-contract Findings2Test
contract Findings2Test is UnitBase {
    /// F2-1. minAskWei is required only when the DEFAULT price is floor-relative. A Fixed-default party may set it to 0
    ///       and later vote a floor-relative LIST; a bad or compromised floor reading then sets the ask to 1 wei and
    ///       the Statement sells for 1 wei once the voted wait passes. The T-4 protection ("a compromised floor cannot
    ///       push a floor-relative ask below minAskWei") silently does not apply to these parties.
    ///       Patch-agnostic: passes if creation, the proposal, or the execution is refused, or if the ask stays above
    ///       1 wei.
    function test_FINDING2_floorRelativeListWithoutMinimumAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit); // Fixed 3 ETH default
        p.minAskWei = 0; // allowed today because the default is Fixed
        uint256[] memory ids = first(holders[0], 1);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(predicted, true);
        try factory.createParty(p, ids, new bytes32[][](0)) {}
        catch {
            vm.stopPrank();
            return; // fixed by requiring minAskWei > 0 for every party
        }
        vm.stopPrank();
        Party party = Party(payable(predicted));
        fill(party);
        assembleDeposit(party);
        address[] memory v = spread(party, c2(41, 39)); // a bare majority, no floor-level supermajority needed

        vm.prank(v[0]);
        try party.propose(Party.PriceSpec(Party.PriceMode.FloorPct, 0), false, 24, 0) returns (uint256 id) {
            vm.warp(party.proposal(id).endsAt);
            Party.Floor memory bad1 = floorSig(1, 0); // compromised signer: floor = 1 wei
            vm.prank(v[0]);
            try party.execute(id, bad1) {
                assertGt(party.ask(), 1, "floor-relative ask resolved to 1 wei: no minimum applies");
            } catch {}
        } catch {}
    }
}
