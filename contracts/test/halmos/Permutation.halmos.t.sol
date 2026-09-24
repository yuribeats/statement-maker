// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits} from "../../src/interfaces/IExternal.sol";

/// Party.assemble passes its stored deposit order (80 ids) to CreditKeys.verifyOrder (src/CreditKeys.sol:33-63).
/// Its permutation part (:34-45) runs for every preset; with Preset.Manual it returns right after it (:46), so
/// calling the REAL linked library with Manual tests exactly the permutation logic. No copy.
contract VerifyOrderExposed {
    function check(uint256[] memory deposited, uint256[] calldata order) external view returns (bool) {
        CreditKeys.verifyOrder(CreditKeys.Preset.Manual, ICredits(address(0)), deposited, order, 0);
        return true;
    }
}

contract PermutationHalmos is Test {
    VerifyOrderExposed internal ex;

    function setUp() public {
        ex = new VerifyOrderExposed();
    }

    /// `stored` = the party's deposit order: n distinct ids (Party.deposit rejects duplicates via cardOfCredit).
    function _run(uint256 n, uint256[] memory stored, uint256[] memory order) internal view {
        vm.assume(stored.length == n);
        for (uint256 i; i < n; ++i) for (uint256 k = i + 1; k < n; ++k) vm.assume(stored[i] != stored[k]);

        // Independent definition: `order` is a permutation of `stored` iff same length and every stored id
        // appears exactly once (n distinct ids in n slots).
        bool perm = order.length == n;
        if (perm) {
            for (uint256 i; i < n; ++i) {
                uint256 c;
                for (uint256 k; k < n; ++k) if (order[k] == stored[i]) ++c;
                if (c != 1) perm = false;
            }
        }

        bool ok;
        try ex.check(stored, order) returns (bool r) { ok = r; } catch { ok = false; }
        assert(ok == perm);
    }

    function check_perm_N3(uint256[] memory stored, uint256[] memory order) public view { _run(3, stored, order); }
    function check_perm_N4(uint256[] memory stored, uint256[] memory order) public view { _run(4, stored, order); }
    function check_perm_N5(uint256[] memory stored, uint256[] memory order) public view { _run(5, stored, order); }
    function check_perm_N6(uint256[] memory stored, uint256[] memory order) public view { _run(6, stored, order); }
}
