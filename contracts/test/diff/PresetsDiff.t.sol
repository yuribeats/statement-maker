// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";
import {CreditKeysRef} from "../ref/CreditKeysRef.sol";
import {CreditTraits} from "../../src/CreditTraits.sol";
import {TraitsTable} from "../../script/TraitsTable.sol";

/// @notice Batch access to the reference key path (CreditKeysRef, describe()-based) for the differential tests.
contract DiffProbe {
    function keys(CreditKeys.Preset p, ICredits c, uint256[] calldata ids) external view returns (uint256[] memory out) {
        ICreditArt art = ICreditArt(c.art());
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeysRef.key(p, c, art, ids[i]);
    }

    function shuffle(uint256[] memory ids, uint256 seed) external pure returns (uint256[] memory) {
        return CreditKeys.shuffle(ids, seed);
    }

    function colorRank(uint256 mask) external pure returns (uint256) { return CreditKeys.colorRank(mask); }
    function printRank(string memory r) external pure returns (uint256) { return CreditKeys.printRank(r); }
    function weightRank(string memory w) external pure returns (uint256) { return CreditKeys.weightRank(w); }
    function score(uint256 mask, string memory reg, string memory w, uint256 e) external pure returns (uint256) {
        return CreditKeys.colorWeight(mask) + CreditKeys.printWeight(reg) + CreditKeys.weightWeight(w) + CreditKeys.eightsWeight(e);
    }
}

abstract contract ForkDiff is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    uint256 constant FORK_BLOCK = 26044000; // as contracts/test/Base.t.sol
    DiffProbe probe;
    CreditTraits traits; // the committed mainnet key table: what Party verifies

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), FORK_BLOCK);
        probe = new DiffProbe();
        traits = TraitsTable.deploy(vm.readFileBinary("data/keytable/table.bin"));
    }
}

/// @notice Site (server.mjs PRESETS, via scripts/diff/gen-presets.mjs) vs contract (CreditKeys) on real Credits.
///         Each site order must be strictly increasing BOTH in the committed table's keys (CreditTraits, what Party
///         verifies) and in the reference describe()-based keys (CreditKeysRef): site order == table order == old
///         on-chain order. Random must equal CreditKeys.shuffle(deposit order, seed).
contract PresetsDiffTest is ForkDiff {
    string json;
    uint256 n;
    uint256[] deposit;
    mapping(uint256 id => uint256) keyOf;
    bool useTable;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("data/diff/presets.json");
        n = vm.parseJsonUint(json, ".n");
        deposit = vm.parseJsonUintArray(json, ".deposit");
    }

    function _label(uint256 s) internal view returns (string memory) {
        return vm.parseJsonString(json, string.concat(".labels[", vm.toString(s), "]"));
    }

    function _check(CreditKeys.Preset p, string memory name) internal {
        uint256 bad = _violations(p, name, true);
        emit log_named_uint(string.concat(name, " sets checked"), n);
        emit log_named_uint(string.concat(name, " adjacent-pair violations (reference keys)"), bad);
        assertEq(bad, 0, string.concat(name, ": site order differs from the reference (describe) order"));
        useTable = true;
        bad = _violations(p, name, true);
        useTable = false;
        emit log_named_uint(string.concat(name, " adjacent-pair violations (table keys)"), bad);
        assertEq(bad, 0, string.concat(name, ": site order would revert in assemble() (table keys)"));
    }

    /// Negative control: the harness must detect violations when orders and keys disagree.
    function test_negativeControl_InkOrdersUnderRarityKeys() public {
        uint256 bad = _violations(CreditKeys.Preset.Rarity, "Ink", false);
        emit log_named_uint("control violations (expected > 0)", bad);
        assertGt(bad, n); // essentially every set
    }

    function _violations(CreditKeys.Preset p, string memory name, bool log) internal returns (uint256 bad) {
        uint256[] memory pool = vm.parseJsonUintArray(json, ".pool");
        uint256[] memory k = useTable ? traits.keys(uint8(p), pool) : probe.keys(p, CREDITS, pool);
        for (uint256 i; i < pool.length; ++i) keyOf[pool[i]] = k[i];
        uint256[] memory orders = vm.parseJsonUintArray(json, string.concat(".", name));
        assertEq(orders.length, n * 80, "fixture length");
        for (uint256 s; s < n; ++s) {
            for (uint256 i = 1; i < 80; ++i) {
                uint256 a = orders[s * 80 + i - 1];
                uint256 b = orders[s * 80 + i];
                if (keyOf[b] <= keyOf[a]) {
                    ++bad;
                    if (log && bad <= 10) {
                        emit log_named_string("MISMATCH", string.concat(name, " set ", _label(s), " pos ", vm.toString(i)));
                        emit log_named_uint("  id a", a);
                        emit log_named_uint("  key a", keyOf[a]);
                        emit log_named_uint("  id b", b);
                        emit log_named_uint("  key b", keyOf[b]);
                    }
                }
            }
        }
    }

    function test_Number() public { _check(CreditKeys.Preset.Number, "Number"); }
    function test_Time() public { _check(CreditKeys.Preset.Time, "Time"); }
    function test_Rarity() public { _check(CreditKeys.Preset.Rarity, "Rarity"); }
    function test_Colors() public { _check(CreditKeys.Preset.Colors, "Colors"); }
    function test_Print() public { _check(CreditKeys.Preset.Print, "Print"); }
    function test_Weight() public { _check(CreditKeys.Preset.Weight, "Weight"); }
    function test_Eights() public { _check(CreditKeys.Preset.Eights, "Eights"); }
    function test_Ink() public { _check(CreditKeys.Preset.Ink, "Ink"); }

    function test_Random() public {
        uint256[] memory orders = vm.parseJsonUintArray(json, ".Random");
        uint256[] memory seeds = vm.parseJsonUintArray(json, ".seeds");
        uint256 bad;
        for (uint256 s; s < n; ++s) {
            uint256[] memory dep = new uint256[](80);
            for (uint256 i; i < 80; ++i) dep[i] = deposit[s * 80 + i];
            uint256[] memory want = probe.shuffle(dep, seeds[s]);
            for (uint256 i; i < 80; ++i) {
                if (want[i] != orders[s * 80 + i]) {
                    ++bad;
                    if (bad <= 5) emit log_named_string("MISMATCH Random", string.concat(_label(s), " pos ", vm.toString(i)));
                    break;
                }
            }
        }
        emit log_named_uint("Random sets checked", n);
        emit log_named_uint("Random sets differing", bad);
        assertEq(bad, 0, "Random: site order differs from CreditKeys.shuffle");
    }
}
