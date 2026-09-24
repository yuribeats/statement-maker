// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkDiff} from "./PresetsDiff.t.sol";
import {ICreditArt} from "../../src/interfaces/IExternal.sol";

/// @notice The contract's view of each Credit's traits (what CreditKeys reads: seedOf, timestampOf, paidAt % 15 + 1
///         mask → colorRank, and art.describe()) vs the site's data/credits.json + data/traits.json + rarity score.
contract TraitsDiffTest is ForkDiff {
    string json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("data/diff/traits.json");
    }

    uint256 bad;

    function _fail(string memory what, uint256 id) internal {
        ++bad;
        if (bad <= 20) emit log_named_uint(string.concat("MISMATCH ", what, " id"), id);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    uint256[] ids;
    bytes[] seeds;
    uint256[] paidAt;
    string[] colors;
    uint256[] colorRank;
    uint256[] plates;
    uint256[] marks;
    uint256[] eights;
    string[] weight;
    string[] print;
    string[] tier;
    uint256[] score;
    ICreditArt art;

    function _letters(uint256 mask) internal pure returns (string memory) {
        string memory s;
        if (mask & 1 != 0) s = string.concat(s, "C");
        if (mask & 2 != 0) s = string.concat(s, "M");
        if (mask & 4 != 0) s = string.concat(s, "Y");
        if (mask & 8 != 0) s = string.concat(s, "K");
        return s;
    }

    function _one(uint256 i) internal {
        uint256 id = ids[i];
        bytes21 seed = CREDITS.seedOf(id);
        uint64 ts = CREDITS.timestampOf(id);
        if (seed != bytes21(seeds[i])) _fail("seedOf", id);
        if (ts != paidAt[i]) _fail("timestampOf", id);
        uint256 mask = uint256(ts) % 15 + 1;
        if (!_eq(_letters(mask), colors[i])) _fail("mask letters vs colors", id);
        if (probe.colorRank(mask) != colorRank[i]) _fail("colorRank vs COLOR_ORDER index", id);
        ICreditArt.Read memory r = art.describe(seed, ts);
        if (!_eq(r.colors, colors[i])) _fail("describe.colors", id);
        if (r.plates != plates[i]) _fail("describe.plates", id);
        if (r.marks != marks[i]) _fail("describe.marks", id);
        if (r.eights != eights[i]) _fail("describe.eights", id);
        if (!_eq(r.weight, weight[i])) _fail("describe.weight", id);
        if (!_eq(r.register, print[i])) _fail("describe.register vs print", id);
        if (!_eq(r.tier, tier[i])) _fail("describe.tier", id);
        if (probe.score(mask, r.register, r.weight, r.eights) != score[i]) _fail("rarity score", id);
    }

    function test_traitsParity() public {
        ids = vm.parseJsonUintArray(json, ".ids");
        seeds = vm.parseJsonBytesArray(json, ".seedHex");
        paidAt = vm.parseJsonUintArray(json, ".paidAt");
        colors = vm.parseJsonStringArray(json, ".colors");
        colorRank = vm.parseJsonUintArray(json, ".colorRank");
        plates = vm.parseJsonUintArray(json, ".plates");
        marks = vm.parseJsonUintArray(json, ".marks");
        eights = vm.parseJsonUintArray(json, ".eights");
        weight = vm.parseJsonStringArray(json, ".weight");
        print = vm.parseJsonStringArray(json, ".print");
        tier = vm.parseJsonStringArray(json, ".tier");
        score = vm.parseJsonUintArray(json, ".score");
        art = ICreditArt(CREDITS.art());
        for (uint256 i; i < ids.length; ++i) _one(i);
        emit log_named_uint("Credits compared", ids.length);
        emit log_named_uint("field mismatches", bad);
        assertEq(bad, 0);
    }
}
