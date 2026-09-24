// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ICredits, ICreditArt, IStatement, IERC2981Like} from "./interfaces/IExternal.sol";
import {CreditKeys} from "./CreditKeys.sol";
import {CreditCards} from "./CreditCards.sol";

interface IFactory {
    function credits() external view returns (ICredits);
    function statement() external view returns (IStatement);
    function cards() external view returns (CreditCards);
    function feeRecipient() external view returns (address);
    function FEE_BPS() external view returns (uint16);
    function isValidFloor(uint256 floorWei, uint8 mode, uint64 issuedAt, bytes calldata sig) external view returns (bool);
}

/// @title Statement Maker party
/// @notice Pools 80 Credits, burns them into one Statement, sells it at the party's own ask, pays card holders.
///
/// Lifecycle: OPEN → FULL (80 deposited) → ASSEMBLED (burned, Statement held here) → SOLD.
///            OPEN or FULL past the deadline → EXPIRED (every Credit redeemable by its card holder).
///
/// Rules (all enforced here):
///  - Each deposited Credit mints one Credit Card to the depositor. The card's current holder has its vote, can
///    redeem its Credit while OPEN or EXPIRED, and claims 1/80 of the net sale.
///  - The host is the only arranger. Arrangement is fixed at creation. Auto presets: any card holder may burn with
///    an order the contract verifies. Manual: only the host may burn, with any order of exactly the 80.
///  - Only prices are voted on. A proposal passes with YES >= 41 of 80 and NO == 0; a price below the floor
///    needs 60. After 3 NO-blocked price proposals or 30 days without one executing, 54 YES passes and NO is
///    ignored (below-floor still needs 60). Weight = cards held at the block before the proposal. Windows are
///    24/48/72/168 hours; passed proposals must be executed within 7 days; executing one supersedes the rest.
///  - The Statement leaves only through buy(), at the current ask, no earlier than 24 hours after the ask went
///    live. No offers, auctions or other transfer path exist.
///  - Sale split: royalty (only if the Statement contract declares ERC-2981, capped at 10%), 1% fee, and the rest
///    in 80 equal shares; rounding dust goes to the fee recipient. Fee and royalty are pull payments.
contract Party is Initializable, ReentrancyGuardTransient {
    using CreditKeys for CreditKeys.Preset;

    uint256 public constant SLOTS = 80;
    uint256 public constant PASS = 41;
    uint256 public constant PASS_BELOW_FLOOR = 60;
    uint256 public constant PASS_DEADLOCK = 54;
    uint256 public constant DEADLOCK_BLOCKS = 3;
    uint256 public constant DEADLOCK_TIME = 30 days;
    uint256 public constant EXECUTE_WINDOW = 7 days;
    uint256 public constant BUY_DELAY = 24 hours;
    uint256 public constant FLOOR_MAX_AGE = 1 hours;
    uint256 public constant ROYALTY_CAP_BPS = 1000;
    uint256 public constant MAX_PROPOSALS = 256;
    uint256 public constant MAX_OPEN_PER_PROPOSER = 3;

    enum Status { OPEN, FULL, ASSEMBLED, SOLD, EXPIRED }
    enum PriceMode { Fixed, FloorPct, FloorDelta } // FloorPct value in basis points; FloorDelta in wei
    enum FloorMode { Avg24h, Latest }

    struct PriceSpec { PriceMode mode; int256 value; }
    struct Floor { uint256 floorWei; uint64 issuedAt; bytes sig; }

    struct Params {
        string name;
        string description;
        string filters; // human-readable eligibility rules; the Merkle root below is what is enforced
        bytes32 eligibleRoot; // leaf = keccak256(bytes.concat(keccak256(abi.encode(creditId)))); 0 = any Credit
        uint8 minDeposit; // 1..80
        uint32 durationDays; // 1..60, from creation to the burn deadline
        uint16 voteHours; // default window: 24, 48, 72 or 168
        CreditKeys.Preset arrangement;
        uint256 seed; // for Random
        PriceSpec defaultPrice;
        FloorMode floorMode;
    }

    struct Proposal {
        PriceSpec price; // LIST price, or ignored for CANCEL
        bool cancel; // CANCEL_LISTING
        address proposer;
        uint48 snapshot; // block whose balances are the vote weights
        uint64 endsAt;
        uint64 epoch; // price epoch at creation; executing any price decision bumps it
        bool deadlock; // created under the deadlock rule
        bool executed;
        uint128 yes;
        uint128 no;
    }

    IFactory public factory;
    ICredits public credits;
    CreditCards public cards;
    address public host;
    Params internal _params;
    uint64 public createdAt;
    uint64 public deadline;
    uint64 public fullAt;

    // deposits
    uint256[] internal _order; // credit ids in deposit order (compacted on redeem)
    mapping(uint256 creditId => uint256) public cardOfCredit; // 0 = not in this party
    mapping(uint256 cardId => uint256) public creditOfCard;

    // assembly and sale
    bool public assembled;
    uint256 public statementId;
    uint256[] internal _burnOrder;
    bool internal _assembling;
    uint256 public ask; // wei; 0 = not listed
    PriceSpec public askSpec;
    uint64 public askLiveAt;
    PriceSpec public pendingPrice; // price voted while FULL, applied at assembly
    bool public hasPendingPrice;
    bool public sold;
    uint256 public perCard;
    uint256 public cardsOutstanding; // cards not yet redeemed or claimed
    mapping(address => uint256) public owed; // pull payments: fee, royalty, dust

    // governance
    Proposal[] internal _proposals;
    mapping(uint256 id => mapping(address => uint8)) public voteOf; // 0 none, 1 yes, 2 no
    mapping(uint256 id => mapping(address => uint128)) public weightOf;
    uint64 public priceEpoch;
    uint64 public lastPriceExecutedAt;
    uint256 public blockedPriceProposals;
    mapping(uint256 id => bool) public blockedCounted;
    mapping(address => uint256) public openBy;
    mapping(uint256 id => bool) internal _openCounted;

    event Deposited(address indexed by, uint256 indexed creditId, uint256 indexed cardId);
    event Redeemed(address indexed to, uint256 indexed creditId, uint256 indexed cardId);
    event Assembled(address indexed by, uint256 indexed statementId, uint256[] order);
    event AskSet(uint256 ask, bool fromVote);
    event Proposed(uint256 indexed id, address indexed by, bool cancel, PriceMode mode, int256 value, uint64 endsAt, bool deadlock);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event Executed(uint256 indexed id, address indexed by);
    event Sold(address indexed buyer, uint256 price, uint256 royalty, uint256 fee, uint256 perCard);
    event Claimed(address indexed to, uint256 indexed cardId, uint256 amount);
    event HostTransferred(address indexed from, address indexed to);

    error Bad(string why);

    constructor() {
        _disableInitializers();
    }

    function initialize(address host_, Params calldata p) external initializer {
        factory = IFactory(msg.sender);
        credits = factory.credits();
        cards = factory.cards();
        if (host_ == address(0)) revert Bad("host");
        if (p.minDeposit == 0 || p.minDeposit > SLOTS) revert Bad("minDeposit");
        if (p.durationDays == 0 || p.durationDays > 60) revert Bad("duration");
        if (!_windowOk(p.voteHours)) revert Bad("voteHours");
        _checkPrice(p.defaultPrice);
        if (bytes(p.name).length == 0 || bytes(p.name).length > 60) revert Bad("name");
        if (bytes(p.description).length > 1000) revert Bad("description");
        host = host_;
        _params = p;
        createdAt = uint64(block.timestamp);
        deadline = uint64(block.timestamp + uint256(p.durationDays) * 1 days);
    }

    // ------------------------------------------------------------------ views

    function params() external view returns (Params memory) { return _params; }
    function depositOrder() external view returns (uint256[] memory) { return _order; }
    function burnOrder() external view returns (uint256[] memory) { return _burnOrder; }
    function count() public view returns (uint256) { return _order.length; }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function proposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }

    function status() public view returns (Status) {
        if (sold) return Status.SOLD;
        if (assembled) return Status.ASSEMBLED;
        if (block.timestamp > deadline) return Status.EXPIRED;
        return _order.length == SLOTS ? Status.FULL : Status.OPEN;
    }

    function cardView(uint256 cardId) external view returns (string memory name, uint256 creditId, string memory st) {
        Status s = status();
        st = s == Status.OPEN ? "FILLING" : s == Status.FULL ? "FULL" : s == Status.ASSEMBLED ? "STATEMENT MADE" : s == Status.SOLD ? "SOLD / CLAIMABLE" : "EXPIRED / REDEEMABLE";
        return (_params.name, creditOfCard[cardId], st);
    }

    // ------------------------------------------------------------------ deposits

    /// @notice Pull `ids` from the caller (needs setApprovalForAll on Credits for this party) and mint one card each.
    function deposit(uint256[] calldata ids, bytes32[][] calldata proofs) external nonReentrant {
        if (status() != Status.OPEN) revert Bad("not open");
        uint256 remaining = SLOTS - _order.length;
        uint256 min = _params.minDeposit < remaining ? _params.minDeposit : remaining;
        if (ids.length < min || ids.length > remaining || ids.length == 0) revert Bad("count");
        if (_params.eligibleRoot != bytes32(0) && proofs.length != ids.length) revert Bad("proofs");
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (cardOfCredit[id] != 0) revert Bad("duplicate");
            if (_params.eligibleRoot != bytes32(0)) {
                bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(id))));
                if (!MerkleProof.verifyCalldata(proofs[i], _params.eligibleRoot, leaf)) revert Bad("not eligible");
            }
            credits.transferFrom(msg.sender, address(this), id); // reverts unless the caller owns it and approved us
            if (credits.ownerOf(id) != address(this)) revert Bad("not received");
            uint256 card = cards.mint(msg.sender);
            cardOfCredit[id] = card;
            creditOfCard[card] = id;
            _order.push(id);
            ++cardsOutstanding;
            emit Deposited(msg.sender, id, card);
        }
        if (_order.length == SLOTS) fullAt = uint64(block.timestamp);
    }

    /// @notice The card's holder takes its Credit back (card burned). Allowed while OPEN, and after EXPIRED.
    function redeem(uint256[] calldata cardIds) external nonReentrant {
        for (uint256 i; i < cardIds.length; ++i) _redeem(cardIds[i], msg.sender);
    }

    /// @notice After expiry anyone may push a card's Credit to the card's current holder.
    function redeemFor(uint256[] calldata cardIds) external nonReentrant {
        if (status() != Status.EXPIRED) revert Bad("not expired");
        for (uint256 i; i < cardIds.length; ++i) _redeem(cardIds[i], cards.ownerOf(cardIds[i]));
    }

    function _redeem(uint256 cardId, address holder) internal {
        Status s = status();
        if (s != Status.OPEN && s != Status.EXPIRED) revert Bad("locked");
        if (cards.partyOf(cardId) != address(this) || cards.ownerOf(cardId) != holder) revert Bad("not holder");
        uint256 id = creditOfCard[cardId];
        delete creditOfCard[cardId];
        delete cardOfCredit[id];
        _removeFromOrder(id);
        --cardsOutstanding;
        cards.burn(cardId);
        credits.transferFrom(address(this), holder, id); // plain transfer: no receiver callback
        emit Redeemed(holder, id, cardId);
    }

    function _removeFromOrder(uint256 id) internal {
        uint256 n = _order.length;
        for (uint256 i; i < n; ++i) {
            if (_order[i] == id) {
                for (uint256 j = i; j + 1 < n; ++j) _order[j] = _order[j + 1];
                _order.pop();
                return;
            }
        }
        revert Bad("missing");
    }

    // ------------------------------------------------------------------ arrange + burn (one step)

    /// @notice Burn the 80 into one Statement with `order`. Manual: host only, any order of exactly the 80.
    ///         Auto presets: any card holder; `order` must be exactly what the preset produces.
    function assemble(uint256[] calldata order, Floor calldata floor) external nonReentrant {
        if (status() != Status.FULL) revert Bad("not full");
        CreditKeys.Preset p = _params.arrangement;
        if (p == CreditKeys.Preset.Manual) {
            if (msg.sender != host) revert Bad("host only");
        } else if (cards.heldNow(address(this), msg.sender) == 0) {
            revert Bad("card holders only");
        }
        _checkPermutation(order);
        if (p != CreditKeys.Preset.Manual) _checkPreset(p, order);

        // Price that goes live: the one voted while FULL, else the host default. Resolve before external calls.
        PriceSpec memory spec = hasPendingPrice ? pendingPrice : _params.defaultPrice;
        uint256 price = _resolve(spec, floor);

        // Effects
        assembled = true;
        _burnOrder = order;
        ask = price;
        askSpec = spec;
        askLiveAt = uint64(block.timestamp);
        ++priceEpoch; // proposals made before the burn are superseded

        // Interactions: approve the Statement contract for this call only, then verify the outcome.
        IStatement st = factory.statement();
        credits.setApprovalForAll(address(st), true);
        _assembling = true;
        uint256 sid = st.make(order);
        _assembling = false;
        credits.setApprovalForAll(address(st), false);
        if (st.ownerOf(sid) != address(this)) revert Bad("statement not received");
        for (uint256 i; i < SLOTS; ++i) {
            // every Credit must be gone from this contract (burned by the Statement contract)
            try credits.ownerOf(order[i]) returns (address o) { if (o == address(this)) revert Bad("not burned"); } catch {}
        }
        statementId = sid;
        emit Assembled(msg.sender, sid, order);
        emit AskSet(price, hasPendingPrice);
    }

    function _checkPermutation(uint256[] calldata order) internal view {
        if (order.length != SLOTS) revert Bad("length");
        uint256[3] memory seen; // 80 bits needed; indexes are deposit positions
        for (uint256 i; i < SLOTS; ++i) {
            uint256 card = cardOfCredit[order[i]];
            if (card == 0) revert Bad("not deposited");
            uint256 pos = _positionOf(order[i]);
            uint256 w = pos >> 8;
            uint256 bit = 1 << (pos & 255);
            if (seen[w] & bit != 0) revert Bad("repeat");
            seen[w] |= bit;
        }
    }

    function _positionOf(uint256 id) internal view returns (uint256) {
        for (uint256 i; i < SLOTS; ++i) if (_order[i] == id) return i;
        revert Bad("missing");
    }

    function _checkPreset(CreditKeys.Preset p, uint256[] calldata order) internal view {
        if (p == CreditKeys.Preset.Deposit) {
            for (uint256 i; i < SLOTS; ++i) if (order[i] != _order[i]) revert Bad("order");
            return;
        }
        if (p == CreditKeys.Preset.Random) {
            uint256[] memory want = CreditKeys.shuffle(_order, _params.seed);
            for (uint256 i; i < SLOTS; ++i) if (order[i] != want[i]) revert Bad("order");
            return;
        }
        ICreditArt art = ICreditArt(credits.art());
        uint256 prev = p.key(credits, art, order[0]);
        for (uint256 i = 1; i < SLOTS; ++i) {
            uint256 k = p.key(credits, art, order[i]);
            if (k <= prev) revert Bad("order");
            prev = k;
        }
    }

    /// @notice The Statement contract may mint with a safe-transfer callback, but only during assemble().
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_assembling || msg.sender != address(factory.statement())) revert Bad("unexpected token");
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ price governance

    function propose(PriceSpec calldata price, bool cancel, uint16 hours_) external returns (uint256 id) {
        Status s = status();
        if (cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status");
        if (cancel && ask == 0) revert Bad("not listed");
        if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only");
        if (_proposals.length >= MAX_PROPOSALS) revert Bad("too many");
        _refreshOpen(msg.sender);
        if (openBy[msg.sender] >= MAX_OPEN_PER_PROPOSER) revert Bad("open limit");
        if (!cancel) _checkPrice(price);
        uint16 h = hours_ == 0 ? _params.voteHours : hours_;
        if (!_windowOk(h)) revert Bad("window");
        id = _proposals.length;
        bool dl = _deadlocked();
        _proposals.push(Proposal({
            price: price, cancel: cancel, proposer: msg.sender, snapshot: uint48(block.number - 1),
            endsAt: uint64(block.timestamp + uint256(h) * 1 hours), epoch: priceEpoch, deadlock: dl,
            executed: false, yes: 0, no: 0
        }));
        ++openBy[msg.sender];
        _openCounted[id] = true;
        emit Proposed(id, msg.sender, cancel, price.mode, price.value, _proposals[id].endsAt, dl);
        _vote(id, msg.sender, true);
    }

    function vote(uint256 id, bool support) external {
        _vote(id, msg.sender, support);
    }

    function _vote(uint256 id, address voter, bool support) internal {
        Proposal storage p = _proposals[id];
        if (block.timestamp >= p.endsAt) revert Bad("closed");
        uint128 w = weightOf[id][voter];
        if (w == 0) {
            w = uint128(cards.heldAt(address(this), voter, p.snapshot));
            if (w == 0) revert Bad("no weight at snapshot");
            weightOf[id][voter] = w;
        }
        uint8 prev = voteOf[id][voter];
        if (prev == 1) p.yes -= w; else if (prev == 2) p.no -= w;
        if (support) p.yes += w; else p.no += w;
        voteOf[id][voter] = support ? 1 : 2;
        emit Voted(id, voter, support, w);
    }

    /// @notice YES needed for proposal `id`, given a floor reading for below-floor checks.
    function needFor(uint256 id, uint256 price, uint256 floorWei) public view returns (uint256) {
        Proposal storage p = _proposals[id];
        uint256 need = (!p.cancel && price < floorWei) ? PASS_BELOW_FLOOR : PASS;
        if (p.deadlock && need < PASS_DEADLOCK) need = PASS_DEADLOCK;
        return need;
    }

    function execute(uint256 id, Floor calldata floor) external nonReentrant {
        Proposal storage p = _proposals[id];
        Status s = status();
        if (p.executed) revert Bad("executed");
        if (block.timestamp < p.endsAt) revert Bad("voting open");
        if (block.timestamp > uint256(p.endsAt) + EXECUTE_WINDOW) revert Bad("lapsed");
        if (p.epoch != priceEpoch) revert Bad("superseded");
        if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only");
        if (p.cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status");

        uint256 price;
        uint256 floorWei;
        if (!p.cancel) {
            floorWei = _floor(floor);
            price = _resolveWith(p.price, floorWei);
        }
        uint256 need = needFor(id, price, floorWei);
        if (p.yes < need || (p.no > 0 && !p.deadlock)) revert Bad("did not pass");

        p.executed = true;
        ++priceEpoch;
        lastPriceExecutedAt = uint64(block.timestamp);
        if (p.cancel) {
            ask = 0;
            askLiveAt = 0;
        } else if (s == Status.FULL) {
            pendingPrice = p.price;
            hasPendingPrice = true;
        } else {
            ask = price;
            askSpec = p.price;
            askLiveAt = uint64(block.timestamp);
            emit AskSet(price, true);
        }
        emit Executed(id, msg.sender);
    }

    /// @notice Records a closed price proposal that was blocked by NO, toward the deadlock rule. Anyone may call.
    function countBlocked(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock) revert Bad("not blocked");
        blockedCounted[id] = true;
        ++blockedPriceProposals;
    }

    function _deadlocked() internal view returns (bool) {
        if (blockedPriceProposals >= DEADLOCK_BLOCKS) return true;
        uint256 since = lastPriceExecutedAt != 0 ? lastPriceExecutedAt : (fullAt != 0 ? fullAt : type(uint64).max);
        return since != type(uint64).max && block.timestamp > since + DEADLOCK_TIME;
    }

    function _refreshOpen(address who) internal {
        // decrement the proposer's open count for proposals that have closed (bounded by MAX_PROPOSALS)
        uint256 n = _proposals.length;
        for (uint256 i; i < n && openBy[who] > 0; ++i) {
            if (_openCounted[i] && _proposals[i].proposer == who && block.timestamp >= _proposals[i].endsAt) {
                _openCounted[i] = false;
                --openBy[who];
            }
        }
    }

    /// @notice A floor-relative ask may only rise, with a fresh signed floor reading. Anyone may call.
    function raiseAsk(Floor calldata floor) external {
        if (status() != Status.ASSEMBLED || ask == 0 || askSpec.mode == PriceMode.Fixed) revert Bad("fixed");
        uint256 next = _resolve(askSpec, floor);
        if (next <= ask) revert Bad("not higher");
        ask = next;
        emit AskSet(next, false);
    }

    // ------------------------------------------------------------------ sale + claims

    /// @notice Buy the Statement at the current ask. `maxPrice` protects against an ask change in the same block.
    function buy(uint256 maxPrice) external payable nonReentrant {
        if (status() != Status.ASSEMBLED || ask == 0) revert Bad("not for sale");
        if (block.timestamp < uint256(askLiveAt) + BUY_DELAY) revert Bad("not open yet");
        uint256 price = ask;
        if (price > maxPrice || msg.value < price) revert Bad("price");

        uint256 royalty;
        address royaltyTo;
        try IERC2981Like(address(factory.statement())).royaltyInfo{gas: 50_000}(statementId, price) returns (address r, uint256 amt) {
            uint256 cap = price * ROYALTY_CAP_BPS / 10_000;
            if (r != address(0)) { royaltyTo = r; royalty = amt > cap ? cap : amt; }
        } catch {}
        uint256 fee = price * factory.FEE_BPS() / 10_000;
        uint256 pot = price - royalty - fee;
        uint256 share = pot / SLOTS;
        uint256 dust = pot - share * SLOTS;

        sold = true;
        perCard = share;
        ask = 0;
        if (royalty > 0) owed[royaltyTo] += royalty;
        owed[factory.feeRecipient()] += fee + dust;

        factory.statement().transferFrom(address(this), msg.sender, statementId);
        if (msg.value > price) {
            (bool ok,) = msg.sender.call{value: msg.value - price}("");
            if (!ok) revert Bad("refund");
        }
        emit Sold(msg.sender, price, royalty, fee, share);
    }

    /// @notice The holder of each card claims 1/80 of the net sale; the card is burned.
    function claim(uint256[] calldata cardIds) external nonReentrant {
        if (!sold) revert Bad("not sold");
        uint256 total;
        for (uint256 i; i < cardIds.length; ++i) {
            uint256 c = cardIds[i];
            if (cards.partyOf(c) != address(this) || cards.ownerOf(c) != msg.sender) revert Bad("not holder");
            delete creditOfCard[c];
            --cardsOutstanding;
            cards.burn(c);
            total += perCard;
            emit Claimed(msg.sender, c, perCard);
        }
        (bool ok,) = msg.sender.call{value: total}("");
        if (!ok) revert Bad("send");
    }

    /// @notice Pull payment for the fee recipient, royalty receiver, and rounding dust.
    function withdraw() external nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert Bad("nothing");
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert Bad("send");
    }

    function transferHost(address to) external {
        if (msg.sender != host || to == address(0)) revert Bad("host");
        emit HostTransferred(host, to);
        host = to;
    }

    // ------------------------------------------------------------------ prices and floor

    function _checkPrice(PriceSpec memory p) internal pure {
        if (p.mode == PriceMode.Fixed && (p.value <= 0 || p.value > 1e24)) revert Bad("price");
        if (p.mode == PriceMode.FloorPct && (p.value <= -10_000 || p.value > 1_000_000)) revert Bad("price");
        if (p.mode == PriceMode.FloorDelta && (p.value < -1e24 || p.value > 1e24)) revert Bad("price");
    }

    function _floor(Floor calldata f) internal view returns (uint256) {
        if (f.issuedAt > block.timestamp || block.timestamp - f.issuedAt > FLOOR_MAX_AGE) revert Bad("stale floor");
        if (!factory.isValidFloor(f.floorWei, uint8(_params.floorMode), f.issuedAt, f.sig)) revert Bad("floor sig");
        if (f.floorWei == 0) revert Bad("floor");
        return f.floorWei;
    }

    function _resolve(PriceSpec memory p, Floor calldata f) internal view returns (uint256) {
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        return _resolveWith(p, _floor(f));
    }

    function _resolveWith(PriceSpec memory p, uint256 floorWei) internal pure returns (uint256 v) {
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        int256 f = int256(floorWei);
        int256 r = p.mode == PriceMode.FloorPct ? f * (10_000 + p.value) / 10_000 : f + p.value;
        if (r <= 0) revert Bad("price <= 0");
        return uint256(r);
    }

    function _windowOk(uint16 h) internal pure returns (bool) {
        return h == 24 || h == 48 || h == 72 || h == 168;
    }

    receive() external payable {
        revert Bad("no direct ETH");
    }
}
