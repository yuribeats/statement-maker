// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ICredits, IStatement, ICreditTraits} from "./interfaces/IExternal.sol";
import {CreditKeys} from "./CreditKeys.sol";
import {CreditCards} from "./CreditCards.sol";

interface IFactory {
    function credits() external view returns (ICredits);
    function statement() external view returns (IStatement);
    function cards() external view returns (CreditCards);
    function feeRecipient() external view returns (address);
    function FEE_BPS() external view returns (uint16);
    function timeUnit() external view returns (uint256);
    function traits() external view returns (ICreditTraits);
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
///  - Arrangement is fixed at creation (the site defaults to Time). Auto presets: once FULL, any card holder may burn
///    with the order the contract verifies. Manual: only the host may burn, with any order of exactly the 80, within
///    MANUAL_GRACE (1 day) of filling; after that the host has no say and any card holder may burn in Time order.
///  - Host powers: the params at creation, the Manual order and burn inside MANUAL_GRACE, transferHost. Nothing else.
///  - Only prices are voted on. A proposal passes with YES >= 41 of 80 and NO == 0; a price below the floor
///    needs 60. After 3 NO-blocked price proposals or 30 days without one executing, 54 YES passes and NO is
///    ignored (below-floor still needs 60). Weight = cards held at the block before the proposal. Windows are
///    1/24/48/72/168 hours; passed proposals must be executed within 7 days; executing one supersedes the rest.
///  - The Statement leaves only through buy(), at the current ask, once that price's wait has passed (voted with
///    the price; the host sets the default, 0..72 hours). No offers, auctions or other transfer path exist.
///  - Sale split: 1% fee, and the rest in 80 equal shares; rounding dust goes to the fee recipient (pull payment).
///    No creator royalty is paid (the Sold event keeps its royalty field for indexers; it is always 0).
contract Party is Initializable, ReentrancyGuardTransient {
    using CreditKeys for CreditKeys.Preset;

    uint256 public constant SLOTS = 80;
    uint256 public constant PASS = 41;
    uint256 public constant PASS_BELOW_FLOOR = 60;
    uint256 public constant PASS_DEADLOCK = 54;
    uint256 public constant DEADLOCK_BLOCKS = 3;
    uint256 public constant DEADLOCK_TIME = 30 days;
    uint256 public constant EXECUTE_WINDOW = 7 days;
    uint256 public constant MAX_BUY_DELAY_HOURS = 72; // a price's wait before buying opens is voted with the price (host default at creation)
    uint256 public constant FILL_GRACE = 2 days; // filling always leaves at least this long to burn
    uint256 public constant MANUAL_GRACE = 1 days; // a Manual host's time to burn after FULL; then anyone, Time order
    /// @notice A signed floor reading is accepted for 10 minutes (real time), and never one older than the last used here.
    uint256 public constant FLOOR_MAX_AGE = 10 minutes;
    uint256 public constant MAX_OPEN_PER_PROPOSER = 3;
    uint256 public constant BURN_CANDIDATES = 8; // the burn judges at most the 8 latest LISTs to reach 41 YES (per epoch)

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
        uint16 voteHours; // default window: 1, 24, 48, 72 or 168
        CreditKeys.Preset arrangement;
        uint256 seed; // for Random
        PriceSpec defaultPrice;
        FloorMode floorMode;
        uint256 minAskWei; // lowest ask any FLOOR-RELATIVE price can resolve to (required > 0 if the default is floor-relative).
                           // It never bounds a Fixed price: 41 (60 below the floor) can still vote any fixed price.
        uint16 buyDelayHours; // default wait between a price going live and buying opening, 0..72; at least 1 for a
                              // floor-relative price, so a stale-low reading can be raised (raiseAsk) before anyone can buy
    }

    struct Proposal {
        PriceSpec price; // LIST price, or ignored for CANCEL
        bool cancel; // CANCEL_LISTING
        address proposer;
        uint48 snapshot; // block whose balances are the vote weights
        uint64 endsAt;
        uint16 buyDelayHours; // wait before buying opens once this price goes live (voted with the price)
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
    uint64 public assembledAt;
    uint64 public lastFloorAt; // floor readings may never go back in time
    uint64 public fullBlock; // block in which slot 80 was filled; proposals open from the next block (vote snapshot = block - 1)
    /// @notice Seconds per "hour" for every rule window (buy delay, votes, lapse, deadlock, deadline). 3600 on mainnet;
    ///         a testnet factory may set it lower so a full party can be rehearsed in minutes. Floor-signature age is
    ///         always real time.
    uint256 public timeUnit;

    // deposits
    uint256[] internal _order; // credit ids in deposit order (compacted on redeem)
    mapping(uint256 creditId => uint256) public cardOfCredit; // 0 = not in this party
    mapping(uint256 cardId => uint256) public creditOfCard;

    // assembly and sale
    bool public assembled;
    uint256 public statementId;
    bytes32 public burnOrderHash; // keccak256(abi.encodePacked(order)); the order itself is in the Assembled event
    bool internal _assembling;
    uint256 public ask; // wei; 0 = not listed
    PriceSpec public askSpec;
    uint64 public askLiveAt;
    uint64 public buyableAt; // buying opens at this time
    uint256 internal _pendingId; // the LIST executed while FULL (re-judged at the burn floor)
    PriceSpec public pendingPrice; // price executed while FULL; applied at assembly only if it still passes there
    bool public hasPendingPrice;
    bool public sold;
    uint256 public perCard;
    uint256 public cardsOutstanding; // cards not yet redeemed or claimed
    mapping(address => uint256) public owed; // pull payments: fee + dust, and holders that could not receive ETH

    // governance
    Proposal[] internal _proposals;
    mapping(uint256 id => mapping(address => uint8)) public voteOf; // 0 none, 1 yes, 2 no
    mapping(uint256 id => mapping(address => uint128)) public weightOf;
    uint64 public priceEpoch;
    uint64 public lastPriceExecutedAt;
    uint256 public blockedPriceProposals;
    mapping(uint256 id => bool) public blockedCounted;
    mapping(address => uint256[]) internal _openIds;
    mapping(uint64 epoch => uint256[]) internal _passedIds; // LISTs that reached 41 YES while FULL, in that order
    mapping(uint256 id => bool) internal _listed; // each proposer's open proposals (at most MAX_OPEN_PER_PROPOSER)

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
    event BlockedCounted(uint256 indexed id, uint256 total);
    event PendingPriceSet(uint256 indexed id, PriceMode mode, int256 value);
    event Withdrawn(address indexed to, uint256 amount);

    error Bad(string why);

    constructor() {
        _disableInitializers();
    }

    function initialize(address host_, Params calldata p) external initializer {
        factory = IFactory(msg.sender);
        credits = factory.credits();
        cards = factory.cards();
        timeUnit = factory.timeUnit();
        if (timeUnit == 0 || timeUnit > 1 hours) revert Bad("timeUnit");
        if (host_ == address(0)) revert Bad("host");
        if (p.minDeposit == 0 || p.minDeposit > SLOTS) revert Bad("minDeposit");
        if (p.durationDays == 0 || p.durationDays > 60) revert Bad("duration");
        if (!_windowOk(p.voteHours)) revert Bad("voteHours");
        _checkPrice(p.defaultPrice);
        if (p.defaultPrice.mode != PriceMode.Fixed && p.minAskWei == 0) revert Bad("minAsk");
        if (!_delayOk(p.defaultPrice.mode, p.buyDelayHours)) revert Bad("buyDelay");
        if (bytes(p.name).length == 0 || bytes(p.name).length > 60) revert Bad("name");
        if (bytes(p.description).length > 1000) revert Bad("description");
        host = host_;
        _params = p;
        createdAt = uint64(block.timestamp);
        deadline = uint64(block.timestamp + _t(uint256(p.durationDays) * 1 days));
    }

    // ------------------------------------------------------------------ views

    function params() external view returns (Params memory) { return _params; }
    function depositOrder() external view returns (uint256[] memory) { return _order; }
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

    /// @notice Records a deposit the factory has just moved here: `from` (the factory's caller) sent `ids` to this party
    ///         through PartyFactory.createParty (the host's opening deposit) or PartyFactory.deposit. Users approve only
    ///         the factory on Credits, never a party. Mints one card per Credit to `from`.
    function onDeposit(address from, uint256[] calldata ids, bytes32[][] calldata proofs) external nonReentrant {
        if (msg.sender != address(factory)) revert Bad("factory only");
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
            if (credits.ownerOf(id) != address(this)) revert Bad("not received"); // the factory moved it from `from`
            uint256 card = cards.mint(from);
            cardOfCredit[id] = card;
            creditOfCard[card] = id;
            _order.push(id);
            ++cardsOutstanding;
            emit Deposited(from, id, card);
        }
        if (_order.length == SLOTS) {
            fullAt = uint64(block.timestamp);
            fullBlock = uint64(block.number);
            uint256 grace = block.timestamp + _t(FILL_GRACE);
            if (deadline < grace) deadline = uint64(grace);
        }
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

    /// @notice Burn the 80 into one Statement with `order`. Auto presets: any card holder; `order` must be exactly what
    ///         the preset produces. Manual: the host, any order of exactly the 80, until MANUAL_GRACE after FULL; from
    ///         then on any card holder (the host too, only as a holder) with the Time order, so a host cannot stall.
    function assemble(uint256[] calldata order, Floor calldata floor) external nonReentrant {
        if (status() != Status.FULL) revert Bad("not full");
        CreditKeys.Preset p = _params.arrangement;
        if (p == CreditKeys.Preset.Manual && block.timestamp <= fullAt + _t(MANUAL_GRACE)) {
            if (msg.sender != host) revert Bad("host only");
        } else {
            if (p == CreditKeys.Preset.Manual) p = CreditKeys.Preset.Time;
            if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only");
        }
        CreditKeys.verifyOrder(p, factory.traits(), _order, cardOfCredit, order, _params.seed);

        // Price that goes live, every voted price judged again at THIS burn's floor (Pashov H2, M-1, M-2): the newest
        // (highest id) current-epoch LIST among the latest BURN_CANDIDATES to reach 41 YES that is closed, inside its
        // execute window and still passes here (applied as if executed); else the LIST executed while FULL if it
        // still passes here; else the host default. Bounded work: at most BURN_CANDIDATES + 1 judgements.
        (bool voted, uint256 vid, uint256 vprice) = _burnPrice(floor);
        PriceSpec memory spec;
        uint256 price;
        uint256 wait;
        if (voted) {
            Proposal storage q = _proposals[vid];
            if (!q.executed) {
                q.executed = true;
                lastPriceExecutedAt = uint64(block.timestamp);
                blockedPriceProposals = 0;
                emit Executed(vid, msg.sender);
            }
            spec = q.price;
            price = vprice;
            wait = q.buyDelayHours;
        } else {
            spec = _params.defaultPrice;
            price = _resolve(spec, floor);
            wait = _params.buyDelayHours;
        }
        if (wait == 0) wait = 1;

        // Effects
        assembled = true;
        assembledAt = uint64(block.timestamp);
        burnOrderHash = keccak256(abi.encodePacked(order));
        ask = price;
        askSpec = spec;
        askLiveAt = uint64(block.timestamp);
        buyableAt = uint64(block.timestamp + _t(wait * 1 hours));
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
            // Every Credit must be burned: Credits.ownerOf reverts with ERC721NonexistentToken for a burned id. A Credit
            // that still has any owner (a Statement contract that kept or moved it) fails, and so does any other revert.
            try credits.ownerOf(order[i]) returns (address) { revert Bad("not burned"); }
            catch (bytes memory r) { if (bytes4(r) != 0x7e273289) revert Bad("not burned"); } // ERC721NonexistentToken(uint256)
        }
        statementId = sid;
        emit Assembled(msg.sender, sid, order);
        emit AskSet(price, voted);
    }

    /// @dev See assemble(). Candidates are recorded in _vote when a LIST first reaches 41 YES while FULL; only holders
    ///      of 41 votes can add one, and only the latest BURN_CANDIDATES are judged, so proposal spam cannot make the
    ///      burn expensive. A Fixed candidate that could pass above the floor cannot be skipped by omitting the floor
    ///      reading ("floor needed").
    function _burnPrice(Floor calldata floor) internal returns (bool found, uint256 id, uint256 price) {
        uint256[] storage c = _passedIds[priceEpoch];
        uint256 n = c.length;
        for (uint256 i = n; i > (n > BURN_CANDIDATES ? n - BURN_CANDIDATES : 0); --i) {
            uint256 cid = c[i - 1];
            Proposal storage q = _proposals[cid];
            if ((found && cid < id) || q.executed || block.timestamp < q.endsAt || block.timestamp > uint256(q.endsAt) + _t(EXECUTE_WINDOW)) continue;
            (bool ok, uint256 pr) = _passesHere(cid, floor);
            if (ok) (found, id, price) = (true, cid, pr);
        }
        if (!found && hasPendingPrice) {
            (bool ok, uint256 pr) = _passesHere(_pendingId, floor);
            if (ok) (found, id, price) = (true, _pendingId, pr);
        }
    }

    /// @dev Whether LIST `id` passes with its final tally at this price/floor (as execute() judges), and its price.
    function _passesHere(uint256 id, Floor calldata floor) internal returns (bool, uint256) {
        Proposal storage q = _proposals[id];
        if ((q.no > 0 && !q.deadlock) || q.yes < PASS) return (false, 0); // cannot pass at any floor
        (uint256 price, uint256 floorWei) = _judgePrice(q.price, floor);
        if (q.yes >= needFor(id, price, floorWei)) return (true, price);
        if (floor.sig.length == 0) revert Bad("floor needed");
        return (false, 0);
    }

    /// @dev A LIST price and the floor it is judged against, as execute() does: with no floor reading a Fixed price is
    ///      treated as below the floor; a floor-relative price needs a valid reading.
    function _judgePrice(PriceSpec memory ps, Floor calldata floor) internal returns (uint256 price, uint256 floorWei) {
        if (ps.mode == PriceMode.Fixed && floor.sig.length == 0) return (uint256(ps.value), type(uint256).max);
        floorWei = _floor(floor);
        price = ps.mode == PriceMode.Fixed ? uint256(ps.value) : _clampMin(_resolveWith(ps, floorWei));
    }

    /// @notice The Statement contract may mint with a safe-transfer callback, but only during assemble().
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_assembling || msg.sender != address(factory.statement())) revert Bad("unexpected token");
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ price governance

    /// @param buyDelayHours for a price: the wait (0..72 hours) before buying opens once it goes live; ignored for cancels.
    function propose(PriceSpec calldata price, bool cancel, uint16 hours_, uint16 buyDelayHours) external returns (uint256 id) {
        Status s = status();
        if (cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status");
        if (cancel && ask == 0) revert Bad("not listed");
        if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only");
        // The snapshot is block - 1: in the fill block the last depositors' cards would carry no weight (Pashov L4).
        if (block.number <= fullBlock) revert Bad("just filled");
        _refreshOpen(msg.sender);
        if (_openIds[msg.sender].length >= MAX_OPEN_PER_PROPOSER) revert Bad("open limit");
        if (!cancel) _checkPrice(price);
        // A floor-relative price needs the host's minimum ask as a lower bound (limits a bad or compromised floor reading).
        if (!cancel && price.mode != PriceMode.Fixed && _params.minAskWei == 0) revert Bad("minAsk");
        if (!cancel && !_delayOk(price.mode, buyDelayHours)) revert Bad("buyDelay");
        uint16 h = cancel ? 24 : (hours_ == 0 ? _params.voteHours : hours_); // cancels always run 24h
        if (!_windowOk(h)) revert Bad("window");
        id = _proposals.length;
        bool dl = _deadlocked();
        _proposals.push(Proposal({
            price: price, cancel: cancel, proposer: msg.sender, snapshot: uint48(block.number - 1),
            endsAt: uint64(block.timestamp + _t(uint256(h) * 1 hours)), buyDelayHours: cancel ? 0 : buyDelayHours, epoch: priceEpoch, deadlock: dl,
            executed: false, yes: 0, no: 0
        }));
        _openIds[msg.sender].push(id);
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
        // A LIST reaching 41 YES before the burn becomes a burn candidate (once; see _burnPrice).
        if (!assembled && !p.cancel && p.yes >= PASS && !_listed[id]) {
            _listed[id] = true;
            _passedIds[p.epoch].push(id);
        }
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
        if (block.timestamp > uint256(p.endsAt) + _t(EXECUTE_WINDOW)) revert Bad("lapsed");
        if (p.epoch != priceEpoch) revert Bad("superseded");
        if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only");
        if (p.cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status");

        uint256 price;
        uint256 floorWei;
        // No floor reading: a fixed price can still execute, but is treated as below the floor (60 YES).
        if (!p.cancel) (price, floorWei) = _judgePrice(p.price, floor);
        uint256 need = needFor(id, price, floorWei);
        if (p.yes < need || (p.no > 0 && !p.deadlock)) revert Bad("did not pass");

        p.executed = true;
        ++priceEpoch;
        lastPriceExecutedAt = uint64(block.timestamp);
        blockedPriceProposals = 0; // deadlock mode ends once any price decision executes
        if (p.cancel) {
            ask = 0;
            askLiveAt = 0;
        } else if (s == Status.FULL) {
            pendingPrice = p.price;
            _pendingId = id;
            hasPendingPrice = true;
            emit PendingPriceSet(id, p.price.mode, p.price.value);
        } else {
            ask = price;
            askSpec = p.price;
            askLiveAt = uint64(block.timestamp);
            buyableAt = uint64(block.timestamp + _t(uint256(p.buyDelayHours) * 1 hours));
            emit AskSet(price, true);
        }
        emit Executed(id, msg.sender);
    }

    /// @notice Records a closed price proposal that was blocked by NO, toward the deadlock rule. Anyone may call.
    function countBlocked(uint256 id) external {
        Proposal storage p = _proposals[id];
        // Counts only a current-epoch price proposal that had enough YES to pass and was stopped by NO alone,
        // so a small holder voting NO on their own proposals cannot push the party into deadlock mode.
        if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked");
        blockedCounted[id] = true;
        ++blockedPriceProposals;
        emit BlockedCounted(id, blockedPriceProposals);
    }

    function _deadlocked() internal view returns (bool) {
        if (blockedPriceProposals >= DEADLOCK_BLOCKS) return true;
        uint256 since = lastPriceExecutedAt != 0 ? lastPriceExecutedAt : (assembledAt != 0 ? assembledAt : (fullAt != 0 ? fullAt : type(uint64).max));
        return since != type(uint64).max && block.timestamp > since + _t(DEADLOCK_TIME);
    }

    function _refreshOpen(address who) internal {
        // drop the proposer's proposals that have closed (the list never exceeds MAX_OPEN_PER_PROPOSER)
        uint256[] storage ids = _openIds[who];
        for (uint256 k = ids.length; k > 0; --k) {
            if (block.timestamp >= _proposals[ids[k - 1]].endsAt) { ids[k - 1] = ids[ids.length - 1]; ids.pop(); }
        }
    }

    function openProposalsOf(address who) external view returns (uint256[] memory) { return _openIds[who]; }

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
        if (block.timestamp < buyableAt) revert Bad("not open yet");
        uint256 price = ask;
        if (price > maxPrice || msg.value < price) revert Bad("price");

        uint256 fee = price * factory.FEE_BPS() / 10_000;
        uint256 pot = price - fee;
        uint256 share = pot / SLOTS;
        uint256 dust = pot - share * SLOTS;

        sold = true;
        perCard = share;
        ask = 0;
        owed[factory.feeRecipient()] += fee + dust;

        factory.statement().transferFrom(address(this), msg.sender, statementId);
        if (msg.value > price) {
            (bool ok,) = msg.sender.call{value: msg.value - price}("");
            if (!ok) revert Bad("refund");
        }
        emit Sold(msg.sender, price, 0, fee, share); // royalty field kept for indexers, always 0
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

    /// @notice Anyone may push the shares of `cardIds` to their current holders (e.g. for holders who never return).
    ///         A holder that cannot receive ETH is credited in `owed` instead.
    function claimFor(uint256[] calldata cardIds) external nonReentrant {
        if (!sold) revert Bad("not sold");
        for (uint256 i; i < cardIds.length; ++i) {
            uint256 c = cardIds[i];
            if (cards.partyOf(c) != address(this)) revert Bad("not this party");
            address holder = cards.ownerOf(c);
            delete creditOfCard[c];
            --cardsOutstanding;
            cards.burn(c);
            emit Claimed(holder, c, perCard);
            (bool ok,) = holder.call{value: perCard, gas: 50_000}("");
            if (!ok) owed[holder] += perCard;
        }
    }

    /// @notice Pull payment for the fee recipient (fee + rounding dust) and holders that could not receive ETH.
    function withdraw() external nonReentrant {
        uint256 amt = owed[msg.sender];
        if (amt == 0) revert Bad("nothing");
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert Bad("send");
        emit Withdrawn(msg.sender, amt);
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

    function _floor(Floor calldata f) internal returns (uint256) {
        if (f.issuedAt > block.timestamp || block.timestamp - f.issuedAt > FLOOR_MAX_AGE) revert Bad("stale floor");
        if (f.issuedAt < lastFloorAt) revert Bad("older floor");
        lastFloorAt = f.issuedAt;
        if (!factory.isValidFloor(f.floorWei, uint8(_params.floorMode), f.issuedAt, f.sig)) revert Bad("floor sig");
        if (f.floorWei == 0 || f.floorWei > 1e30) revert Bad("floor"); // bound keeps int256 casts and FloorPct math in range
        return f.floorWei;
    }

    function _resolve(PriceSpec memory p, Floor calldata f) internal returns (uint256) {
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        return _clampMin(_resolveWith(p, _floor(f)));
    }

    function _resolveWith(PriceSpec memory p, uint256 floorWei) internal pure returns (uint256 v) {
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        int256 f = int256(floorWei);
        int256 r = p.mode == PriceMode.FloorPct ? f * (10_000 + p.value) / 10_000 : f + p.value;
        return r <= 0 ? 0 : uint256(r); // a result <= 0 is clamped up to minAskWei (> 0 for any floor-relative spec)
    }

    /// @dev Floor-relative prices never resolve below the host's minimum ask (limits a bad or compromised floor reading),
    ///      including results <= 0 (floor at or below a FloorDelta discount), which would otherwise block assembly.
    function _clampMin(uint256 v) internal view returns (uint256) {
        return v < _params.minAskWei ? _params.minAskWei : v;
    }

    /// @dev Scales a rule duration expressed in real seconds by the factory's time unit (identity when timeUnit = 1 hour).
    function _t(uint256 secs) internal view returns (uint256) {
        return secs * timeUnit / 1 hours;
    }

    /// @dev A price's buy wait: 0..72 hours, and at least 1 hour for a floor-relative price (FLOOR_MAX_AGE is shorter,
    ///      so a fresher reading can always reach raiseAsk before buying opens).
    function _delayOk(PriceMode m, uint16 h) internal pure returns (bool) {
        return h <= MAX_BUY_DELAY_HOURS && (m == PriceMode.Fixed || h > 0);
    }

    function _windowOk(uint16 h) internal pure returns (bool) {
        return h == 1 || h == 24 || h == 48 || h == 72 || h == 168;
    }


    receive() external payable {
        revert Bad("no direct ETH");
    }
}
