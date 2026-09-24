// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";

/// Independent oracle for CreditKeys. The other unit tests build "expected" preset orders with CreditKeys itself (via
/// UnitKeyProbe), so a wrong key would agree with itself; mutation testing showed those tests cannot catch it. Here
/// every expected key is derived from the spec instead:
///  - traits by NAME from art.describe() (the source of truth for every trait),
///  - order tables as in the site (lib/core.mjs COLOR_ORDER / PRINT_ORDER / WEIGHT_ORDER),
///  - rarity weights copied from data/rarity.json (weights by trait name, not by the contract's mask/rank tables),
///  - the key layout documented in CreditKeys: (primary << 32) | id, ascending.
contract KeysSpecTest is UnitBase {
    string[15] COLOR_ORDER = ["C", "M", "Y", "K", "CM", "CY", "MY", "CK", "MK", "YK", "CMY", "CMK", "CYK", "MYK", "CMYK"];
    string[6] PRINT_ORDER = ["Registered", "Nudge", "Slip", "Skew", "Drift", "Loose"];
    string[4] WEIGHT_ORDER = ["sparse", "lean", "even", "extreme"];

    function _idx(string[15] storage list, string memory s) internal view returns (uint256) {
        for (uint256 i; i < list.length; ++i) if (keccak256(bytes(list[i])) == keccak256(bytes(s))) return i;
        revert("colors not in COLOR_ORDER");
    }

    function _idx6(string memory s) internal view returns (uint256) {
        for (uint256 i; i < 6; ++i) if (keccak256(bytes(PRINT_ORDER[i])) == keccak256(bytes(s))) return i;
        revert("register not in PRINT_ORDER");
    }

    function _idx4(string memory s) internal view returns (uint256) {
        for (uint256 i; i < 4; ++i) if (keccak256(bytes(WEIGHT_ORDER[i])) == keccak256(bytes(s))) return i;
        revert("weight not in WEIGHT_ORDER");
    }

    // data/rarity.json, by trait name
    function _wColors(string memory c) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(c));
        if (h == keccak256("C")) return 3908947081;
        if (h == keccak256("M")) return 3913745110;
        if (h == keccak256("Y")) return 3908060305;
        if (h == keccak256("K")) return 3939426425;
        if (h == keccak256("CM")) return 3903634585;
        if (h == keccak256("CY")) return 3919631122;
        if (h == keccak256("MY")) return 3887463858;
        if (h == keccak256("CK")) return 3889562832;
        if (h == keccak256("MK")) return 3910011931;
        if (h == keccak256("YK")) return 3926259272;
        if (h == keccak256("CMY")) return 3915169818;
        if (h == keccak256("CMK")) return 3901515053;
        if (h == keccak256("CYK")) return 3895350809;
        if (h == keccak256("MYK")) return 3877188084;
        if (h == keccak256("CMYK")) return 3908592305;
        revert("colors");
    }

    function _wPrint(string memory r) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(r));
        if (h == keccak256("Registered")) return 195465472;
        if (h == keccak256("Nudge")) return 4661729380;
        if (h == keccak256("Slip")) return 4640364522;
        if (h == keccak256("Skew")) return 5366472805;
        if (h == keccak256("Drift")) return 6072587748;
        if (h == keccak256("Loose")) return 6964650926;
        revert("register");
    }

    function _wWeight(string memory w) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(w));
        if (h == keccak256("sparse")) return 2887813475;
        if (h == keccak256("lean")) return 1831411512;
        if (h == keccak256("even")) return 801626426;
        if (h == keccak256("extreme")) return 6615253228;
        revert("weight");
    }

    function _wEights(uint256 e) internal pure returns (uint256) {
        uint256[6] memory w = [uint256(448838239), 2125356957, 4849173708, 8261716960, 12197901863, 16898341581];
        return w[e];
    }

    uint256[15] colorsSeen;
    uint256[6] printSeen;
    uint256[4] weightSeen;
    uint256[6] eightsSeen;

    function _check(uint256 id) internal {
        ICredits c = ICredits(address(credits));
        ICreditArt art = ICreditArt(c.art());
        uint64 paidAt = c.timestampOf(id);
        ICreditArt.Read memory r = art.describe(c.seedOf(id), paidAt);
        uint256 ci = _idx(COLOR_ORDER, r.colors);
        uint256 pi = _idx6(r.register);
        uint256 wi = _idx4(r.weight);
        ++colorsSeen[ci];
        ++printSeen[pi];
        ++weightSeen[wi];
        ++eightsSeen[r.eights];

        assertEq(probe.key(CreditKeys.Preset.Number, c, id), id, "Number");
        assertEq(probe.key(CreditKeys.Preset.Time, c, id), (uint256(paidAt) << 32) | id, "Time");
        assertEq(probe.key(CreditKeys.Preset.Colors, c, id), (ci << 32) | id, "Colors");
        assertEq(probe.key(CreditKeys.Preset.Ink, c, id), (r.marks << 32) | id, "Ink");
        assertEq(probe.key(CreditKeys.Preset.Eights, c, id), ((uint256(type(uint32).max) - r.eights) << 32) | id, "Eights");
        assertEq(probe.key(CreditKeys.Preset.Print, c, id), ((5 - pi) << 32) | id, "Print: most misregistered first");
        assertEq(probe.key(CreditKeys.Preset.Weight, c, id), (((wi << 16) | r.marks) << 32) | id, "Weight");
        uint256 score = _wColors(r.colors) + _wPrint(r.register) + _wWeight(r.weight) + _wEights(r.eights);
        assertEq(probe.key(CreditKeys.Preset.Rarity, c, id), ((uint256(type(uint64).max) - score) << 32) | id, "Rarity");
    }

    function _range(uint256 h, uint256 from, uint256 n) internal {
        uint256[] memory ids = slice(holders[h], from, n);
        for (uint256 i; i < n; ++i) _check(ids[i]);
    }

    function test_keys_h0() public { _range(0, 0, 30); _range(0, 30, 30); }
    function test_keys_h1() public { _range(1, 0, 60); }
    function test_keys_h2() public { _range(2, 0, 60); }
    function test_keys_h3() public { _range(3, 0, 60); }

    /// Logs which trait values the 240 checked Credits cover (rare classes may be absent from the synthetic set).
    function test_keys_coverage() public {
        for (uint256 h; h < 4; ++h) _range(h, 0, 60);
        for (uint256 i; i < 15; ++i) emit log_named_uint(string.concat("colors ", COLOR_ORDER[i]), colorsSeen[i]);
        for (uint256 i; i < 6; ++i) emit log_named_uint(string.concat("print ", PRINT_ORDER[i]), printSeen[i]);
        for (uint256 i; i < 4; ++i) emit log_named_uint(string.concat("weight ", WEIGHT_ORDER[i]), weightSeen[i]);
        for (uint256 i; i < 6; ++i) emit log_named_uint(string.concat("eights ", vm.toString(i)), eightsSeen[i]);
        for (uint256 i; i < 15; ++i) assertGt(colorsSeen[i], 0, "every colour combination covered");
    }

    function test_key_rejectsWideIdsAndNonKeyPresets() public {
        ICredits c = ICredits(address(credits));
        vm.expectRevert(bytes("id"));
        probe.key(CreditKeys.Preset.Number, c, 2 ** 32);
        uint256 id = first(holders[0], 1)[0];
        CreditKeys.Preset[3] memory none = [CreditKeys.Preset.Deposit, CreditKeys.Preset.Random, CreditKeys.Preset.Manual];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(bytes("preset"));
            probe.key(none[i], c, id);
        }
    }

    /// Fisher–Yates as the site implements it (lib/core.mjs PRESETS.Random), written out independently.
    function _spec(uint256[] memory ids, uint256 seed) internal pure returns (uint256[] memory o) {
        o = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) o[i] = ids[i];
        for (uint256 i = o.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encodePacked(seed, i - 1))) % i;
            (o[i - 1], o[j]) = (o[j], o[i - 1]);
        }
    }

    function test_shuffle_matchesSpec() public view {
        uint256[] memory ids = new uint256[](80);
        for (uint256 i; i < 80; ++i) ids[i] = 1000 + i;
        uint256[4] memory seeds = [uint256(0), 1, 7, 999_999];
        for (uint256 s; s < 4; ++s) {
            uint256[] memory got = probe.shuffle(ids, seeds[s]);
            uint256[] memory want = _spec(ids, seeds[s]);
            for (uint256 i; i < 80; ++i) assertEq(got[i], want[i]);
        }
        assertEq(probe.shuffle(new uint256[](0), 5).length, 0);
        uint256[] memory one_ = new uint256[](1);
        one_[0] = 42;
        assertEq(probe.shuffle(one_, 5)[0], 42);
        assertEq(ids[0], 1000, "input not modified");
    }
}
