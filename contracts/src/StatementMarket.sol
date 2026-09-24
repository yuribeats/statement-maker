// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IERC721Min {
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id) external;
}

/// @title Statement Market
/// @notice Fixed-price listings for any Statement, by whoever owns it. The Statement stays in the seller's wallet
///         until sold: the seller approves this market once, and a listing is void as soon as the seller no longer
///         owns the token. Asks only: no offers, no auctions.
///         Sale split: royalty (only if the Statement contract declares ERC-2981, capped at 10%), 1% fee, the rest to
///         the seller. The seller is paid directly; if that transfer fails the amount is held for withdrawal, so a
///         seller cannot block their own sale path. Fee and royalty are always pull payments.
///         No owner, no admin, no upgrade path.
contract StatementMarket is ReentrancyGuardTransient {
    IERC721Min public immutable statement;
    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 100;
    uint256 public constant ROYALTY_CAP_BPS = 1000;

    struct Listing {
        address seller;
        uint96 price; // wei; up to ~79 billion ETH
        uint64 listedAt;
    }

    mapping(uint256 tokenId => Listing) public listings;
    mapping(address => uint256) public owed;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 royalty, uint256 fee);
    event Withdrawn(address indexed to, uint256 amount);

    error Bad(string why);

    constructor(IERC721Min statement_, address feeRecipient_) {
        if (address(statement_) == address(0) || feeRecipient_ == address(0)) revert Bad("zero");
        statement = statement_;
        feeRecipient = feeRecipient_;
    }

    /// @notice List (or re-price) a Statement you own. This market must be approved for it.
    function list(uint256 tokenId, uint96 price) external {
        if (price == 0) revert Bad("price");
        if (statement.ownerOf(tokenId) != msg.sender) revert Bad("not owner");
        if (!_approved(msg.sender, tokenId)) revert Bad("approve the market first");
        listings[tokenId] = Listing(msg.sender, price, uint64(block.timestamp));
        emit Listed(tokenId, msg.sender, price);
    }

    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        // The seller can cancel; anyone can clear a listing whose seller no longer owns the token.
        if (l.seller == address(0)) revert Bad("not listed");
        if (msg.sender != l.seller && statement.ownerOf(tokenId) == l.seller) revert Bad("not seller");
        delete listings[tokenId];
        emit Cancelled(tokenId, l.seller);
    }

    /// @notice A listing is live only while its seller still owns the token and this market is still approved.
    function isLive(uint256 tokenId) public view returns (bool) {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) return false;
        try statement.ownerOf(tokenId) returns (address o) { return o == l.seller && _approved(o, tokenId); } catch { return false; }
    }

    /// @notice Buy at the listed price. `maxPrice` protects against a re-price landing first.
    function buy(uint256 tokenId, uint256 maxPrice) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0) || !isLive(tokenId)) revert Bad("not for sale");
        uint256 price = l.price;
        if (price > maxPrice || msg.value < price) revert Bad("price");
        if (msg.sender == l.seller) revert Bad("own listing");

        (address royaltyTo, uint256 royalty) = _royalty(tokenId, price);
        uint256 fee = price * FEE_BPS / 10_000;
        uint256 toSeller = price - royalty - fee;

        delete listings[tokenId];
        if (royalty > 0) owed[royaltyTo] += royalty;
        owed[feeRecipient] += fee;

        statement.safeTransferFrom(l.seller, msg.sender, tokenId);
        (bool ok,) = l.seller.call{value: toSeller, gas: 50_000}("");
        if (!ok) owed[l.seller] += toSeller;
        if (msg.value > price) {
            (bool r,) = msg.sender.call{value: msg.value - price}("");
            if (!r) revert Bad("refund");
        }
        emit Sold(tokenId, l.seller, msg.sender, price, royalty, fee);
    }

    function withdraw() external nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert Bad("nothing");
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert Bad("send");
        emit Withdrawn(msg.sender, amt);
    }

    function _approved(address owner, uint256 tokenId) internal view returns (bool) {
        return statement.isApprovedForAll(owner, address(this)) || statement.getApproved(tokenId) == address(this);
    }

    /// @dev Raw staticcall so a malformed or reverting royaltyInfo never blocks a sale (see audit finding T-5/F4).
    function _royalty(uint256 tokenId, uint256 price) internal view returns (address to, uint256 amt) {
        (bool ok, bytes memory r) = address(statement).staticcall{gas: 50_000}(abi.encodeWithSignature("royaltyInfo(uint256,uint256)", tokenId, price));
        if (!ok || r.length < 64) return (address(0), 0);
        (uint256 a, uint256 v) = abi.decode(r, (uint256, uint256));
        if (a == 0 || a >> 160 != 0) return (address(0), 0);
        uint256 cap = price * ROYALTY_CAP_BPS / 10_000;
        return (address(uint160(a)), v > cap ? cap : v);
    }

    receive() external payable {
        revert Bad("no direct ETH");
    }
}
