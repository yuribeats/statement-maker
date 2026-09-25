// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditKeys} from "./CreditKeys.sol";
import {ICreditTraits} from "./interfaces/IExternal.sol";

/// @title Credit traits table
/// @notice Every Credit's sort traits, committed once. The Credits collection is sealed, so each Credit's traits
///         (from the art contract's pure describe() and its payment time) can never change. They are stored as data
///         contracts (SSTORE2 layout: code = 0x00 ++ data), 5 bytes per id, ids 1..count in order, 4,915 ids per chunk:
///           byte 0: marks (Ink)            byte 1: plate mask (hi 4 bits) | eights (lo 4 bits)
///           byte 2: print rank (hi 4 bits) | weight rank (lo 4 bits)
///           bytes 3-4: rarity class (uint16, big-endian): the Credit's place among the distinct ranks of Jack
///           Butcher's official Credits rating (jack.art/credits/rating, methodology 3.4.0), 0 = rarest. Credits
///           that share an official rank share a class; class order == official rank order. This one field is an
///           off-chain input: a frozen snapshot of that rating (data/jack-rating.json.gz), reproducible from the
///           Credits' own traits by the published formula (scripts/rating/verify.mjs).
///         Anyone can check the table against the live art contract (traitsOf vs describe) and the rating snapshot
///         (scripts/keytable). `tableHash` pins the exact chunk code; the deploy script refuses a table that differs
///         from the committed one. No owner, no admin, no upgrade path.
contract CreditTraits is ICreditTraits {
    uint256 public constant BYTES_PER_ID = 5;
    uint256 public constant IDS_PER_CHUNK = 4915; // 5 * 4915 + 1 = 24,576 bytes == EIP-170
    uint256 public constant MAX_CHUNKS = 25; // 122,875 ids

    uint256 public immutable count;
    uint256 public immutable chunkCount;
    bytes32 public immutable tableHash; // keccak256 of the chunks' code hashes, in order
    address internal immutable c0;
    address internal immutable c1;
    address internal immutable c2;
    address internal immutable c3;
    address internal immutable c4;
    address internal immutable c5;
    address internal immutable c6;
    address internal immutable c7;
    address internal immutable c8;
    address internal immutable c9;
    address internal immutable c10;
    address internal immutable c11;
    address internal immutable c12;
    address internal immutable c13;
    address internal immutable c14;
    address internal immutable c15;
    address internal immutable c16;
    address internal immutable c17;
    address internal immutable c18;
    address internal immutable c19;
    address internal immutable c20;
    address internal immutable c21;
    address internal immutable c22;
    address internal immutable c23;
    address internal immutable c24;

    error Bad(string why);

    constructor(address[] memory chunks, uint256 count_) {
        uint256 n = chunks.length;
        if (n == 0 || n > MAX_CHUNKS || count_ == 0 || (count_ + IDS_PER_CHUNK - 1) / IDS_PER_CHUNK != n) revert Bad("chunks");
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            uint256 want = 1 + BYTES_PER_ID * (i + 1 < n ? IDS_PER_CHUNK : count_ - i * IDS_PER_CHUNK);
            if (chunks[i].code.length != want) revert Bad("chunk size");
            hs[i] = chunks[i].codehash;
        }
        tableHash = keccak256(abi.encodePacked(hs));
        count = count_;
        chunkCount = n;
        address[25] memory a;
        for (uint256 i; i < n; ++i) a[i] = chunks[i];
        (c0, c1, c2, c3, c4, c5, c6, c7) = (a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
        (c8, c9, c10, c11, c12, c13, c14, c15) = (a[8], a[9], a[10], a[11], a[12], a[13], a[14], a[15]);
        (c16, c17, c18, c19, c20, c21, c22, c23, c24) = (a[16], a[17], a[18], a[19], a[20], a[21], a[22], a[23], a[24]);
    }

    function _chunk(uint256 i) internal view returns (address) {
        if (i < 8) {
            if (i < 4) return i == 0 ? c0 : i == 1 ? c1 : i == 2 ? c2 : c3;
            return i == 4 ? c4 : i == 5 ? c5 : i == 6 ? c6 : c7;
        }
        if (i < 16) {
            if (i < 12) return i == 8 ? c8 : i == 9 ? c9 : i == 10 ? c10 : c11;
            return i == 12 ? c12 : i == 13 ? c13 : i == 14 ? c14 : c15;
        }
        if (i < 20) return i == 16 ? c16 : i == 17 ? c17 : i == 18 ? c18 : c19;
        return i == 20 ? c20 : i == 21 ? c21 : i == 22 ? c22 : i == 23 ? c23 : c24;
    }

    /// @notice The data contract holding chunk `i` (ids i*4915+1 .. (i+1)*4915), for verifiers.
    function chunkAt(uint256 i) external view returns (address) {
        if (i >= chunkCount) revert Bad("chunk");
        return _chunk(i);
    }

    /// @notice The 5 packed bytes of `id` (see the layout above), as a uint40: traits in bits 16..39, rarity class in
    ///         bits 0..15.
    function packedOf(uint256 id) public view returns (uint256 v) {
        if (id == 0 || id > count) revert Bad("id");
        uint256 k = id - 1;
        address c = _chunk(k / IDS_PER_CHUNK);
        uint256 off = 1 + BYTES_PER_ID * (k % IDS_PER_CHUNK);
        assembly {
            let m := mload(0x40)
            mstore(m, 0)
            extcodecopy(c, add(m, 27), off, 5)
            v := mload(m)
        }
    }

    /// @notice Decoded traits of `id`: marks, plate mask (C=1 M=2 Y=4 K=8), eights, print rank (Registered..Loose
    ///         = 0..5), weight rank (sparse, lean, even, extreme = 0..3), rarity class (0 = rarest by the official
    ///         rating; equal official ranks share a class).
    function traitsOf(uint256 id)
        external
        view
        returns (uint256 marks, uint256 mask, uint256 eights, uint256 printRank, uint256 weightRank, uint256 rarityClass)
    {
        uint256 v = packedOf(id);
        return (v >> 32, (v >> 28) & 15, (v >> 24) & 15, (v >> 20) & 15, (v >> 16) & 15, v & 0xFFFF);
    }

    /// @notice Sort keys of `ids` under `preset` (CreditKeys.Preset): what Party verifies a burn order against.
    function keys(uint8 preset, uint256[] calldata ids) external view returns (uint256[] memory out) {
        CreditKeys.Preset p = CreditKeys.Preset(preset);
        out = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = CreditKeys.traitKey(p, ids[i], packedOf(ids[i]));
    }
}
