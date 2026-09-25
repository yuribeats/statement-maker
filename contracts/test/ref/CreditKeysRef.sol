// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt} from "../../src/interfaces/IExternal.sol";

/// @notice REFERENCE ORACLE (tests and the key-table generator only): the original on-chain key path, which calls the
///         art contract's describe() for every Credit. Party no longer uses it; the sealed CreditTraits table must
///         reproduce these keys exactly (Time: same order, since the new Time key is the id).
///         Rarity is the exception: on mainnet it is Jack Butcher's official rating, an off-chain snapshot
///         (data/jack-rating.json.gz -> contracts/data/keytable/rarity.bin), so the mainnet reference for Rarity is that
///         file, never this library. For TEST collections (the local 480-Credit suite, the Sepolia copy), which have no
///         official rating, key() and packed() use a stand-in class: standInClass(eights, print) (more eights first,
///         then more misregistered first). It only exists so those suites can exercise the Rarity key path.
library CreditKeysRef {
    uint256 internal constant ID_BITS = 32;

    function key(CreditKeys.Preset p, ICredits credits, ICreditArt art, uint256 id) internal view returns (uint256) {
        require(id < 2 ** ID_BITS, "id");
        if (p == CreditKeys.Preset.Number) return id;
        uint64 paidAt = credits.timestampOf(id);
        if (p == CreditKeys.Preset.Time) return (uint256(paidAt) << ID_BITS) | id;
        uint256 mask = uint256(paidAt) % 15 + 1; // CreditDrawing.platesAt
        if (p == CreditKeys.Preset.Colors) return (CreditKeys.colorRank(mask) << ID_BITS) | id;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), paidAt);
        if (p == CreditKeys.Preset.Ink) return (r.marks << ID_BITS) | id;
        if (p == CreditKeys.Preset.Eights) return ((type(uint32).max - r.eights) << ID_BITS) | id;
        if (p == CreditKeys.Preset.Print) return ((5 - CreditKeys.printRank(r.register)) << ID_BITS) | id;
        if (p == CreditKeys.Preset.Weight) return (((CreditKeys.weightRank(r.weight) << 16) | r.marks) << ID_BITS) | id;
        if (p == CreditKeys.Preset.Rarity) return (standInClass(r.eights, CreditKeys.printRank(r.register)) << ID_BITS) | id;
        revert("preset");
    }

    /// @notice The 3 trait bytes of a CreditTraits entry (bits 16..39 of the table's uint40), from the art contract.
    function traits24(ICredits credits, ICreditArt art, uint256 id) internal view returns (uint256) {
        uint64 paidAt = credits.timestampOf(id);
        uint256 mask = uint256(paidAt) % 15 + 1;
        ICreditArt.Read memory r = art.describe(credits.seedOf(id), paidAt);
        require(r.marks < 256 && r.eights < 16, "range");
        return (r.marks << 16) | (mask << 12) | (r.eights << 8) | (CreditKeys.printRank(r.register) << 4) | CreditKeys.weightRank(r.weight);
    }

    /// @notice TEST collections only: stand-in rarity class (0 = rarest) from eights (descending) then print rank
    ///         (most misregistered first); 5 or more eights share the top. Mainnet tables carry the official rating's
    ///         class instead.
    function standInClass(uint256 eights, uint256 printRank) internal pure returns (uint256) {
        return ((eights >= 5 ? 0 : 5 - eights) << 3) | (5 - printRank);
    }

    /// @notice The full 5-byte entry (uint40) of a TEST collection's Credit: traits24 ++ stand-in rarity class.
    function packed(ICredits credits, ICreditArt art, uint256 id) internal view returns (uint256) {
        uint256 t = traits24(credits, art, id);
        return (t << 16) | standInClass((t >> 8) & 15, (t >> 4) & 15);
    }
}

/// @notice External access to the reference path (batch), for eth_call against mainnet and for tests.
contract RefProbe {
    function keys(CreditKeys.Preset p, ICredits c, uint256[] calldata ids) external view returns (uint256[] memory out) {
        ICreditArt art = ICreditArt(c.art());
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeysRef.key(p, c, art, ids[i]);
    }

    function packed(ICredits c, uint256[] calldata ids) external view returns (uint256[] memory out) {
        ICreditArt art = ICreditArt(c.art());
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeysRef.packed(c, art, ids[i]);
    }

    function traits24(ICredits c, uint256[] calldata ids) external view returns (uint256[] memory out) {
        ICreditArt art = ICreditArt(c.art());
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeysRef.traits24(c, art, ids[i]);
    }
}
