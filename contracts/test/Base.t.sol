// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PartyFactory} from "../src/PartyFactory.sol";
import {Party} from "../src/Party.sol";
import {CreditCards} from "../src/CreditCards.sol";
import {CreditKeys} from "../src/CreditKeys.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ICredits, ICreditArt, IStatement} from "../src/interfaces/IExternal.sol";

/// @notice Exposes the library's key() so tests can build correct preset orders.
contract KeyProbe {
    function key(CreditKeys.Preset p, ICredits c, uint256 id) external view returns (uint256) {
        return CreditKeys.key(p, c, ICreditArt(c.art()), id);
    }

    function shuffle(uint256[] memory ids, uint256 seed) external pure returns (uint256[] memory) {
        return CreditKeys.shuffle(ids, seed);
    }
}

/// @notice Mainnet fork against the real, sealed Credits contract. Needs ETH_RPC_URL.
abstract contract Base is Test {
    ICredits constant CREDITS = ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043);
    uint256 constant FORK_BLOCK = 26044000;
    // Holders with >= 80 Credits at FORK_BLOCK (from the Transfer-log snapshot).
    address constant WHALE = 0xbdf883bDb53F42620F20629c3D40E75148965363;

    PartyFactory factory;
    MockStatement statement;
    CreditCards cards;
    KeyProbe probe;
    uint256 signerKey = 0xA11CE;
    address feeTo = makeAddr("fee");

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), FORK_BLOCK);
        statement = new MockStatement(address(CREDITS));
        factory = new PartyFactory(CREDITS, IStatement(address(statement)), feeTo, vm.addr(signerKey));
        cards = factory.cards();
        probe = new KeyProbe();
    }

    function params(CreditKeys.Preset arr) internal pure returns (Party.Params memory p) {
        p.name = "Test Party";
        p.description = "fork test";
        p.filters = "any";
        p.minDeposit = 1;
        p.durationDays = 14;
        p.voteHours = 48;
        p.arrangement = arr;
        p.seed = 42;
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, 3 ether);
        p.floorMode = Party.FloorMode.Avg24h;
    }

    function holdings(address who) internal view returns (uint256[] memory ids) {
        (bool ok, bytes memory r) = address(CREDITS).staticcall(abi.encodeWithSignature("tokensOf(address)", who));
        require(ok, "tokensOf");
        ids = abi.decode(r, (uint256[]));
    }

    function take(uint256[] memory a, uint256 from, uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = a[from + i];
    }

    function depositFrom(Party party, address who, uint256[] memory ids) internal {
        vm.startPrank(who);
        CREDITS.setApprovalForAll(address(party), true);
        party.deposit(ids, new bytes32[][](0));
        CREDITS.setApprovalForAll(address(party), false);
        vm.stopPrank();
    }

    function floorSig(uint256 floorWei, uint8 mode) internal view returns (Party.Floor memory f) {
        f.floorWei = floorWei;
        f.issuedAt = uint64(block.timestamp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, factory.floorDigest(floorWei, mode, f.issuedAt));
        f.sig = abi.encodePacked(r, s, v);
    }

    function noFloor() internal pure returns (Party.Floor memory f) {}

    /// Sort `ids` ascending by preset key (insertion sort; 80 items).
    function sortBy(CreditKeys.Preset p, uint256[] memory ids) internal view returns (uint256[] memory) {
        uint256[] memory k = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) k[i] = probe.key(p, CREDITS, ids[i]);
        for (uint256 i = 1; i < ids.length; ++i) {
            (uint256 kk, uint256 id) = (k[i], ids[i]);
            uint256 j = i;
            while (j > 0 && k[j - 1] > kk) { k[j] = k[j - 1]; ids[j] = ids[j - 1]; --j; }
            k[j] = kk; ids[j] = id;
        }
        return ids;
    }

    function cardsOf(Party party, address who) internal view returns (uint256[] memory out) {
        uint256 n;
        uint256 total = cards.nextId();
        for (uint256 c = 1; c < total; ++c) if (_live(c) && cards.partyOf(c) == address(party) && cards.ownerOf(c) == who) ++n;
        out = new uint256[](n);
        n = 0;
        for (uint256 c = 1; c < total; ++c) if (_live(c) && cards.partyOf(c) == address(party) && cards.ownerOf(c) == who) out[n++] = c;
    }

    function _live(uint256 c) private view returns (bool) {
        try cards.ownerOf(c) returns (address) { return true; } catch { return false; }
    }
}
