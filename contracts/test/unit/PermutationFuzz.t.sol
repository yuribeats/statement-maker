// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICreditTraits} from "../../src/interfaces/IExternal.sol";

/// Party-shaped storage; calls the REAL linked CreditKeys.verifyOrder (Manual: the pure permutation check).
contract PermProbe {
    uint256[] internal dep;
    mapping(uint256 => uint256) internal cardOf;

    constructor(uint256[] memory ids) {
        for (uint256 i; i < ids.length; ++i) { dep.push(ids[i]); cardOf[ids[i]] = i + 1; }
    }

    function check(CreditKeys.Preset p, uint256[] calldata order) external returns (bool) {
        CreditKeys.verifyOrder(p, ICreditTraits(address(0)), dep, cardOf, order, 0);
        return true;
    }
}

/// verifyOrder's permutation logic (Manual path; also the membership part of Number/Time) against an independent
/// definition: `order` is accepted iff it has the same length as the deposits and every deposit appears exactly once.
/// Values are drawn from a tiny domain so repeats, strays and length changes are frequent.
contract PermutationFuzzTest is Test {
    function _perm(uint256[] memory stored, uint256[] memory order) internal pure returns (bool) {
        if (order.length != stored.length) return false;
        for (uint256 i; i < stored.length; ++i) {
            uint256 c;
            for (uint256 k; k < order.length; ++k) if (order[k] == stored[i]) ++c;
            if (c != 1) return false;
        }
        return true;
    }

    function testFuzz_manualAcceptsExactlyPermutations(uint256 seed, uint8 nIn, uint8 mIn) public {
        uint256 n = 1 + nIn % 8;
        uint256[] memory stored = new uint256[](n);
        for (uint256 i; i < n; ++i) stored[i] = 1 + i * 3; // distinct deposits
        PermProbe p = new PermProbe(stored);
        uint256 m = mIn % 4 == 0 ? n + mIn % 3 - 1 : n; // mostly equal length, sometimes n-1..n+1
        if (m == 0) m = 1;
        uint256[] memory order = new uint256[](m);
        // mostly shuffled deposits, with occasional repeats and strays
        for (uint256 i; i < m; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            order[i] = r % 5 == 0 ? r % (3 * n + 2) : stored[(r >> 8) % n];
        }
        if (seed % 3 == 0 && m == n) { // an exact shuffle
            for (uint256 i; i < n; ++i) order[i] = stored[i];
            for (uint256 i = n; i > 1; --i) {
                uint256 j = uint256(keccak256(abi.encode(seed, "s", i))) % i;
                (order[i - 1], order[j]) = (order[j], order[i - 1]);
            }
        }
        bool ok;
        try p.check(CreditKeys.Preset.Manual, order) returns (bool r) { ok = r; } catch { ok = false; }
        assertEq(ok, _perm(stored, order));
    }
}
