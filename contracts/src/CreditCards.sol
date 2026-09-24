// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

interface ICardParty {
    function cardView(uint256 cardId) external view returns (string memory name, uint256 creditId, string memory status);
}

/// @title Credit Cards
/// @notice One ERC-721 per Credit deposited into a Statement Maker party. Everything follows the card: its vote,
///         the right to redeem its Credit before the burn (or after expiry), and 1/80 of the sale.
///         One collection for all parties; each card belongs to exactly one party, fixed at mint.
///         Vote weight is the number of a party's cards an account held at a past block (checkpointed on transfer).
contract CreditCards is ERC721 {
    using Checkpoints for Checkpoints.Trace208;

    address public immutable factory;
    uint256 public nextId = 1;

    mapping(address party => bool) public isParty;
    mapping(uint256 cardId => address) public partyOf;
    mapping(address party => mapping(address account => Checkpoints.Trace208)) private _held;

    error NotFactory();
    error NotParty();
    error FutureLookup();

    constructor(address factory_) ERC721("Credit Cards", "CARD") {
        factory = factory_;
    }

    function registerParty(address party) external {
        if (msg.sender != factory) revert NotFactory();
        isParty[party] = true;
    }

    function mint(address to) external returns (uint256 id) {
        if (!isParty[msg.sender]) revert NotParty();
        id = nextId++;
        partyOf[id] = msg.sender;
        _mint(to, id); // _mint, not _safeMint: a party never calls back into an unknown receiver
    }

    /// @notice Only the card's own party can burn it (on redeem or claim), after checking the caller holds it.
    function burn(uint256 id) external {
        if (partyOf[id] != msg.sender) revert NotParty();
        _burn(id);
    }

    /// @notice Cards of `party` held by `account` at the end of block `blockNumber` (must be in the past).
    function heldAt(address party, address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert FutureLookup();
        return _held[party][account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function heldNow(address party, address account) external view returns (uint256) {
        return _held[party][account].latest();
    }

    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = super._update(to, id, auth);
        address party = partyOf[id];
        uint48 b = SafeCast.toUint48(block.number);
        if (from != address(0)) {
            Checkpoints.Trace208 storage h = _held[party][from];
            h.push(b, h.latest() - 1);
        }
        if (to != address(0)) {
            Checkpoints.Trace208 storage h = _held[party][to];
            h.push(b, h.latest() + 1);
        }
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        (string memory name, uint256 creditId, string memory status) = ICardParty(partyOf[id]).cardView(id);
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 856 540"><rect width="856" height="540" fill="#fff" stroke="#111"/>',
            '<g font-family="monospace" fill="#111"><text x="40" y="60" font-size="22" font-weight="700">CREDIT CARD</text>',
            '<text x="816" y="60" font-size="18" text-anchor="end" fill="#929292">NO. ', Strings.toString(id), "</text>",
            '<text x="40" y="160" font-size="20" font-weight="700">', _clean(name), "</text>",
            '<text x="40" y="200" font-size="18">CREDIT #', Strings.toString(creditId), "</text>",
            '<text x="40" y="232" font-size="16" fill="#929292">1 OF 80 / 1 VOTE / 1/80 OF SALE</text>',
            '<text x="40" y="300" font-size="22" font-weight="700">', status, "</text></g>",
            '<rect x="40" y="410" width="22" height="22" fill="#00B5E2"/><rect x="66" y="410" width="22" height="22" fill="#E4007C"/>',
            '<rect x="92" y="410" width="22" height="22" fill="#FFD100"/><rect x="118" y="410" width="22" height="22" fill="#111"/></svg>'
        );
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '{"name":"Credit Card #', Strings.toString(id), '","description":"One of 80 cards for a Statement Maker party. Holder has the vote, the Credit before the burn, and 1/80 of the sale.",',
                        '"attributes":[{"trait_type":"Credit","value":', Strings.toString(creditId), '},{"trait_type":"Party","value":"', Strings.toHexString(partyOf[id]), '"}],',
                        '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
                    )
                )
            )
        );
    }

    /// @dev Party names are host-supplied: keep only [A-Za-z0-9 .,'-] so they cannot break the SVG or JSON.
    function _clean(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        uint256 n;
        for (uint256 i; i < b.length && n < 40; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x20 || c == 0x2E || c == 0x2C || c == 0x2D;
            if (ok) out[n++] = c;
        }
        assembly { mstore(out, n) }
        return string(out);
    }
}
