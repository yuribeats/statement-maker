// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {CreditKeysRef} from "../ref/CreditKeysRef.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";

/// Exposes CreditKeys (a library of internal functions) through external calls so reverts can be observed.
/// Nothing is copied: every call goes to the real library code in src/CreditKeys.sol.
contract CreditKeysExposed {
    function printRank(string memory s) external pure returns (uint256) { return CreditKeys.printRank(s); }
    function weightRank(string memory s) external pure returns (uint256) { return CreditKeys.weightRank(s); }
    function key(CreditKeys.Preset p, ICredits c, ICreditArt a, uint256 id) external view returns (uint256) {
        return CreditKeysRef.key(p, c, a, id); // reference path (the table must reproduce it)
    }
}

/// Minimal Credits/CreditArt stand-ins whose trait values are set per id by the test (symbolic under halmos).
/// seedOf(id) = bytes21(uint168(id)), so describe(seed, …) looks traits up by id.
contract MockCredits {
    mapping(uint256 => uint64) public ts;
    function set(uint256 id, uint64 t) external { ts[id] = t; }
    function timestampOf(uint256 id) external view returns (uint64) { return ts[id]; }
    function seedOf(uint256 id) external pure returns (bytes21) { return bytes21(uint168(id)); }
}

contract MockArt {
    struct T { uint256 marks; uint256 eights; uint8 w; uint8 reg; }
    mapping(uint256 => T) public t;
    function set(uint256 id, uint256 marks, uint256 eights, uint8 w, uint8 reg) external { t[id] = T(marks, eights, w, reg); }

    function weightName(uint8 i) public pure returns (string memory) {
        if (i == 0) return "sparse";
        if (i == 1) return "lean";
        if (i == 2) return "even";
        return "extreme";
    }

    function regName(uint8 i) public pure returns (string memory) {
        if (i == 0) return "Registered";
        if (i == 1) return "Nudge";
        if (i == 2) return "Slip";
        if (i == 3) return "Skew";
        if (i == 4) return "Drift";
        return "Loose";
    }

    function describe(bytes21 seed, uint64) external view returns (ICreditArt.Read memory r) {
        T memory x = t[uint168(seed)];
        r.marks = x.marks;
        r.eights = x.eights;
        r.weight = weightName(x.w);
        r.register = regName(x.reg);
    }
}

contract CreditKeysHalmos is Test {
    CreditKeysExposed internal ex;
    MockCredits internal mc;
    MockArt internal ma;

    // COLOR_ORDER from the comment at src/CreditKeys.sol:84 (independent of the if-chain in colorRank)
    function colorOrderIndex(uint256 mask) internal pure returns (uint256) {
        uint8[15] memory order = [1, 2, 4, 8, 3, 5, 6, 9, 10, 12, 7, 11, 13, 14, 15];
        for (uint256 i; i < 15; ++i) if (order[i] == mask) return i;
        revert("not a mask");
    }

    function setUp() public {
        ex = new CreditKeysExposed();
        mc = new MockCredits();
        ma = new MockArt();
    }

    // ---------------------------------------------------------------- 4a. shuffle is a permutation

    /// COPY of CreditKeys.shuffle (src/CreditKeys.sol:173-180), verbatim except ONE inserted line marked [H]:
    /// halmos cannot index memory with a symbolic offset, so j is split into its i possible concrete values.
    /// On every path jc == j, so the swap is identical. testFuzz_shuffleCopyMatchesLibrary keeps the copy in sync.
    function shuffleCopy(uint256[] memory ids, uint256 seed) internal pure returns (uint256[] memory out) {
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = ids[i];
        for (uint256 i = out.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encodePacked(seed, i - 1))) % i;
            j = _concrete(j, i); // [H]
            (out[i - 1], out[j]) = (out[j], out[i - 1]);
        }
    }

    function _concrete(uint256 j, uint256 i) internal pure returns (uint256) {
        for (uint256 c; c < i; ++c) if (j == c) return c;
        assert(false); // unreachable: j = x % i < i
        return 0;
    }

    function testFuzz_shuffleCopyMatchesLibrary(uint256 seed, uint8 n) public pure {
        uint256[] memory ids = new uint256[](uint256(n) % 81);
        for (uint256 i; i < ids.length; ++i) ids[i] = uint256(keccak256(abi.encode(seed, i)));
        uint256[] memory a = CreditKeys.shuffle(ids, seed);
        uint256[] memory b = shuffleCopy(ids, seed);
        assertEq(a, b);
    }

    function _checkShuffle(uint256 n, uint256 seed) internal pure {
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = 1000 + 7 * i; // distinct concrete values
        uint256[] memory out = shuffleCopy(ids, seed);
        assert(out.length == n);
        for (uint256 i; i < n; ++i) {
            uint256 c;
            for (uint256 k; k < n; ++k) if (out[k] == ids[i]) ++c;
            assert(c == 1); // every input appears exactly once; n distinct values in n slots = permutation
        }
    }

    function check_shuffle_perm_3(uint256 seed) public pure { _checkShuffle(3, seed); }
    function check_shuffle_perm_4(uint256 seed) public pure { _checkShuffle(4, seed); }
    function check_shuffle_perm_5(uint256 seed) public pure { _checkShuffle(5, seed); }
    function check_shuffle_perm_6(uint256 seed) public pure { _checkShuffle(6, seed); }
    function check_shuffle_perm_7(uint256 seed) public pure { _checkShuffle(7, seed); }
    function check_shuffle_perm_8(uint256 seed) public pure { _checkShuffle(8, seed); }

    // ---------------------------------------------------------------- 4b. key packing: unique, lexicographic

    /// Packing used by every preset in CreditKeys.key: (primary << ID_BITS) | id.
    function check_key_packing(uint256 p1, uint256 id1, uint256 p2, uint256 id2) public pure {
        vm.assume(id1 < 2 ** 32 && id2 < 2 ** 32);
        uint256 k1 = (p1 << CreditKeys.ID_BITS) | id1;
        uint256 k2 = (p2 << CreditKeys.ID_BITS) | id2;
        // distinct ids never collide, for ANY primary (the low 32 bits are the id)
        if (id1 != id2) assert(k1 != k2);
        // ordering equals (primary, id) ordering when primaries fit in 224 bits
        if (p1 < 2 ** 224 && p2 < 2 ** 224) {
            bool lex = p1 < p2 || (p1 == p2 && id1 < id2);
            assert((k1 < k2) == lex);
            assert((k1 == k2) == (p1 == p2 && id1 == id2));
        }
    }

    /// Weight preset inner packing (src/CreditKeys.sol:76): (weightRank << 16) | marks is lexicographic in
    /// (weightRank, marks) iff marks < 2^16. CreditArt counts set bits of a 32-byte hash, so marks <= 256.
    function check_weight_inner_packing(uint256 w1, uint256 m1, uint256 w2, uint256 m2) public pure {
        vm.assume(w1 < 4 && w2 < 4 && m1 < 2 ** 16 && m2 < 2 ** 16);
        uint256 a = (w1 << 16) | m1;
        uint256 b = (w2 << 16) | m2;
        assert((a < b) == (w1 < w2 || (w1 == w2 && m1 < m2)));
    }

    /// Full key() through the real library, for two distinct ids with symbolic traits:
    /// key(a) < key(b)  ⇔  (intended primary(a), a) < (intended primary(b), b), per the Preset comments.
    function _setTraits(uint256 id, uint64 ts, uint256 marks, uint256 eights, uint8 w, uint8 reg) internal {
        vm.assume(marks <= 256 && eights <= 5 && w < 4 && reg < 6);
        mc.set(id, ts);
        ma.set(id, marks, eights, w, reg);
    }

    function _primary(CreditKeys.Preset p, uint256 id) internal view returns (uint256) {
        uint64 ts = mc.ts(id);
        (uint256 marks, uint256 eights, uint8 w, uint8 reg) = ma.t(id);
        if (p == CreditKeys.Preset.Time) return ts; // ascending
        if (p == CreditKeys.Preset.Colors) return colorOrderIndex(uint256(ts) % 15 + 1);
        if (p == CreditKeys.Preset.Ink) return marks; // ascending
        if (p == CreditKeys.Preset.Eights) return 5 - eights; // most eights first
        if (p == CreditKeys.Preset.Print) return 5 - reg; // most misregistered first
        if (p == CreditKeys.Preset.Weight) return w * 1000 + marks; // weight order, then ink ascending
        revert("preset");
    }

    function _checkKeyOrder(CreditKeys.Preset p, uint256 a, uint256 b) internal view {
        uint256 ka = ex.key(p, ICredits(address(mc)), ICreditArt(address(ma)), a);
        uint256 kb = ex.key(p, ICredits(address(mc)), ICreditArt(address(ma)), b);
        uint256 pa = _primary(p, a);
        uint256 pb = _primary(p, b);
        assert(ka != kb);
        assert((ka < kb) == (pa < pb || (pa == pb && a < b)));
    }

    function _keySetup(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory ta4, uint256[4] memory tb4) internal {
        vm.assume(a < 2 ** 32 && b < 2 ** 32 && a != b);
        _setTraits(a, ta, ta4[0], ta4[1], uint8(ta4[2]), uint8(ta4[3]));
        _setTraits(b, tb, tb4[0], tb4[1], uint8(tb4[2]), uint8(tb4[3]));
    }

    function check_key_Time(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Time, a, b);
    }
    function check_key_Colors(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Colors, a, b);
    }
    function check_key_Ink(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Ink, a, b);
    }
    function check_key_Eights(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Eights, a, b);
    }
    function check_key_Print(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Print, a, b);
    }
    function check_key_Weight(uint256 a, uint256 b, uint64 ta, uint64 tb, uint256[4] memory x, uint256[4] memory y) public {
        _keySetup(a, b, ta, tb, x, y); _checkKeyOrder(CreditKeys.Preset.Weight, a, b);
    }

    /// Rarity: traitKey() returns (class << 32) | id, class = the low 16 bits of the table entry (src/CreditKeys.sol
    /// traitKey). For ANY two entries: keys differ for distinct ids, and key order == (class, id) order, so the
    /// burn order is rarest class first with ties by ascending id. The upper 24 trait bits never leak into the key.
    function check_rarity_traitKey(uint256 a, uint256 b, uint40 pa, uint40 pb) public pure {
        vm.assume(a < 2 ** 32 && b < 2 ** 32 && a != b);
        uint256 ka = CreditKeys.traitKey(CreditKeys.Preset.Rarity, a, pa);
        uint256 kb = CreditKeys.traitKey(CreditKeys.Preset.Rarity, b, pb);
        uint256 ca = uint256(pa) & 0xFFFF;
        uint256 cb = uint256(pb) & 0xFFFF;
        assert(ka == (ca << 32) | a);
        assert(ka != kb);
        assert((ka < kb) == (ca < cb || (ca == cb && a < b)));
    }

    // ---------------------------------------------------------------- 5. rank tables

    function check_colorRank_bijection(uint256 m1, uint256 m2) public pure {
        vm.assume(m1 >= 1 && m1 <= 15 && m2 >= 1 && m2 <= 15);
        uint256 r1 = CreditKeys.colorRank(m1);
        uint256 r2 = CreditKeys.colorRank(m2);
        assert(r1 <= 14);
        assert((r1 == r2) == (m1 == m2)); // injective on 15 masks into 15 ranks ⇒ bijection onto {0..14}
        assert(r1 == colorOrderIndex(m1)); // matches the documented COLOR_ORDER
    }

    function _eq(bytes memory a, string memory b) internal pure returns (bool) {
        return keccak256(a) == keccak256(bytes(b));
    }

    /// printRank returns r only for the exact string PRINT_ORDER[r]; every other string reverts.
    function check_printRank_rejects_unknown(bytes memory s) public view {
        try ex.printRank(string(s)) returns (uint256 r) {
            assert(r <= 5);
            assert(_eq(s, ma.regName(uint8(r))));
        } catch {
            assert(!_eq(s, "Registered") && !_eq(s, "Nudge") && !_eq(s, "Slip") && !_eq(s, "Skew")
                && !_eq(s, "Drift") && !_eq(s, "Loose"));
        }
    }

    function check_weightRank_rejects_unknown(bytes memory s) public view {
        try ex.weightRank(string(s)) returns (uint256 r) {
            assert(r <= 3);
            assert(_eq(s, ma.weightName(uint8(r))));
        } catch {
            assert(!_eq(s, "sparse") && !_eq(s, "lean") && !_eq(s, "even") && !_eq(s, "extreme"));
        }
    }
}
