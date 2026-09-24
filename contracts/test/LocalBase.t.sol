// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Credits} from "./credits/Credits.sol";
import {PartyFactory} from "../src/PartyFactory.sol";
import {Party} from "../src/Party.sol";
import {CreditCards} from "../src/CreditCards.sol";
import {CreditKeys} from "../src/CreditKeys.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ICredits, ICreditArt, IStatement} from "../src/interfaces/IExternal.sol";

/// @notice Local harness: deploys Jack's verified Credits source (test/credits, MIT) and distributes synthetic
///         Credits, so fuzzing runs fast without an RPC. Same bytecode logic as mainnet; only seeds differ.
abstract contract LocalBase is Test {
    Credits credits;
    PartyFactory factory;
    MockStatement statement;
    CreditCards cards;
    uint256 signerKey = 0xA11CE;
    address feeTo = makeAddr("fee");
    address collectionOwner = makeAddr("collectionOwner"); // CreditCards.owner(): marketplace page only
    address[] holders;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        credits = new Credits(address(this));
        _distribute(8, 60); // 8 holders × 60 Credits = 480
        credits.seal();
        statement = new MockStatement(address(credits));
        factory = new PartyFactory(ICredits(address(credits)), IStatement(address(statement)), feeTo, vm.addr(signerKey), collectionOwner);
        cards = factory.cards();
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
        address predicted = f.predictParty(host);
        vm.startPrank(host);
        credits.setApprovalForAll(predicted, true);
        party = f.createParty(p, ids, proofs);
        credits.setApprovalForAll(predicted, false);
        vm.stopPrank();
        require(address(party) == predicted, "harness: predicted address");
    }

    function ownedBy(address who) internal view returns (uint256[] memory) {
        return credits.tokensOf(who);
    }

    function deposit(Party party, address who, uint256[] memory ids) internal {
        vm.startPrank(who);
        credits.setApprovalForAll(address(party), true);
        party.deposit(ids, new bytes32[][](0));
        credits.setApprovalForAll(address(party), false);
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
