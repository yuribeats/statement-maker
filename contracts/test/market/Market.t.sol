// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {StatementMarket, IERC721Min} from "../../src/StatementMarket.sol";

contract Stmt is ERC721 {
    address public royaltyTo;
    uint256 public royaltyBps;
    bytes public rawRoyalty; // when set, royaltyInfo returns these bytes verbatim (malformed-response test)
    constructor() ERC721("Statements", "STMT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
    function burn(uint256 id) external { _burn(id); }
    function setRoyalty(address to, uint256 bps) external { royaltyTo = to; royaltyBps = bps; }
    function setRaw(bytes calldata b) external { rawRoyalty = b; }
    uint256 public burnReads; // cold SLOADs royaltyInfo makes first (~2.2k gas each), standing in for a delegating lookup
    function setBurn(uint256 n) external { burnReads = n; }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        uint256 x;
        for (uint256 i; i < burnReads; ++i) {
            assembly { x := add(x, sload(add(i, 0x1000))) } // used below, so the optimizer keeps the reads
        }
        if (x == type(uint256).max) revert();
        bytes memory r = rawRoyalty;
        if (r.length > 0) assembly { return(add(r, 32), mload(r)) }
        return (royaltyTo, price * royaltyBps / 10_000);
    }
}

contract RejectsEth { receive() external payable { revert(); } }

contract Reenter {
    StatementMarket m; uint256 id;
    constructor(StatementMarket m_) { m = m_; }
    function arm(uint256 id_) external { id = id_; }
    receive() external payable { try m.buy{value: 1 ether}(id, 1 ether) {} catch {} }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }
}

contract MarketTest is Test {
    Stmt st;
    StatementMarket m;
    address fee = makeAddr("fee");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");

    function setUp() public {
        st = new Stmt();
        m = new StatementMarket(IERC721Min(address(st)), fee);
        st.mint(seller, 1);
        vm.deal(buyer, 100 ether);
    }

    function _list(uint96 price) internal {
        vm.startPrank(seller);
        st.setApprovalForAll(address(m), true);
        m.list(1, price);
        vm.stopPrank();
    }

    function test_listAndBuy_splitsExactly() public {
        _list(2 ether);
        vm.prank(buyer);
        m.buy{value: 2.5 ether}(1, 2 ether);
        assertEq(st.ownerOf(1), buyer);
        assertEq(seller.balance, 2 ether - 0.02 ether, "seller gets price minus 1%");
        assertEq(buyer.balance, 100 ether - 2 ether, "excess refunded");
        assertEq(m.owed(fee), 0.02 ether);
        vm.prank(fee);
        m.withdraw();
        assertEq(address(m).balance, 0, "nothing stuck");
    }

    function test_listRequiresOwnerAndApproval() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "not owner"));
        m.list(1, 1 ether);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "approve the market first"));
        m.list(1, 1 ether);
    }

    function test_listingDiesWhenTokenMoves() public {
        _list(1 ether);
        vm.prank(seller);
        st.transferFrom(seller, makeAddr("elsewhere"), 1);
        assertFalse(m.isLive(1));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "not for sale"));
        m.buy{value: 1 ether}(1, 1 ether);
        m.cancel(1); // anyone may clear a dead listing
    }

    function test_listingDiesWhenApprovalRevoked() public {
        _list(1 ether);
        vm.prank(seller);
        st.setApprovalForAll(address(m), false);
        assertFalse(m.isLive(1));
    }

    function test_repriceFrontRunProtected() public {
        _list(1 ether);
        vm.prank(seller);
        m.list(1, 3 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "price"));
        m.buy{value: 3 ether}(1, 1 ether);
    }

    function test_onlySellerCancelsLiveListing() public {
        _list(1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "not seller"));
        m.cancel(1);
        vm.prank(seller);
        m.cancel(1);
        assertFalse(m.isLive(1));
    }

    function test_sellerThatRejectsEthIsPaidByWithdrawal() public {
        RejectsEth r = new RejectsEth();
        st.mint(address(r), 2);
        vm.startPrank(address(r));
        st.setApprovalForAll(address(m), true);
        m.list(2, 1 ether);
        vm.stopPrank();
        vm.prank(buyer);
        m.buy{value: 1 ether}(2, 1 ether);
        assertEq(st.ownerOf(2), buyer);
        assertEq(m.owed(address(r)), 0.99 ether);
    }

    function test_royaltyCappedAt10pct_andMalformedIgnored() public {
        st.setRoyalty(makeAddr("artist"), 5000);
        _list(1 ether);
        vm.prank(buyer);
        m.buy{value: 1 ether}(1, 1 ether);
        assertEq(m.owed(makeAddr("artist")), 0.1 ether);
        // malformed 32-byte royaltyInfo answer: sale still works, no royalty
        st.mint(seller, 3);
        st.setRaw(abi.encode(uint256(1)));
        vm.prank(seller);
        m.list(3, 1 ether);
        vm.prank(buyer);
        m.buy{value: 1 ether}(3, 1 ether);
        assertEq(st.ownerOf(3), buyer);
    }

    function test_reentrantBuyerCannotDoubleSpend() public {
        Reenter r = new Reenter(m);
        vm.deal(address(r), 5 ether);
        _list(1 ether);
        r.arm(1);
        vm.prank(address(r));
        m.buy{value: 2 ether}(1, 1 ether); // refund triggers receive → re-enter buy → blocked
        assertEq(st.ownerOf(1), address(r));
        assertEq(address(m).balance, m.owed(fee));
    }

    function test_cannotBuyOwnListing_orSendEth() public {
        vm.deal(seller, 5 ether);
        _list(1 ether);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "own listing"));
        m.buy{value: 1 ether}(1, 1 ether);
        (bool ok,) = address(m).call{value: 1}("");
        assertFalse(ok);
    }

    function testFuzz_splitAlwaysSums(uint96 price, uint16 bps) public {
        vm.assume(price > 0 && price < 1e27);
        st.setRoyalty(makeAddr("artist"), bps % 10_001);
        _list(price);
        vm.deal(buyer, uint256(price) + 1);
        vm.prank(buyer);
        m.buy{value: price}(1, price);
        assertEq(seller.balance + m.owed(fee) + m.owed(makeAddr("artist")), price);
    }

    // ------------------------------------------------------------------ stale listings (audit 3, finding 4)

    function _roundTrip() internal {
        address other = makeAddr("other");
        vm.prank(seller);
        st.transferFrom(seller, other, 1);
        assertFalse(m.isLive(1));
        vm.prank(other);
        st.transferFrom(other, seller, 1);
    }

    /// The token leaves the seller and comes back: the old listing must not be buyable at its old price forever.
    function test_staleListing_expires() public {
        _list(1 ether);
        _roundTrip();
        vm.warp(block.timestamp + 30 days);
        assertFalse(m.isLive(1), "a listing expires after the default 30 days");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "not for sale"));
        m.buy{value: 1 ether}(1, 1 ether);
    }

    function test_staleListing_cancelAllVoidsIt() public {
        _list(1 ether);
        _roundTrip();
        assertTrue(m.isLive(1), "within its expiry and before cancelAll, a round trip revives it (documented)");
        vm.prank(seller);
        m.cancelAll();
        assertFalse(m.isLive(1));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "not for sale"));
        m.buy{value: 1 ether}(1, 1 ether);
        vm.prank(seller);
        m.list(1, 2 ether); // re-listing after cancelAll works at the new counter
        assertTrue(m.isLive(1));
        (,,,, uint64 n) = m.listings(1);
        assertEq(n, 1);
    }

    function test_listFor_durationBounds() public {
        vm.startPrank(seller);
        st.setApprovalForAll(address(m), true);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "duration"));
        m.listFor(1, 1 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(StatementMarket.Bad.selector, "duration"));
        m.listFor(1, 1 ether, 180 days + 1);
        m.listFor(1, 1 ether, 1 hours);
        vm.stopPrank();
        (,,, uint64 exp,) = m.listings(1);
        assertEq(exp, block.timestamp + 1 hours);
        vm.warp(block.timestamp + 1 hours - 1);
        assertTrue(m.isLive(1));
        vm.warp(block.timestamp + 1);
        assertFalse(m.isLive(1));
        vm.prank(seller);
        m.listFor(1, 1 ether, 180 days);
        assertTrue(m.isLive(1));
    }

    /// A royaltyInfo that delegates (~100k gas) is honoured; the 10% cap still applies.
    function test_royalty_delegatingImplementationPaid() public {
        st.setRoyalty(makeAddr("artist"), 500);
        st.setBurn(45);
        _list(2 ether);
        vm.prank(buyer);
        m.buy{value: 2 ether}(1, 2 ether);
        assertEq(m.owed(makeAddr("artist")), 0.1 ether);
    }

    function test_royalty_tooHungryIgnored() public {
        st.setRoyalty(makeAddr("artist"), 500);
        st.setBurn(150); // ~330k gas: over the stipend, counted as no royalty, sale still completes
        _list(2 ether);
        vm.prank(buyer);
        m.buy{value: 2 ether}(1, 2 ether);
        assertEq(m.owed(makeAddr("artist")), 0);
        assertEq(st.ownerOf(1), buyer);
    }

    /// A listing on a burned token (ownerOf reverts) can be cleared by anyone, not only the seller.
    function test_cancel_burnedToken_clearableByAnyone() public {
        _list(1 ether);
        st.burn(1);
        assertFalse(m.isLive(1));
        vm.prank(makeAddr("anyone"));
        m.cancel(1);
        (address s_,,,,) = m.listings(1);
        assertEq(s_, address(0));
    }
}
