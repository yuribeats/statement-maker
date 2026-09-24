// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalBase} from "../LocalBase.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt, ICreditTraits} from "../../src/interfaces/IExternal.sol";

/// @notice The keys Party verifies (the collection's CreditTraits table) and shuffle(), so tests can build the exact
///         preset orders.
contract UnitKeyProbe {
    ICreditTraits public immutable traits;

    constructor(ICreditTraits t) {
        traits = t;
    }

    function key(CreditKeys.Preset p, ICredits, uint256 id) external view returns (uint256) {
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        return traits.keys(uint8(p), one)[0];
    }

    function shuffle(uint256[] memory ids, uint256 seed) external pure returns (uint256[] memory) {
        return CreditKeys.shuffle(ids, seed);
    }
}

/// @notice Accepts ETH, holds cards/Credits, has NO onERC721Received (plain transfers only).
contract PlainHolder {
    receive() external payable {}

    function claim(Party p, uint256[] calldata ids) external {
        p.claim(ids);
    }
}

/// @notice Rejects every ETH transfer.
contract EthRejecter {
    receive() external payable {
        revert("no");
    }

    function buy(Party p, uint256 maxPrice) external payable {
        p.buy{value: msg.value}(maxPrice);
    }

    function withdraw(Party p) external {
        p.withdraw();
    }
}

abstract contract UnitBase is LocalBase {
    UnitKeyProbe probe;
    uint256 nextCardIdx; // cursor into the party's card list used by give()

    function setUp() public virtual override {
        super.setUp();
        probe = new UnitKeyProbe(traits);
    }

    function bad(string memory why) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Party.Bad.selector, why);
    }

    function first(address who, uint256 n) internal view returns (uint256[] memory out) {
        uint256[] memory mine = ownedBy(who);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = mine[i];
    }

    function slice(address who, uint256 from, uint256 n) internal view returns (uint256[] memory out) {
        uint256[] memory mine = ownedBy(who);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = mine[from + i];
    }

    function one(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    /// Party hosted by holders[0], opened with holders[0]'s first `minDeposit` Credits (card 1.. go to holders[0]).
    function newParty(Party.Params memory p) internal returns (Party) {
        return openParty(p, holders[0], first(holders[0], p.minDeposit));
    }

    /// Tops the party up to 80: holders[0] to 60 in total (it hosted with its opening deposit), then holders[1] 20.
    /// Cards 1..60 end up with holders[0] and 61..80 with holders[1], as before the opening-deposit change.
    function fill(Party party) internal {
        uint256 have = party.count();
        require(have <= 60, "harness: fill");
        if (have < 60) deposit(party, holders[0], first(holders[0], 60 - have));
        deposit(party, holders[1], first(holders[1], 20));
        nextCardIdx = 0;
    }

    /// Full party with a deliberately scrambled deposit order (neither id- nor time-sorted). holders[3] hosts and
    /// opens with its first 40; holders[2] then deposits its first 40 in a permuted order.
    function scrambledParty(Party.Params memory p) internal returns (Party party) {
        uint256[] memory a = first(holders[2], 40);
        uint256[] memory b = first(holders[3], 40);
        uint256[] memory ra = new uint256[](40);
        for (uint256 i; i < 40; ++i) ra[i] = a[(i * 17) % 40]; // 17 coprime with 40
        party = openParty(p, holders[3], b);
        deposit(party, holders[2], ra);
        nextCardIdx = 0;
    }

    function partyCards(Party party) internal view returns (uint256[] memory out) {
        uint256 total = cards.nextId();
        uint256 n;
        for (uint256 c = 1; c < total; ++c) if (cards.partyOf(c) == address(party) && _live(c)) ++n;
        out = new uint256[](n);
        n = 0;
        for (uint256 c = 1; c < total; ++c) if (cards.partyOf(c) == address(party) && _live(c)) out[n++] = c;
    }

    function cardsOf(Party party, address who) internal view returns (uint256[] memory out) {
        uint256[] memory all = partyCards(party);
        uint256 n;
        for (uint256 i; i < all.length; ++i) if (cards.ownerOf(all[i]) == who) ++n;
        out = new uint256[](n);
        n = 0;
        for (uint256 i; i < all.length; ++i) if (cards.ownerOf(all[i]) == who) out[n++] = all[i];
    }

    function _live(uint256 c) private view returns (bool) {
        try cards.ownerOf(c) returns (address) { return true; } catch { return false; }
    }

    /// Move `n` of the party's cards (taken in card order) to `to`. Call roll() before proposing.
    function give(Party party, address to, uint256 n) internal {
        uint256[] memory all = partyCards(party);
        for (uint256 i; i < n; ++i) {
            uint256 c = all[nextCardIdx++];
            address o = cards.ownerOf(c);
            if (o == to) continue;
            vm.prank(o);
            cards.transferFrom(o, to, c);
        }
    }

    function roll() internal {
        vm.roll(block.number + 1);
    }

    function assembleDeposit(Party party) internal {
        uint256[] memory order = party.depositOrder();
        address who = cards.ownerOf(partyCards(party)[0]);
        vm.prank(who);
        party.assemble(order, noFloor());
    }

    /// Fixed-price Deposit-preset party, filled and assembled; cards then split as `counts` among fresh voters.
    function assembledWithVoters(uint256[] memory counts) internal returns (Party party, address[] memory voters) {
        party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        voters = spread(party, counts);
    }

    function spread(Party party, uint256[] memory counts) internal returns (address[] memory voters) {
        voters = new address[](counts.length);
        for (uint256 i; i < counts.length; ++i) {
            voters[i] = makeAddr(string.concat("voter", vm.toString(i)));
            give(party, voters[i], counts[i]);
        }
        roll();
    }

    function c2(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    function c3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3);
        x[0] = a;
        x[1] = b;
        x[2] = c;
    }

    function fixedPrice(uint256 wei_) internal pure returns (Party.PriceSpec memory) {
        return Party.PriceSpec(Party.PriceMode.Fixed, int256(wei_));
    }

    function floorAt(uint256 floorWei, uint8 mode, uint64 issuedAt, uint256 key, PartyFactory f)
        internal
        view
        returns (Party.Floor memory fl)
    {
        fl.floorWei = floorWei;
        fl.issuedAt = issuedAt;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, f.floorDigest(floorWei, mode, issuedAt));
        fl.sig = abi.encodePacked(r, s, v);
    }

    /// Sort ids ascending by preset key (insertion sort).
    function sortBy(CreditKeys.Preset p, uint256[] memory idsIn) internal view returns (uint256[] memory ids) {
        ids = new uint256[](idsIn.length);
        for (uint256 i; i < idsIn.length; ++i) ids[i] = idsIn[i];
        uint256[] memory k = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) k[i] = probe.key(p, ICredits(address(credits)), ids[i]);
        for (uint256 i = 1; i < ids.length; ++i) {
            (uint256 kk, uint256 id) = (k[i], ids[i]);
            uint256 j = i;
            while (j > 0 && k[j - 1] > kk) { k[j] = k[j - 1]; ids[j] = ids[j - 1]; --j; }
            k[j] = kk;
            ids[j] = id;
        }
    }

    function swapped(uint256[] memory a, uint256 i, uint256 j) internal pure returns (uint256[] memory b) {
        b = new uint256[](a.length);
        for (uint256 k; k < a.length; ++k) b[k] = a[k];
        (b[i], b[j]) = (b[j], b[i]);
    }

    // ------------------------------------------------------------------ Merkle (OZ-compatible, sorted pairs)

    function leafOf(uint256 id) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id))));
    }

    function _hp(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function merkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            bytes32[] memory up = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < level.length; i += 2) up[i / 2] = i + 1 < level.length ? _hp(level[i], level[i + 1]) : level[i];
            level = up;
        }
        return level[0];
    }

    function merkleProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[n++] = level[sib];
            bytes32[] memory up = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < level.length; i += 2) up[i / 2] = i + 1 < level.length ? _hp(level[i], level[i + 1]) : level[i];
            level = up;
            idx /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) proof[i] = tmp[i];
    }
}
