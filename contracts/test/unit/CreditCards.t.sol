// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditCards} from "../../src/CreditCards.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract CreditCardsTest is UnitBase {
    // ------------------------------------------------------------------ access

    function test_registerParty_onlyFactory() public {
        vm.expectRevert(CreditCards.NotFactory.selector);
        cards.registerParty(address(this));
    }

    function test_mint_onlyRegisteredParty() public {
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.mint(address(this));
        vm.prank(address(factory)); // not even the factory
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.mint(address(this));
    }

    function test_burn_onlyOwnParty() public {
        Party a = newParty(params(CreditKeys.Preset.Deposit));
        Party b = newParty(params(CreditKeys.Preset.Deposit));
        deposit(a, holders[0], first(holders[0], 1)); // card 1 -> a
        vm.prank(address(b));
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.burn(1);
        vm.prank(holders[0]); // the holder cannot burn directly either
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.burn(1);
        vm.prank(address(a));
        cards.burn(1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        cards.ownerOf(1);
    }

    function test_burn_unknownCard() public {
        Party a = newParty(params(CreditKeys.Preset.Deposit));
        vm.prank(address(a));
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.burn(42);
    }

    // ------------------------------------------------------------------ collection owner (marketplace page only)

    function test_owner_isCollectionOwner_andTransferable() public {
        assertEq(cards.owner(), collectionOwner);
        address next = makeAddr("nextOwner");
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, holders[0]));
        cards.transferOwnership(next);
        vm.prank(address(factory)); // the factory has no owner powers either
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(factory)));
        cards.transferOwnership(next);
        vm.prank(collectionOwner);
        cards.transferOwnership(next);
        assertEq(cards.owner(), next);
        vm.prank(next);
        cards.renounceOwnership();
        assertEq(cards.owner(), address(0));
    }

    function test_owner_hasNoProtocolPowers() public {
        Party a = newParty(params(CreditKeys.Preset.Deposit)); // card 1 -> holders[0]
        vm.startPrank(collectionOwner);
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.mint(collectionOwner);
        vm.expectRevert(CreditCards.NotParty.selector);
        cards.burn(1);
        vm.expectRevert(CreditCards.NotFactory.selector);
        cards.registerParty(collectionOwner);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, collectionOwner, 1));
        cards.transferFrom(holders[0], collectionOwner, 1);
        vm.expectRevert(bad("not holder"));
        a.redeem(one(1));
        vm.stopPrank();
        assertEq(cards.ownerOf(1), holders[0]);
        assertFalse(cards.isParty(collectionOwner));
        // the party keeps working after an ownership change
        vm.prank(collectionOwner);
        cards.transferOwnership(holders[5]);
        deposit(a, holders[0], first(holders[0], 1));
        assertEq(a.count(), 2);
        vm.prank(holders[0]);
        a.redeem(one(1));
        assertEq(a.count(), 1);
    }

    // ------------------------------------------------------------------ checkpoints

    function test_heldAt_futureReverts() public {
        Party a = newParty(params(CreditKeys.Preset.Deposit));
        vm.expectRevert(CreditCards.FutureLookup.selector);
        cards.heldAt(address(a), holders[0], block.number);
        vm.expectRevert(CreditCards.FutureLookup.selector);
        cards.heldAt(address(a), holders[0], block.number + 1);
        assertEq(cards.heldAt(address(a), holders[0], block.number - 1), 0);
    }

    function test_heldAt_tracksTransfersPerParty() public {
        uint256 b0 = 100; // literal: via-IR can defer a local block.number read past vm.roll
        vm.roll(b0);
        Party a = openParty(params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 3)); // cards 1..3
        Party b = openParty(params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 2)); // cards 4..5
        assertEq(cards.heldNow(address(a), holders[0]), 3);
        assertEq(cards.heldNow(address(b), holders[0]), 2);
        vm.roll(b0 + 1);
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], holders[1], 1);
        vm.roll(b0 + 2);
        assertEq(cards.heldAt(address(a), holders[0], b0), 3);
        assertEq(cards.heldAt(address(a), holders[0], b0 + 1), 2);
        assertEq(cards.heldAt(address(a), holders[1], b0), 0);
        assertEq(cards.heldAt(address(a), holders[1], b0 + 1), 1);
        assertEq(cards.heldAt(address(b), holders[0], b0 + 1), 2, "other party unaffected");
        vm.prank(holders[1]);
        a.redeem(one(1)); // burn
        assertEq(cards.heldNow(address(a), holders[1]), 0);
    }

    // ------------------------------------------------------------------ tokenURI

    function test_tokenURI_nonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        cards.tokenURI(7);
    }

    function _svgOf(uint256 id) internal view returns (string memory json, string memory svg) {
        string memory uri = cards.tokenURI(id);
        string memory pre = "data:application/json;base64,";
        assertEq(vm.indexOf(uri, pre), 0, "json prefix");
        json = string(b64decode(_after(uri, bytes(pre).length)));
        string memory img = vm.parseJsonString(json, ".image");
        string memory ipre = "data:image/svg+xml;base64,";
        assertEq(vm.indexOf(img, ipre), 0, "svg prefix");
        svg = string(b64decode(_after(img, bytes(ipre).length)));
    }

    function test_tokenURI_validJson() public {
        uint256 credit = first(holders[0], 1)[0];
        Party a = openParty(params(CreditKeys.Preset.Deposit), holders[0], one(credit));
        (string memory json, string memory svg) = _svgOf(1);
        assertEq(vm.parseJsonString(json, ".name"), "Credit Card #1");
        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "Credit");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), credit);
        assertEq(vm.parseJsonString(json, ".attributes[1].value"), vm.toLowercase(vm.toString(address(a))));
        assertTrue(vm.contains(svg, ">Local Party</text>"));
        assertTrue(vm.contains(svg, string.concat("CREDIT #", vm.toString(credit))));
        assertTrue(vm.contains(svg, ">FILLING</text>"));
        assertTrue(vm.contains(svg, "NO. 1</text>"));
    }

    function test_tokenURI_statusFollowsParty() public {
        Party a = newParty(params(CreditKeys.Preset.Deposit));
        fill(a);
        (, string memory svg) = _svgOf(1);
        assertTrue(vm.contains(svg, ">FULL</text>"));
        vm.warp(uint256(a.deadline()) + 1);
        (, svg) = _svgOf(1);
        assertTrue(vm.contains(svg, ">EXPIRED / REDEEMABLE</text>"));
    }

    function test_tokenURI_nameSanitized() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.name = "Ev\"il</text><script>alert('x')</script>&amp;{}";
        Party a = newParty(p);
        deposit(a, holders[0], first(holders[0], 1));
        (string memory json, string memory svg) = _svgOf(1);
        vm.parseJsonString(json, ".name"); // still parses
        assertFalse(vm.contains(svg, "<script"));
        assertFalse(vm.contains(svg, "Ev\"il"));
        // kept: [A-Za-z0-9 .,-]; the apostrophe is stripped too (doc comment says it is kept)
        assertTrue(vm.contains(svg, ">Eviltextscriptalertxscriptamp</text>"));
    }

    function test_tokenURI_nameTruncatedTo40() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.name = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwx"; // 60
        Party a = newParty(p);
        deposit(a, holders[0], first(holders[0], 1));
        (, string memory svg) = _svgOf(1);
        assertTrue(vm.contains(svg, ">ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd</text>"));
    }

    function test_tokenURI_allStripped() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.name = "<<<>>>\"\"";
        Party a = newParty(p);
        deposit(a, holders[0], first(holders[0], 1));
        (, string memory svg) = _svgOf(1);
        assertTrue(vm.contains(svg, "font-weight=\"700\"></text>"));
    }

    // ------------------------------------------------------------------ helpers

    function _after(string memory s, uint256 from) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length - from);
        for (uint256 i; i < out.length; ++i) out[i] = b[from + i];
        return string(out);
    }

    function _val(bytes1 c) private pure returns (uint256) {
        if (c >= "A" && c <= "Z") return uint8(c) - 65;
        if (c >= "a" && c <= "z") return uint8(c) - 97 + 26;
        if (c >= "0" && c <= "9") return uint8(c) - 48 + 52;
        if (c == "+") return 62;
        if (c == "/") return 63;
        revert("b64 char");
    }

    function b64decode(string memory s) internal pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        require(b.length % 4 == 0, "b64 len");
        uint256 pad = b.length == 0 ? 0 : (b[b.length - 1] == "=" ? (b[b.length - 2] == "=" ? 2 : 1) : 0);
        out = new bytes(b.length / 4 * 3 - pad);
        uint256 o;
        for (uint256 i; i < b.length; i += 4) {
            uint256 n = (_val(b[i]) << 18) | (_val(b[i + 1]) << 12)
                | ((b[i + 2] == "=" ? 0 : _val(b[i + 2])) << 6) | (b[i + 3] == "=" ? 0 : _val(b[i + 3]));
            if (o < out.length) out[o++] = bytes1(uint8(n >> 16));
            if (o < out.length) out[o++] = bytes1(uint8(n >> 8));
            if (o < out.length) out[o++] = bytes1(uint8(n));
        }
    }
}
