// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";
import {CreditKeysRef} from "../ref/CreditKeysRef.sol";

/// Serves seedOf/timestampOf from data/keytable/work/input.bin (etched as code at DATA), and the REAL art contract.
contract StubCredits {
    address constant DATA = address(0xDA7A);
    address public immutable art;

    constructor(address art_) {
        art = art_;
    }

    function _rec(uint256 id) internal view returns (bytes32 w) {
        uint256 off = (id - 1) * 29;
        address d = DATA;
        assembly {
            let m := mload(0x40)
            mstore(m, 0)
            extcodecopy(d, m, off, 29)
            w := mload(m)
        }
    }

    function seedOf(uint256 id) external view returns (bytes21) {
        return bytes21(_rec(id));
    }

    function timestampOf(uint256 id) external view returns (uint64) {
        return uint64(uint256(_rec(id)) >> 24 & type(uint64).max);
    }
}

/// GENERATOR + derivation (a). Opt-in: KEYTABLE_BUILD=1 FROM=<first id> TO=<last id>, on a mainnet fork (for the art
/// contract's code only; seeds and payment times come from input.bin). For each id it writes
///   work/table-<FROM>.bin : the packed 3-byte CreditTraits entry (from describe(), CreditKeysRef.packed)
///   work/keys-a-<FROM>.bin: the reference keys (CreditKeysRef.key) for Number, Time, Rarity, Colors, Print, Weight,
///                           Eights, Ink, 32 bytes each, per id
/// scripts/keytable/build.sh shards this, concatenates the parts into data/keytable/table.bin, and runs the checks.
contract BuildKeyTableTest is Test {
    address constant ART = 0xFbE816B82547B483C7DFfC5b14C75eC84f8c1985; // Credits.art() on mainnet

    function test_build() public {
        if (!vm.envOr("KEYTABLE_BUILD", false)) return;
        uint256 from = vm.envUint("FROM");
        uint256 to = vm.envUint("TO");
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), 26044000);
        vm.etch(address(0xDA7A), vm.readFileBinary("data/keytable/work/input.bin"));
        StubCredits c = new StubCredits(ART);
        ICredits ic = ICredits(address(c));
        ICreditArt art = ICreditArt(ART);
        bytes memory table = new bytes((to - from + 1) * 3);
        bytes memory keys = new bytes((to - from + 1) * 8 * 32);
        uint8[8] memory ps = [uint8(1), 2, 3, 4, 5, 6, 7, 8];
        for (uint256 id = from; id <= to; ++id) {
            uint256 k = id - from;
            uint256 v = CreditKeysRef.packed(ic, art, id);
            table[3 * k] = bytes1(uint8(v >> 16));
            table[3 * k + 1] = bytes1(uint8(v >> 8));
            table[3 * k + 2] = bytes1(uint8(v));
            for (uint256 j; j < 8; ++j) {
                uint256 key = CreditKeysRef.key(CreditKeys.Preset(ps[j]), ic, art, id);
                uint256 o = (k * 8 + j) * 32;
                assembly { mstore(add(add(keys, 32), o), key) }
            }
        }
        string memory tag = vm.toString(from);
        vm.writeFileBinary(string.concat("data/keytable/work/table-", tag, ".bin"), table);
        vm.writeFileBinary(string.concat("data/keytable/work/keys-a-", tag, ".bin"), keys);
    }
}
