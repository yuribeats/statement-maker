// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICreditTraits} from "./interfaces/IExternal.sol";

/// @notice Arrangement presets and burn-order verification. verifyOrder() and shuffle() are public, so this library
///         is deployed once and linked (keeps Party under 24 KB).
///         Every sorted preset is a strict ascending order of uint256 keys; the low 32 bits of each key are the Credit
///         id, so keys are unique and ties always break by ascending id. Trait keys come from CreditTraits, a sealed
///         table of every Credit's traits committed once at deployment (the art contract is never called at a burn);
///         Rarity reads the table's rarity class, taken from a frozen snapshot of Jack Butcher's official rating.
///         Time: the sealed collection's payment times never decrease with id (verified over all 122,154 Credits,
///         test/keytable), so payment-time order with id tie-break is exactly ascending id.
///         The same orderings are implemented in the site (server.mjs PRESETS) and must stay identical.
library CreditKeys {
    enum Preset {
        Deposit, // deposit order (verified against the stored order, no keys)
        Number, // id ascending
        Time, // payment time ascending, ties by id == ascending id on the sealed collection
        Rarity, // Jack Butcher's official Credits rating, rarest first (rarity class ascending)
        Colors, // plate combination, COLOR_ORDER
        Print, // registration, most misregistered first
        Weight, // sparse → extreme, then ink ascending
        Eights, // most eights first
        Ink, // marks ascending
        Random, // keccak Fisher–Yates of the deposit order with a published seed
        Manual // host supplies the order; no key check
    }

    uint256 internal constant ID_BITS = 32;

    /// @dev Same signature as Party.Bad, so a Party caller surfaces identical revert data.
    error Bad(string why);

    /// @notice Reverts unless `order` is exactly the party's deposited ids and, for every preset but Manual, exactly
    ///         the order that preset produces. `deposited` is the party's stored deposit order and `cardOf` its
    ///         credit -> card map (nonzero iff deposited). Cheap checks only:
    ///         - Deposit: order == deposited. Random: order == shuffle(deposited, seed).
    ///         - Number, Time: ids strictly ascending. Trait presets: CreditTraits keys strictly ascending.
    ///           Strictly ascending implies distinct; with every id deposited and length == deposited.length, the
    ///           order is a permutation of the deposits.
    ///         - Manual: every id deposited and distinct (transient marks), length == deposited.length.
    function verifyOrder(
        Preset p,
        ICreditTraits traits,
        uint256[] storage deposited,
        mapping(uint256 => uint256) storage cardOf,
        uint256[] calldata order,
        uint256 seed
    ) public {
        uint256 n = deposited.length;
        if (order.length != n) revert Bad("length");
        if (p == Preset.Deposit) {
            for (uint256 i; i < n; ++i) if (order[i] != deposited[i]) revert Bad("order");
            return;
        }
        if (p == Preset.Random) {
            uint256[] memory want = shuffle(deposited, seed);
            for (uint256 i; i < n; ++i) if (order[i] != want[i]) revert Bad("order");
            return;
        }
        for (uint256 i; i < n; ++i) if (cardOf[order[i]] == 0) revert Bad("not deposited");
        if (p == Preset.Manual) {
            for (uint256 i; i < n; ++i) {
                uint256 id = order[i];
                uint256 seen;
                assembly { seen := tload(id) } // ids < 2^32: never collides with the reentrancy guard's hashed slot
                if (seen != 0) revert Bad("repeat");
                assembly { tstore(id, 1) }
            }
            for (uint256 i; i < n; ++i) {
                uint256 id = order[i];
                assembly { tstore(id, 0) }
            }
            return;
        }
        if (p == Preset.Number || p == Preset.Time) {
            for (uint256 i = 1; i < n; ++i) if (order[i] <= order[i - 1]) revert Bad("order");
            return;
        }
        uint256[] memory k = traits.keys(uint8(p), order);
        for (uint256 i = 1; i < n; ++i) if (k[i] <= k[i - 1]) revert Bad("order");
    }

    /// @notice Sort key of one Credit from its packed table entry (CreditTraits layout, uint40): marks (8 bits) |
    ///         mask (4) | eights (4) | printRank (4) | weightRank (4) | rarity class (16), most significant first.
    ///         Number/Time: the id itself.
    function traitKey(Preset p, uint256 id, uint256 packed) internal pure returns (uint256) {
        if (id >= 2 ** ID_BITS) revert Bad("id");
        if (p == Preset.Number || p == Preset.Time) return id;
        if (p == Preset.Rarity) return ((packed & 0xFFFF) << ID_BITS) | id;
        uint256 marks = packed >> 32;
        uint256 mask = (packed >> 28) & 15;
        uint256 eights = (packed >> 24) & 15;
        uint256 pr = (packed >> 20) & 15;
        uint256 wr = (packed >> 16) & 15;
        if (p == Preset.Colors) return (colorRank(mask) << ID_BITS) | id;
        if (p == Preset.Ink) return (marks << ID_BITS) | id;
        if (p == Preset.Eights) return ((type(uint32).max - eights) << ID_BITS) | id;
        if (p == Preset.Print) return ((5 - pr) << ID_BITS) | id;
        if (p == Preset.Weight) return (((wr << 16) | marks) << ID_BITS) | id;
        revert Bad("preset");
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

    /// @notice Deterministic shuffle of `ids` (a copy): Fisher–Yates with j = keccak256(seed, i) mod (i + 1).
    function shuffle(uint256[] memory ids, uint256 seed) public pure returns (uint256[] memory out) {
        return _shuffle(ids, seed);
    }

    function _shuffle(uint256[] memory ids, uint256 seed) private pure returns (uint256[] memory out) {
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = ids[i];
        for (uint256 i = out.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encodePacked(seed, i - 1))) % i;
            (out[i - 1], out[j]) = (out[j], out[i - 1]);
        }
    }
}
