// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {CreditTraits} from "../../src/CreditTraits.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";
import {TraitsTable} from "../../script/TraitsTable.sol";
import {CreditKeysRef, RefProbe} from "../ref/CreditKeysRef.sol";

/// The committed key table (data/keytable/table.bin) and the Time rule, checked against mainnet and the reference
/// (describe()-based) key path. The full 122,154-id cross-checks run in scripts/keytable/verify.sh.
contract KeyTableTest is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    uint256 constant N = 122154;
    bytes table;
    bytes paidAt;
    CreditTraits traits;

    function setUp() public {
        table = vm.readFileBinary("data/keytable/table.bin");
        paidAt = vm.readFileBinary("data/keytable/paidat.bin");
        traits = TraitsTable.deploy(table);
    }

    function _paid(uint256 id) internal view returns (uint256 t) {
        uint256 o = (id - 1) * 4;
        t = uint256(uint8(paidAt[o])) << 24 | uint256(uint8(paidAt[o + 1])) << 16 | uint256(uint8(paidAt[o + 2])) << 8 | uint8(paidAt[o + 3]);
    }

    /// The committed files are the ones the deploy script pins, and cover exactly ids 1..122,154.
    function test_committedTable_shape() public view {
        assertEq(table.length, N * 3);
        assertEq(paidAt.length, N * 4);
        assertEq(traits.count(), N);
        assertEq(traits.chunkCount(), 15);
        assertEq(keccak256(table), vm.parseBytes32(vm.trim(vm.readFile("data/keytable/table.keccak"))));
    }

    /// Time order == ascending id: payment times never decrease with id, over the whole sealed collection (bundled
    /// data; the fork test below checks those payment times against the chain).
    function test_timeProperty_paidAtNonDecreasingInId_all() public view {
        uint256 prev;
        for (uint256 id = 1; id <= N; ++id) {
            uint256 t = _paid(id);
            assertGe(t, prev, "paidAt decreased");
            prev = t;
        }
    }

    function _check(RefProbe ref, uint256[] memory ids) internal view {
        for (uint8 p = 1; p <= 8; ++p) {
            uint256[] memory got = traits.keys(p, ids);
            uint256[] memory want = ref.keys(CreditKeys.Preset(p), CREDITS, ids);
            for (uint256 i; i < ids.length; ++i) {
                if (p == uint8(CreditKeys.Preset.Time)) {
                    assertEq(got[i], ids[i], "Time key is the id");
                    assertEq(want[i], (_paid(ids[i]) << 32) | ids[i], "reference Time key == committed paidAt");
                } else {
                    assertEq(got[i], want[i], string.concat("preset ", vm.toString(p), " id ", vm.toString(ids[i])));
                }
            }
        }
    }

    /// Mainnet fork: 2,000 pseudo-random ids (two tests of 1,000, to stay under the default test gas limit) and all
    /// 320 house-party ids (the four exact-80 mint minutes), every preset: stored key == live reference key (the art
    /// contract's describe() on the chain), and the committed payment times == the chain's.
    function _fork() internal returns (RefProbe ref) {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), 26044000);
        traits = TraitsTable.deploy(table);
        ref = new RefProbe();
    }

    function _sample(uint256 from, uint256 to) internal {
        RefProbe ref = _fork();
        uint256[] memory ids = new uint256[](100);
        for (uint256 b = from; b < to; ++b) {
            for (uint256 i; i < 100; ++i) ids[i] = uint256(keccak256(abi.encode("sample", b, i))) % N + 1;
            _check(ref, ids);
        }
    }

    function test_fork_sample_first1000() public { _sample(0, 10); }
    function test_fork_sample_second1000() public { _sample(10, 20); }

    function test_fork_allHousePartyIds() public {
        RefProbe ref = _fork();
        uint256[4] memory starts = [uint256(21098), 25998, 27664, 32714]; // #21098-21177, #25998-26077, #27664-27743, #32714-32793
        uint256[] memory house = new uint256[](80);
        for (uint256 h; h < 4; ++h) {
            for (uint256 i; i < 80; ++i) house[i] = starts[h] + i;
            _check(ref, house);
        }
    }

    /// FULL cross-check, opt-in (KEYTABLE_VERIFY=1; run by scripts/keytable/verify.sh after build.sh): the table's keys
    /// for all 122,154 ids x 8 presets == derivation (a) (work/keys-a.bin, which verify.sh also compares with the live
    /// mainnet derivation (b)). Time: the table key is the id, and the reference Time keys strictly increase with id.
    function test_full_tableEqualsReferenceKeys() public {
        if (!vm.envOr("KEYTABLE_VERIFY", false)) return;
        address a = address(0xA11A); // keys-a.bin served as code, read by slices (31 MB would not fit in memory)
        vm.etch(a, vm.readFileBinary("data/keytable/work/keys-a.bin"));
        assertEq(a.code.length, N * 8 * 32);
        uint256 step = 2000;
        uint256 prevTime;
        uint256 fmp;
        assembly { fmp := mload(0x40) }
        for (uint256 from = 1; from <= N; from += step) {
            assembly { mstore(0x40, fmp) } // reuse memory per chunk (the test EVM has a memory cap)
            uint256 to = from + step - 1 > N ? N : from + step - 1;
            uint256[] memory ids = new uint256[](to - from + 1);
            for (uint256 i; i < ids.length; ++i) ids[i] = from + i;
            uint256 fmp2;
            assembly { fmp2 := mload(0x40) }
            for (uint8 p = 1; p <= 8; ++p) {
                assembly { mstore(0x40, fmp2) }
                uint256[] memory got = traits.keys(p, ids);
                for (uint256 i; i < ids.length; ++i) {
                    uint256 o = ((from - 1 + i) * 8 + (p - 1)) * 32;
                    uint256 want;
                    assembly {
                        extcodecopy(a, 0, o, 32)
                        want := mload(0)
                    }
                    if (p == uint8(CreditKeys.Preset.Time)) {
                        assertEq(got[i], ids[i]);
                        assertGt(want, prevTime, "reference Time keys must strictly increase with id");
                        prevTime = want;
                    } else if (got[i] != want) {
                        revert(string.concat("mismatch preset ", vm.toString(p), " id ", vm.toString(ids[i])));
                    }
                }
            }
        }
    }
}
