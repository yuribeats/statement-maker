// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Credits} from "./credits/Credits.sol";
import {ILocalCredits} from "./ILocalCredits.sol";
import {PartyFactory} from "../src/PartyFactory.sol";
import {Party} from "../src/Party.sol";
import {CreditCards} from "../src/CreditCards.sol";
import {CreditKeys} from "../src/CreditKeys.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ICredits, ICreditArt, IStatement} from "../src/interfaces/IExternal.sol";
import {CreditTraits} from "../src/CreditTraits.sol";
import {TraitsTable} from "../script/TraitsTable.sol";
import {RefProbe} from "./ref/CreditKeysRef.sol";

/// @notice Local harness: deploys Jack's verified Credits source (test/credits, MIT) and distributes synthetic
///         Credits, so fuzzing runs fast without an RPC. Same bytecode logic as mainnet; only seeds differ.
abstract contract LocalBase is Test {
    ILocalCredits credits;
    PartyFactory factory;
    MockStatement statement;
    CreditCards cards;
    CreditTraits traits; // this collection's sealed trait table, built from its own art (RefProbe.packed)
    RefProbe ref;
    uint256 signerKey = 0xA11CE;
    address feeTo = makeAddr("fee");
    address collectionOwner = makeAddr("collectionOwner"); // CreditCards.owner(): marketplace page only
    address[] holders;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        // audit/mutation/setup-shard.sh rewrites this line to vm.deployCode (and drops the import) in its throwaway
        // copies, so mutation runs can build the tests with legacy codegen; the art sources need via-IR.
        credits = ILocalCredits(address(new Credits(address(this))));
        _distribute(8, 60); // 8 holders × 60 Credits = 480
        credits.seal();
        statement = new MockStatement(address(credits));
        ref = new RefProbe();
        traits = buildTraits(ICredits(address(credits)), 480);
        factory = new PartyFactory(ICredits(address(credits)), IStatement(address(statement)), feeTo, vm.addr(signerKey), collectionOwner, traits);
        cards = factory.cards();
        _etchMutants(factory);
    }

    /// The packed trait table of ids 1..n of `c`, from its own art contract (with the stand-in rarity class: a test
    /// collection has no official rating), deployed as CreditTraits.
    function buildTraits(ICredits c, uint256 n) internal returns (CreditTraits) {
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = i + 1;
        uint256[] memory v = ref.packed(c, ids);
        bytes memory t = new bytes(n * 5);
        for (uint256 i; i < n; ++i) {
            for (uint256 b; b < 5; ++b) t[5 * i + b] = bytes1(uint8(v[i] >> (8 * (4 - b))));
        }
        return TraitsTable.deploy(t);
    }

    // ------------------------------------------------------------------ mutation-testing hook
    // contracts/audit/mutation/run.sh compiles one slither-mutate mutant of Party.sol or CreditKeys.sol with solc and
    // passes its runtime code in MUTANT_PARTY / MUTANT_KEYS (hex files under ./data). The hook swaps it in over the
    // Party implementation or the linked CreditKeys library, so a mutant costs one solc run instead of a full
    // recompile of every test. Inert when neither variable is set.

    address constant MUTANT_LIB_SENTINEL = 0xC0FfEE0000000000000000000000000000c0fFEe;

    function _etchMutants(PartyFactory f) internal {
        string memory pp = vm.envOr("MUTANT_PARTY", string(""));
        string memory kp = vm.envOr("MUTANT_KEYS", string(""));
        if (bytes(pp).length == 0 && bytes(kp).length == 0) return;
        address impl = address(f.implementation());
        bytes memory code = impl.code;
        uint256 off = vm.envUint("MUTANT_LIB_OFFSET"); // where the library address sits in the unmutated Party
        address lib;
        assembly {
            lib := shr(96, mload(add(add(code, 32), off)))
        }
        if (bytes(pp).length > 0) {
            bytes memory m = vm.parseBytes(vm.readFile(pp));
            _relink(m, lib); // the mutant was linked against a sentinel address
            vm.etch(impl, m);
        }
        if (bytes(kp).length > 0) {
            bytes memory k = vm.parseBytes(vm.readFile(kp));
            for (uint256 i; i < 20; ++i) k[1 + i] = bytes20(lib)[i]; // library call guard: PUSH20 <own address>
            vm.etch(lib, k);
        }
    }

    function _relink(bytes memory code, address lib) private pure {
        bytes20 s = bytes20(MUTANT_LIB_SENTINEL);
        bytes20 l = bytes20(lib);
        for (uint256 i; i + 21 <= code.length; ++i) {
            if (code[i] != 0x73) continue;
            bytes20 w;
            assembly {
                w := mload(add(add(code, 33), i))
            }
            if (w == s) for (uint256 j; j < 20; ++j) code[i + 1 + j] = l[j];
        }
    }

    function _distribute(uint256 nHolders, uint256 each) internal {
        uint256 n = nHolders * each;
        address[] memory to = new address[](n);
        bytes21[] memory seeds = new bytes21[](n);
        uint64[] memory ts = new uint64[](n);
        for (uint256 h; h < nHolders; ++h) holders.push(makeAddr(string.concat("holder", vm.toString(h))));
        for (uint256 i; i < n; ++i) {
            to[i] = holders[i / each];
            seeds[i] = _seed(i);
            ts[i] = uint64(1_789_900_000 + i * 7);
        }
        credits.distribute(to, seeds, ts);
    }

    /// 21 alphanumeric chars, unique per i.
    function _seed(uint256 i) internal pure returns (bytes21 s) {
        bytes memory alpha = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        bytes memory b = new bytes(21);
        uint256 x = uint256(keccak256(abi.encode(i)));
        for (uint256 k; k < 21; ++k) { b[k] = alpha[x % 62]; x /= 62; if (x == 0) x = uint256(keccak256(abi.encode(i, k))); }
        assembly { s := mload(add(b, 32)) }
    }

    function params(CreditKeys.Preset arr) internal pure returns (Party.Params memory p) {
        p.name = "Local Party";
        p.minDeposit = 1;
        p.durationDays = 14;
        p.voteHours = 48;
        p.arrangement = arr;
        p.seed = 7;
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 3 ether);
        p.floorMode = Party.FloorMode.Avg24h;
        p.minAskWei = 1; // required > 0 when the default price is floor-relative; 1 wei never binds in these tests
        p.buyDelayHours = 24; // pre-audit fixed wait; the site default is 1 hour
    }

    /// Opens a party the way the site does: `host` approves the predicted clone address on Credits, then
    /// createParty() deploys it and pulls the host's opening deposit in the same transaction.
    function openParty(Party.Params memory p, address host, uint256[] memory ids) internal returns (Party) {
        return openPartyWith(factory, p, host, ids, new bytes32[][](0));
    }

    function openPartyWith(PartyFactory f, Party.Params memory p, address host, uint256[] memory ids, bytes32[][] memory proofs)
        internal
        returns (Party party)
    {
        if (address(f) != address(factory)) _etchMutants(f);
        address predicted = f.predictParty(host);
        vm.startPrank(host);
        credits.setApprovalForAll(address(f), true); // the only approval: the factory, never a party
        party = f.createParty(p, ids, proofs);
        credits.setApprovalForAll(address(f), false);
        vm.stopPrank();
        require(address(party) == predicted, "harness: predicted address");
    }

    function ownedBy(address who) internal view returns (uint256[] memory) {
        return credits.tokensOf(who);
    }

    function deposit(Party party, address who, uint256[] memory ids) internal {
        vm.startPrank(who);
        PartyFactory f = PartyFactory(address(party.factory()));
        credits.setApprovalForAll(address(f), true);
        f.deposit(party, ids, new bytes32[][](0));
        credits.setApprovalForAll(address(f), false);
        vm.stopPrank();
    }

    function floorSig(uint256 floorWei, uint8 mode) internal view returns (Party.Floor memory f) {
        f.floorWei = floorWei;
        f.issuedAt = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, factory.floorDigest(floorWei, mode, f.issuedAt));
        f.sig = abi.encodePacked(r, s, v);
    }

    function noFloor() internal pure returns (Party.Floor memory f) {}
}
