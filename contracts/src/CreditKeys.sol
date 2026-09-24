// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICredits, ICreditArt} from "./interfaces/IExternal.sol";

/// @notice Arrangement presets and their sort keys, computed from on-chain Credits data only.
///         Every auto arrangement is a strict ascending order of uint256 keys; the low 32 bits of each key are
///         the Credit id, so keys are unique and ties always break by ascending id.
///         The same orderings are implemented in the site (server.mjs PRESETS) and must stay identical.
library CreditKeys {
    enum Preset {
        Deposit, // deposit order (verified against the stored order, no keys)
        Number, // id ascending
        Time, // payment time ascending
        Rarity, // rarity score descending
        Colors, // plate combination, COLOR_ORDER
        Print, // registration, most misregistered first
        Weight, // sparse → extreme, then ink ascending
        Eights, // most eights first
        Ink, // marks ascending
        Random, // keccak Fisher–Yates of the deposit order with a published seed
        Manual // host supplies the order; no key check
    }

    uint256 internal constant ID_BITS = 32;

    function key(Preset p, ICredits credits, ICreditArt art, uint256 id) internal view returns (uint256) {
        require(id < 2 ** ID_BITS, "id");
        if (p == Preset.Number) return id;
        uint64 paidAt = credits.timestampOf(id);
        if (p == Preset.Time) return (uint256(paidAt) << ID_BITS) | id;
        uint256 mask = uint256(paidAt) % 15 + 1; // CreditDrawing.platesAt
        if (p == Preset.Colors) return (colorRank(mask) << ID_BITS) | id;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), paidAt);
        if (p == Preset.Ink) return (r.marks << ID_BITS) | id;
        if (p == Preset.Eights) return ((type(uint32).max - r.eights) << ID_BITS) | id;
        if (p == Preset.Print) return ((5 - printRank(r.register)) << ID_BITS) | id;
        if (p == Preset.Weight) return (((weightRank(r.weight) << 16) | r.marks) << ID_BITS) | id;
        if (p == Preset.Rarity) {
            uint256 score = colorWeight(mask) + printWeight(r.register) + weightWeight(r.weight) + eightsWeight(r.eights);
            return ((type(uint64).max - score) << ID_BITS) | id;
        }
        revert("preset");
    }

    // COLOR_ORDER = C, M, Y, K, CM, CY, MY, CK, MK, YK, CMY, CMK, CYK, MYK, CMYK (mask bits C=1 M=2 Y=4 K=8)
    function colorRank(uint256 mask) internal pure returns (uint256) {
        if (mask == 1) return 0;
        if (mask == 2) return 1;
        if (mask == 4) return 2;
        if (mask == 8) return 3;
        if (mask == 3) return 4;
        if (mask == 5) return 5;
        if (mask == 6) return 6;
        if (mask == 9) return 7;
        if (mask == 10) return 8;
        if (mask == 12) return 9;
        if (mask == 7) return 10;
        if (mask == 11) return 11;
        if (mask == 13) return 12;
        if (mask == 14) return 13;
        return 14; // 15 = CMYK
    }

    // PRINT_ORDER = Registered, Nudge, Slip, Skew, Drift, Loose
    function printRank(string memory reg) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(reg));
        if (h == keccak256("Registered")) return 0;
        if (h == keccak256("Nudge")) return 1;
        if (h == keccak256("Slip")) return 2;
        if (h == keccak256("Skew")) return 3;
        if (h == keccak256("Drift")) return 4;
        if (h == keccak256("Loose")) return 5;
        revert("print");
    }

    // WEIGHT_ORDER = sparse, lean, even, extreme
    function weightRank(string memory w) internal pure returns (uint256) {
        bytes32 h = keccak256(bytes(w));
        if (h == keccak256("sparse")) return 0;
        if (h == keccak256("lean")) return 1;
        if (h == keccak256("even")) return 2;
        if (h == keccak256("extreme")) return 3;
        revert("weight");
    }

    // Rarity: round(-log2(count / 122154) * 1e9) per trait value, from the sealed supply (data/rarity.json).
    function colorWeight(uint256 mask) internal pure returns (uint256) {
        if (mask == 1) return 3908947081;
        if (mask == 2) return 3913745110;
        if (mask == 3) return 3903634585;
        if (mask == 4) return 3908060305;
        if (mask == 5) return 3919631122;
        if (mask == 6) return 3887463858;
        if (mask == 7) return 3915169818;
        if (mask == 8) return 3939426425;
        if (mask == 9) return 3889562832;
        if (mask == 10) return 3910011931;
        if (mask == 11) return 3901515053;
        if (mask == 12) return 3926259272;
        if (mask == 13) return 3895350809;
        if (mask == 14) return 3877188084;
        return 3908592305; // 15
    }

    function printWeight(string memory reg) internal pure returns (uint256) {
        uint256 r = printRank(reg);
        if (r == 0) return 195465472;
        if (r == 1) return 4661729380;
        if (r == 2) return 4640364522;
        if (r == 3) return 5366472805;
        if (r == 4) return 6072587748;
        return 6964650926;
    }

    function weightWeight(string memory w) internal pure returns (uint256) {
        uint256 r = weightRank(w);
        if (r == 0) return 2887813475;
        if (r == 1) return 1831411512;
        if (r == 2) return 801626426;
        return 6615253228;
    }

    function eightsWeight(uint256 e) internal pure returns (uint256) {
        if (e == 0) return 448838239;
        if (e == 1) return 2125356957;
        if (e == 2) return 4849173708;
        if (e == 3) return 8261716960;
        if (e == 4) return 12197901863;
        if (e == 5) return 16898341581;
        revert("eights"); // no Credit in the sealed supply has more than 5
    }

    /// @notice Deterministic shuffle of `ids` (a copy): Fisher–Yates with j = keccak256(seed, i) mod (i + 1).
    function shuffle(uint256[] memory ids, uint256 seed) internal pure returns (uint256[] memory out) {
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = ids[i];
        for (uint256 i = out.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encodePacked(seed, i - 1))) % i;
            (out[i - 1], out[j]) = (out[j], out[i - 1]);
        }
    }
}
