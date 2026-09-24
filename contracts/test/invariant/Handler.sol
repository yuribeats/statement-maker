// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ILocalCredits} from "../ILocalCredits.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {Party} from "../../src/Party.sol";
import {CreditCards} from "../../src/CreditCards.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {ICredits} from "../../src/interfaces/IExternal.sol";
import {KeyProbe} from "../Base.t.sol";
import {HostileActor} from "./HostileActor.sol";

/// @notice Drives many parties with many actors. Transition invariants (things that need a before/after view)
///         are checked here and recorded in `violation`; state invariants live in PartyInvariants.t.sol.
///         Every action also checks the call's success against a model of the spec (both directions: a call
///         that should fail but succeeds, and a call that should succeed but fails).
contract Handler is Test {
    // actions
    uint8 constant DEPOSIT = 1;
    uint8 constant REDEEM = 2;
    uint8 constant REDEEMFOR = 3;
    uint8 constant TRANSFER = 4;
    uint8 constant PROPOSE = 5;
    uint8 constant VOTE = 6;
    uint8 constant EXECUTE = 7;
    uint8 constant COUNT = 8;
    uint8 constant ASSEMBLE = 9;
    uint8 constant RAISE = 10;
    uint8 constant BUY = 11;
    uint8 constant CLAIM = 12;
    uint8 constant WITHDRAW = 13;
    uint8 constant WARP = 14;
    uint8 constant CREATE = 15;
    uint8 constant STEAL = 16;
    uint8 constant CLAIMFOR = 17;

    uint256 constant MAX_PARTIES = 4;

    ILocalCredits public credits;
    PartyFactory public factory;
    MockStatement public statement;
    CreditCards public cards;
    KeyProbe public probe;
    uint256 internal signerKey;
    address public feeTo;
    address public royaltyTo;

    address[] public actors; // 0..5 EOAs, 6 REENTER, 7 REVERT, 8 CALLBACK
    mapping(address => bool) public isContractActor;
    Party[] public parties;
    mapping(address => uint256) public partyIndexPlusOne;
    mapping(address => address) public buyerOf;
    mapping(address => uint256[]) internal _everDeposited;
    mapping(address => uint256) public ghostBlocked;
    mapping(address => uint64) public ghostFullAt;
    mapping(address => uint64) public ghostLastExec;
    mapping(address => uint64) public ghostAssembledAt;
    mapping(address => uint64) public ghostBuyableAt; // model of when buying opens (voted wait per price)
    mapping(address => uint16) public ghostPendingDelay; // wait carried by a price voted while FULL

    string public violation;
    mapping(uint8 => uint256) public okCount;
    mapping(uint8 => uint256) public tryCount;

    // current call
    uint8 internal curAction;
    address internal curParty;
    address internal curActor;
    bool internal curOk;
    Party.Status internal curSt; // status of curParty at call time (after any warp inside the action)

    struct Snap {
        uint256 ask;
        Party.PriceMode mode;
        uint64 askLiveAt;
        Party.Status st;
        address stOwner;
        uint256 held;
        uint64 epoch;
        bool sold;
        uint256 bal;
    }

    constructor(
        ILocalCredits credits_,
        PartyFactory factory_,
        MockStatement statement_,
        KeyProbe probe_,
        uint256 signerKey_,
        address feeTo_,
        address[] memory eoas
    ) {
        credits = credits_;
        factory = factory_;
        statement = statement_;
        cards = factory_.cards();
        probe = probe_;
        signerKey = signerKey_;
        feeTo = feeTo_;
        royaltyTo = makeAddr("royalty");
        for (uint256 i; i < eoas.length; ++i) actors.push(eoas[i]);
        for (uint8 m = 1; m <= 3; ++m) {
            address h = address(new HostileActor(m));
            actors.push(h);
            isContractActor[h] = true;
        }
    }

    // ------------------------------------------------------------------ views for the invariant contract

    function actorCount() external view returns (uint256) { return actors.length; }
    function partyCount() external view returns (uint256) { return parties.length; }
    function everDeposited(address p) external view returns (uint256[] memory) { return _everDeposited[p]; }

    // ------------------------------------------------------------------ plumbing

    modifier step() {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        uint256 n = parties.length;
        Snap[] memory pre = new Snap[](n);
        for (uint256 i; i < n; ++i) pre[i] = _snap(parties[i]);
        curAction = 0;
        curParty = address(0);
        curActor = address(0);
        curOk = false;
        if (parties.length == 0) {
            uint256 r = uint256(keccak256(abi.encode(block.number)));
            _create(r, r >> 8, r >> 16, r >> 24, r >> 32, int256(r >> 40));
            curAction = 0;
            curParty = address(0);
            curOk = false;
        }
        _;
        if (curAction != 0) {
            ++tryCount[curAction];
            if (curOk) ++okCount[curAction];
        }
        for (uint256 i; i < n; ++i) _compare(parties[i], pre[i], _snap(parties[i]));
    }

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _snap(Party p) internal view returns (Snap memory s) {
        s.ask = p.ask();
        (s.mode,) = p.askSpec();
        s.askLiveAt = p.askLiveAt();
        s.st = p.status();
        if (p.assembled()) s.stOwner = statement.ownerOf(p.statementId());
        s.held = credits.balanceOf(address(p));
        s.epoch = p.priceEpoch();
        s.sold = p.sold();
        s.bal = address(p).balance;
    }

    /// Transition invariants 3, 4, 5, 6, 7.
    function _compare(Party p, Snap memory a, Snap memory b) internal {
        bool mine = curParty == address(p) && curOk;
        if (mine) a.st = curSt; // actions may warp before calling; judge by the status the call saw
        // 4. Statement leaves only via a valid buy at the ask after the delay
        if (a.stOwner == address(p) && b.stOwner != address(p)) {
            if (!(mine && curAction == BUY && a.st == Party.Status.ASSEMBLED && a.ask > 0
                    && block.timestamp >= ghostBuyableAt[address(p)] && b.stOwner == curActor && b.bal - a.bal == a.ask)) {
                _fail("I4: statement left party outside a valid buy");
            }
        }
        if (b.st == Party.Status.ASSEMBLED && b.stOwner != address(p)) _fail("I3: assembled party lost the statement");
        // 3. Credits enter only by deposit (OPEN); leave only by redeem (OPEN/EXPIRED) or the burn of all 80
        if (b.held > a.held && !(mine && curAction == DEPOSIT && a.st == Party.Status.OPEN)) _fail("I3: credits entered outside deposit");
        if (b.held < a.held) {
            bool viaRedeem = mine && (curAction == REDEEM || curAction == REDEEMFOR)
                && (a.st == Party.Status.OPEN || a.st == Party.Status.EXPIRED);
            bool viaBurn = mine && curAction == ASSEMBLE && a.st == Party.Status.FULL && a.held == 80 && b.held == 0;
            if (!viaRedeem && !viaBurn) _fail("I3: credits left outside redeem/burn");
        }
        // 7. Ask changes: vote, assembly, sale; without a vote only raiseAsk upward on a floor-relative ask
        if (b.ask != a.ask) {
            bool okAsk = mine && (curAction == EXECUTE || curAction == ASSEMBLE || curAction == BUY);
            if (mine && curAction == RAISE) okAsk = b.ask > a.ask && a.mode != Party.PriceMode.Fixed && a.st == Party.Status.ASSEMBLED;
            if (!okAsk) _fail("I7: ask changed without a vote/raise");
        }
        if (mine && curAction == RAISE && b.ask <= a.ask) _fail("I7: raiseAsk succeeded without raising");
        // 6. price epoch moves by exactly one, only on execute or assembly
        if (b.epoch != a.epoch && !(mine && (curAction == EXECUTE || curAction == ASSEMBLE) && b.epoch == a.epoch + 1)) {
            _fail("I6: priceEpoch moved unexpectedly");
        }
        if (b.sold != a.sold && !(mine && curAction == BUY)) _fail("I4: sold flipped outside buy");
        // 5. ETH in only through buy (exactly the ask), out only through claim / withdraw
        if (b.bal > a.bal && !(mine && curAction == BUY && b.bal - a.bal == a.ask)) _fail("I5: ETH entered party unexpectedly");
        if (b.bal < a.bal && !(mine && (curAction == CLAIM || curAction == CLAIMFOR || curAction == WITHDRAW))) _fail("I5: ETH left party unexpectedly");
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    /// Half the time the newest party (the one most likely to be mid-lifecycle), else any.
    function _party(uint256 s) internal view returns (Party) {
        uint256 n = parties.length;
        if (s % 4 != 0) {
            // prefer a party that is still moving (not expired, not sold)
            for (uint256 i; i < n; ++i) {
                Party p = parties[((s >> 2) + i) % n];
                Party.Status st = p.status();
                if (st == Party.Status.OPEN || st == Party.Status.FULL || st == Party.Status.ASSEMBLED) return p;
            }
        }
        return parties[(s >> 2) % n];
    }

    function _as(address who, address to, uint256 value, bytes memory data) internal returns (bool ok, bytes memory ret) {
        if (isContractActor[who]) {
            vm.deal(address(this), address(this).balance + value);
            (bool outer, bytes memory r) = who.call{value: value}(abi.encodeCall(HostileActor.act, (to, data)));
            if (!outer) return (false, r);
            (ok, ret) = abi.decode(r, (bool, bytes));
        } else {
            vm.deal(who, who.balance + value);
            vm.prank(who);
            (ok, ret) = to.call{value: value}(data);
        }
    }

    function _live(uint256 c) internal view returns (bool live, address owner) {
        try cards.ownerOf(c) returns (address o) { return (true, o); } catch { return (false, address(0)); }
    }

    function _cardsOf(Party p, address who) internal view returns (uint256[] memory out) {
        uint256 total = cards.nextId();
        uint256[] memory tmp = new uint256[](total);
        uint256 n;
        for (uint256 c = 1; c < total; ++c) {
            if (cards.partyOf(c) != address(p)) continue;
            (bool live, address o) = _live(c);
            if (live && (who == address(0) || o == who)) tmp[n++] = c;
        }
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    function _subset(uint256[] memory a, uint256 seed) internal pure returns (uint256[] memory out) {
        if (a.length == 0) return a;
        uint256 k = 1 + seed % a.length;
        uint256 off = (seed >> 32) % a.length;
        out = new uint256[](k);
        for (uint256 i; i < k; ++i) out[i] = a[(off + i) % a.length];
    }

    /// Arms a hostile actor to re-enter `p` if it receives ETH from it.
    function _arm(address who, Party p) internal {
        if (!isContractActor[who]) return;
        HostileActor h = HostileActor(payable(who));
        bytes[] memory pokes;
        uint256[] memory mine = _cardsOf(p, who);
        if (h.mode() == 1) {
            pokes = new bytes[](4);
            pokes[0] = abi.encodeCall(Party.claim, (mine));
            pokes[1] = abi.encodeCall(Party.withdraw, ());
            pokes[2] = abi.encodeCall(Party.buy, (type(uint256).max));
            pokes[3] = abi.encodeCall(Party.redeem, (mine));
        } else if (h.mode() == 3) {
            Party.Floor memory f;
            pokes = new bytes[](5);
            pokes[0] = abi.encodeCall(Party.assemble, (p.depositOrder(), f));
            pokes[1] = abi.encodeCall(Party.redeem, (mine));
            pokes[2] = abi.encodeCall(Party.redeemFor, (mine));
            pokes[3] = abi.encodeCall(Party.execute, (0, f));
            pokes[4] = abi.encodeCall(Party.onDeposit, (who, new uint256[](1), new bytes32[][](0))); // factory only
        } else {
            pokes = new bytes[](0);
        }
        h.arm(address(p), pokes);
    }

    function _accepts(address who) internal view returns (bool) {
        return !(isContractActor[who] && HostileActor(payable(who)).mode() == 2);
    }

    // ------------------------------------------------------------------ prices + floors (spec model)

    function _priceOk(Party.PriceSpec memory p) internal pure returns (bool) {
        if (p.mode == Party.PriceMode.Fixed) return p.value > 0 && p.value <= 1e24;
        if (p.mode == Party.PriceMode.FloorPct) return p.value > -10_000 && p.value <= 1_000_000;
        return p.value >= -1e24 && p.value <= 1e24;
    }

    function _resolve(Party.PriceSpec memory p, uint256 fw) internal pure returns (bool ok, uint256 v) {
        if (p.mode == Party.PriceMode.Fixed) return (true, uint256(p.value));
        int256 f = int256(fw);
        int256 r = p.mode == Party.PriceMode.FloorPct ? f * (10_000 + p.value) / 10_000 : f + p.value;
        if (r <= 0) return (false, 0);
        return (true, uint256(r));
    }

    function _floor(Party p, uint256 kind, uint256 fwSeed) internal view returns (Party.Floor memory f, bool valid) {
        uint8 mode = uint8(p.params().floorMode);
        uint256 fw = _bound(fwSeed, 0.2 ether, 30 ether);
        uint64 at = uint64(block.timestamp);
        uint256 key = signerKey;
        uint8 m = mode;
        valid = true;
        kind = kind % 10;
        bool badLen;
        if (kind == 4) at = uint64(block.timestamp - 10 minutes); // boundary: still fresh (FLOOR_MAX_AGE)
        else if (kind == 5) { at = uint64(block.timestamp + 1); valid = false; } // future
        else if (kind == 6) { at = uint64(block.timestamp - 10 minutes - 1); valid = false; } // stale
        else if (kind == 7) { m = mode ^ 1; valid = false; } // wrong floor mode
        else if (kind == 8) { key = 0xBAD; valid = false; } // forged
        else if (kind == 9) { fw = 0; valid = false; } // signed zero
        else if (kind == 3) { badLen = true; valid = false; }
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, factory.floorDigest(fw, m, at));
        f = Party.Floor(fw, at, badLen ? bytes(hex"1234") : abi.encodePacked(r, s, v));
        if ((fwSeed >> 200) % 6 == 0) { f = Party.Floor(0, 0, ""); valid = false; } // no reading at all
    }

    /// A reading is usable only if it is valid AND not older than the last reading the party used.
    function _fresh(Party p, Party.Floor memory f, bool valid) internal view returns (bool) {
        return valid && f.issuedAt >= p.lastFloorAt();
    }

    /// Floor-relative prices never resolve below the host's minimum ask.
    function _clamp(Party p, Party.PriceSpec memory spec, uint256 v) internal view returns (uint256) {
        if (spec.mode == Party.PriceMode.Fixed) return v;
        uint256 m = p.params().minAskWei;
        return v < m ? m : v;
    }

    // ------------------------------------------------------------------ actions

    function createParty(uint256 aSeed, uint256 arrSeed, uint256 minSeed, uint256 durSeed, uint256 priceSeed, int256 val) external step {
        _create(aSeed, arrSeed, minSeed, durSeed, priceSeed, val);
    }

    function _create(uint256 aSeed, uint256 arrSeed, uint256 minSeed, uint256 durSeed, uint256 priceSeed, int256 val) internal {
        if (parties.length >= MAX_PARTIES) return;
        address who = _actor(aSeed);
        Party.Params memory p;
        p.name = "Fuzz Party";
        p.minDeposit = uint8(_bound(minSeed, 1, 10));
        p.durationDays = uint32(durSeed % 5 == 0 ? _bound(durSeed >> 8, 1, 5) : _bound(durSeed >> 8, 20, 60));
        uint16[5] memory w = [uint16(1), 24, 48, 72, 168];
        p.voteHours = w[(minSeed >> 8) % 5];
        p.arrangement = CreditKeys.Preset(arrSeed % 11);
        p.seed = arrSeed >> 8;
        p.floorMode = Party.FloorMode((minSeed >> 16) % 2);
        uint256 k = priceSeed % 3;
        if (k == 0) p.defaultPrice = Party.PriceSpec(Party.PriceMode.Fixed, _bound(val, 0.05 ether, 20 ether));
        else if (k == 1) p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, _bound(val, -5000, 5000));
        else p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorDelta, _bound(val, -2 ether, 5 ether));
        // host minimum ask: required > 0 for a floor-relative default; 1 in 16 creations omit it (must be refused)
        p.minAskWei = (priceSeed >> 8) % 16 == 0 ? 0 : _bound(priceSeed >> 16, 1, 2 ether);
        bool minAskOk = k == 0 || p.minAskWei > 0;
        uint16[6] memory waits = [uint16(0), 1, 1, 24, 72, 73]; // 73 must be refused
        p.buyDelayHours = waits[(durSeed >> 32) % 6];
        minAskOk = minAskOk && p.buyDelayHours <= 72 && (k == 0 || p.buyDelayHours > 0); // floor-relative needs a wait >= 1h

        // opening deposit: between minDeposit and everything the host owns (at most 80)
        uint256[] memory owned = credits.tokensOf(who);
        uint256 cap = owned.length < 80 ? owned.length : 80;
        uint256 n = cap < p.minDeposit ? cap : _bound(durSeed >> 64, p.minDeposit, cap);
        if (n == 0 && owned.length > 0) n = 1;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) ids[i] = owned[(aSeed + i) % owned.length];
        bool expected = minAskOk && n >= p.minDeposit;

        curAction = CREATE;
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        address predicted = factory.predictParty(who);
        uint256 firstCard = cards.nextId();
        _as(who, address(credits), 0, abi.encodeWithSignature("setApprovalForAll(address,bool)", address(factory), true));
        (bool ok, bytes memory ret) = _as(who, address(factory), 0, abi.encodeCall(PartyFactory.createParty, (p, ids, new bytes32[][](0))));
        _as(who, address(credits), 0, abi.encodeWithSignature("setApprovalForAll(address,bool)", address(factory), false));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "createParty: invalid party accepted" : "createParty with valid params failed");
        if (!ok) return;
        Party party = abi.decode(ret, (Party));
        if (address(party) != predicted) _fail("party not at predicted address");
        if (party.host() != who) _fail("host is not the creator");
        if (party.count() != n) _fail("opening deposit not made in the creation tx");
        for (uint256 i; i < n; ++i) {
            uint256 c = firstCard + i;
            if (cards.ownerOf(c) != who || party.creditOfCard(c) != ids[i]) _fail("opening deposit: card not minted to host");
            _everDeposited[address(party)].push(ids[i]);
        }
        if (n == 80) ghostFullAt[address(party)] = uint64(block.timestamp);
        parties.push(party);
        partyIndexPlusOne[address(party)] = parties.length;
    }

    function deposit(uint256 aSeed, uint256 pSeed, uint256 nSeed, uint256 variant) external step {
        _deposit(_actor(aSeed), _party(pSeed), aSeed, nSeed, variant);
    }

    /// Deposits from several actors in turn (all valid) until the party is full: gets parties to FULL often
    /// enough for the post-fill lifecycle to be explored.
    function fill(uint256 pSeed, uint256 seed) external step {
        Party p = _party(pSeed);
        for (uint256 i; i < 12 && p.status() == Party.Status.OPEN; ++i) {
            _deposit(_actor(seed + i), p, seed + i, uint256(keccak256(abi.encode(seed, i))) % 1000 + 40, 7);
        }
    }

    function _deposit(address who, Party p, uint256 aSeed, uint256 nSeed, uint256 variant) internal {
        uint256[] memory owned = credits.tokensOf(who);
        uint256 remaining = 80 - p.count();
        uint256 min = p.params().minDeposit;
        if (min > remaining) min = remaining;
        uint256 cap = remaining < owned.length ? remaining : owned.length;
        uint256 k = cap == 0 ? 1 : _bound(nSeed, min == 0 ? 1 : min, cap < min ? min : cap);
        if (variant % 11 == 0 && k > 1) k = k - 1; // may undercut the minimum
        uint256[] memory ids = new uint256[](k);
        bool valid = k <= owned.length && k >= 1 && k >= min && k <= remaining;
        for (uint256 i; i < k; ++i) ids[i] = i < owned.length ? owned[(nSeed + i) % owned.length] : 100_000 + i;
        if (k > owned.length) valid = false;
        if (variant % 13 == 1) { // a Credit the caller does not own
            address other = _actor(aSeed + 1);
            uint256[] memory theirs = credits.tokensOf(other);
            if (theirs.length > 0) { ids[0] = theirs[0]; valid = false; }
        } else if (variant % 13 == 2 && k > 1) { // duplicate
            ids[1] = ids[0];
            valid = false;
        } else if (variant % 13 == 3) { // burned / nonexistent
            ids[0] = 100_000;
            valid = false;
        }
        bool expected = valid && p.status() == Party.Status.OPEN;
        uint256 firstCard = cards.nextId();

        curAction = DEPOSIT;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        _as(who, address(credits), 0, abi.encodeWithSignature("setApprovalForAll(address,bool)", address(factory), true));
        (bool ok,) = _as(who, address(factory), 0, abi.encodeCall(PartyFactory.deposit, (p, ids, new bytes32[][](0))));
        _as(who, address(credits), 0, abi.encodeWithSignature("setApprovalForAll(address,bool)", address(factory), false));
        curOk = curOk || ok;
        if (ok != expected) return _fail(ok ? "deposit: invalid deposit accepted" : "deposit: valid deposit rejected");
        if (!ok) return;
        for (uint256 i; i < k; ++i) {
            uint256 c = firstCard + i;
            if (cards.ownerOf(c) != who || p.creditOfCard(c) != ids[i] || p.cardOfCredit(ids[i]) != c || cards.partyOf(c) != address(p)) {
                return _fail("deposit: card not minted to depositor for its credit");
            }
            _everDeposited[address(p)].push(ids[i]);
        }
        if (p.count() == 80) ghostFullAt[address(p)] = uint64(block.timestamp);
    }

    function redeem(uint256 aSeed, uint256 pSeed, uint256 sub, uint256 variant) external step {
        address who = _actor(aSeed);
        Party p = _party(pSeed);
        uint256[] memory ids = _subset(_cardsOf(p, who), sub);
        bool valid = true;
        if (variant % 5 == 0) { // someone else's card
            uint256[] memory all = _cardsOf(p, address(0));
            for (uint256 i; i < all.length; ++i) {
                if (cards.ownerOf(all[i]) != who) {
                    uint256[] memory x = new uint256[](ids.length + 1);
                    for (uint256 j; j < ids.length; ++j) x[j] = ids[j];
                    x[ids.length] = all[i];
                    ids = x;
                    valid = false;
                    break;
                }
            }
        }
        Party.Status st = p.status();
        bool expected = valid && (ids.length == 0 || st == Party.Status.OPEN || st == Party.Status.EXPIRED);
        uint256[] memory creds = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) creds[i] = p.creditOfCard(ids[i]);
        curAction = REDEEM;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.redeem, (ids)));
        curOk = ok && ids.length > 0;
        if (ok != expected) return _fail(ok ? "redeem: invalid redeem accepted" : "redeem: valid redeem rejected");
        if (!ok) return;
        for (uint256 i; i < ids.length; ++i) {
            if (credits.ownerOf(creds[i]) != who) return _fail("I3: redeemed credit not sent to card holder");
            (bool live,) = _live(ids[i]);
            if (live) return _fail("redeem: card not burned");
        }
    }

    function redeemFor(uint256 aSeed, uint256 pSeed, uint256 sub, uint256 variant) external step {
        Party p = _party(pSeed);
        if (variant % 8 == 0 && !p.assembled() && block.timestamp <= p.deadline()) vm.warp(uint256(p.deadline()) + 1);
        address who = _actor(aSeed);
        uint256[] memory ids = variant % 3 == 0 ? _cardsOf(p, address(0)) : _subset(_cardsOf(p, address(0)), sub);
        address[] memory holders = new address[](ids.length);
        uint256[] memory creds = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            holders[i] = cards.ownerOf(ids[i]);
            creds[i] = p.creditOfCard(ids[i]);
        }
        bool expected = p.status() == Party.Status.EXPIRED;
        curAction = REDEEMFOR;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.redeemFor, (ids)));
        curOk = ok && ids.length > 0;
        if (ok != expected) return _fail(ok ? "redeemFor before expiry" : "I8: redeemFor after expiry rejected");
        if (!ok) return;
        for (uint256 i; i < ids.length; ++i) {
            if (credits.ownerOf(creds[i]) != holders[i]) return _fail("I8: redeemFor did not pay the card holder");
        }
    }

    function transferCard(uint256 aSeed, uint256 bSeed, uint256 pSeed, uint256 cSeed, uint256 variant) external step {
        address from = _actor(aSeed);
        address to = _actor(bSeed);
        Party p = _party(pSeed);
        uint256[] memory mine = _cardsOf(p, variant % 7 == 0 ? address(0) : from);
        if (mine.length == 0) return;
        uint256 c = mine[cSeed % mine.length];
        bool expected = cards.ownerOf(c) == from;
        curAction = TRANSFER;
        curActor = from;
        (bool ok,) = _as(from, address(cards), 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, c));
        curOk = ok;
        if (ok != expected) _fail("card transfer model mismatch");
    }

    function propose(uint256 aSeed, uint256 pSeed, uint256 kind, int256 val, uint256 hSeed) external step {
        _propose(_actor(aSeed), _party(pSeed), kind, val, hSeed);
    }

    function _propose(address who, Party p, uint256 kind, int256 val, uint256 hSeed) internal returns (bool ok, uint256 id) {
        bool cancel = kind % 6 == 0;
        Party.PriceSpec memory price;
        uint256 k = kind % 6;
        if (k == 1 || k == 2) price = Party.PriceSpec(Party.PriceMode.Fixed, _bound(val, 0.01 ether, 30 ether));
        else if (k == 3) price = Party.PriceSpec(Party.PriceMode.FloorPct, _bound(val, -9000, 5000));
        else if (k == 4) price = Party.PriceSpec(Party.PriceMode.FloorDelta, _bound(val, -10 ether, 10 ether));
        else if (k == 5) price = Party.PriceSpec(Party.PriceMode.Fixed, 0); // invalid
        uint16[7] memory hs = [uint16(0), 1, 24, 48, 72, 168, 25]; // 25 must be refused
        uint16 h = hs[hSeed % 7];
        uint16[6] memory ds = [uint16(0), 1, 24, 72, 73, 500]; // buy waits: 0..72 valid, 73+ refused for prices
        uint16 d = ds[(hSeed >> 8) % 6];

        Party.Status st = p.status();
        uint256 n = p.proposalCount();
        uint256 open;
        for (uint256 i; i < n; ++i) {
            Party.Proposal memory q = p.proposal(i);
            if (q.proposer == who && block.timestamp < q.endsAt) ++open;
        }
        bool statusOk = cancel ? (st == Party.Status.ASSEMBLED && p.ask() > 0) : (st == Party.Status.FULL || st == Party.Status.ASSEMBLED);
        bool expected = statusOk && cards.heldNow(address(p), who) > 0 && cards.heldAt(address(p), who, block.number - 1) > 0
            && open < 3 && (cancel || (_priceOk(price) && h != 25 && d <= 72 && (price.mode == Party.PriceMode.Fixed || d > 0)
                && (price.mode == Party.PriceMode.Fixed || p.params().minAskWei > 0))); // no lifetime cap; cancels always run 24h; floor-relative needs a host minimum ask
        bool expectDeadlock = _deadlockModel(p);

        curAction = PROPOSE;
        curParty = address(p);
        curActor = who;
        curSt = st;
        bytes memory ret;
        (ok, ret) = _as(who, address(p), 0, abi.encodeCall(Party.propose, (price, cancel, h, d)));
        curOk = ok;
        if (ok != expected) {
            _fail(ok ? "propose: invalid proposal accepted" : "propose: valid proposal rejected");
            return (false, 0);
        }
        if (!ok) return (false, 0);
        id = abi.decode(ret, (uint256));
        Party.Proposal memory pr = p.proposal(id);
        if (pr.snapshot != block.number - 1 || pr.epoch != p.priceEpoch()) _fail("I6: proposal snapshot/epoch");
        if (pr.deadlock != expectDeadlock) _fail("I6: proposal deadlock flag != model");
        if (pr.yes != cards.heldAt(address(p), who, pr.snapshot) || pr.no != 0) _fail("I6: proposer auto-vote weight");
        uint256 hh = cancel ? 24 : (h == 0 ? p.params().voteHours : h);
        if (pr.endsAt != block.timestamp + hh * 1 hours) _fail("proposal window (cancel must be 24h)");
        if (pr.buyDelayHours != (cancel ? 0 : d)) _fail("proposal buy wait not recorded");
        uint256[] memory openIds = p.openProposalsOf(who);
        if (openIds.length != open + 1 || openIds.length > 3) _fail("openProposalsOf != open proposals");
    }

    function _deadlockModel(Party p) internal view returns (bool) {
        if (ghostBlocked[address(p)] >= 3) return true;
        address a = address(p);
        uint256 since = ghostLastExec[a] != 0 ? ghostLastExec[a] : ghostAssembledAt[a] != 0 ? ghostAssembledAt[a] : ghostFullAt[a];
        return since != 0 && block.timestamp > since + 30 days;
    }

    function vote(uint256 aSeed, uint256 pSeed, uint256 idSeed, bool support) external step {
        Party p = _party(pSeed);
        uint256 n = p.proposalCount();
        if (n == 0) return;
        address who = _actor(aSeed);
        uint256 id = idSeed % n;
        Party.Proposal memory pr = p.proposal(id);
        uint256 w = cards.heldAt(address(p), who, pr.snapshot);
        bool expected = block.timestamp < pr.endsAt && w > 0;
        curAction = VOTE;
        curParty = address(p);
        curActor = who;
        curSt = p.status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.vote, (id, support)));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "I6: vote without snapshot weight accepted" : "vote: valid vote rejected");
        if (ok && p.weightOf(id, who) != w) _fail("I6: vote weight != snapshot holding");
    }

    /// Every actor votes on one proposal (those without snapshot weight must be refused); each votes NO with
    /// probability 1/8.
    function voteAll(uint256 pSeed, uint256 idSeed, uint256 noSeed) external step {
        Party p = _party(pSeed);
        uint256 n = p.proposalCount();
        if (n == 0) return;
        _voteAll(p, idSeed % n, noSeed);
    }

    function _voteAll(Party p, uint256 id, uint256 noSeed) internal {
        Party.Proposal memory pr = p.proposal(id);
        curAction = VOTE;
        curParty = address(p);
        curSt = p.status();
        for (uint256 a; a < actors.length; ++a) {
            address who = actors[a];
            uint256 w = cards.heldAt(address(p), who, pr.snapshot);
            bool support = (noSeed >> (a * 3)) & 7 != 0;
            bool expected = block.timestamp < pr.endsAt && w > 0;
            (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.vote, (id, support)));
            curOk = curOk || ok;
            if (ok != expected) return _fail(ok ? "I6: vote without snapshot weight accepted" : "vote: valid vote rejected");
            if (ok && p.weightOf(id, who) != w) return _fail("I6: vote weight != snapshot holding");
        }
    }

    function execute(uint256 aSeed, uint256 pSeed, uint256 idSeed, uint256 fKind, uint256 fw, uint256 variant) external step {
        Party p = _party(pSeed);
        uint256 n = p.proposalCount();
        if (n == 0) return;
        _execute(_actor(aSeed), p, idSeed % n, fKind, fw, variant);
    }

    /// A full governance round on an active party: a card holder proposes, everyone votes, time passes to the
    /// close, someone executes (with a random floor attestation).
    function govRound(uint256 aSeed, uint256 pSeed, uint256 kind, int256 val, uint256 noSeed, uint256 fKind, uint256 fw) external step {
        Party p = _party(pSeed);
        address who = _holderOf(p, aSeed);
        if (who == address(0)) return;
        (bool ok, uint256 id) = _propose(who, p, kind, val, fw >> 128);
        if (!ok) return;
        _voteAll(p, id, noSeed);
        _execute(_holderOf(p, noSeed), p, id, fKind, fw, 1 + (fw >> 64) * 3);
    }

    function _holderOf(Party p, uint256 seed) internal view returns (address) {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[(seed + i) % actors.length];
            if (cards.heldNow(address(p), a) > 0 && cards.heldAt(address(p), a, block.number - 1) > 0) return a;
        }
        return address(0);
    }

    function _execute(address who, Party p, uint256 id, uint256 fKind, uint256 fw, uint256 variant) internal {
        Party.Proposal memory pr = p.proposal(id);
        // Most of the time, jump to the execution window so executions actually happen.
        if (variant % 3 != 0 && block.timestamp < pr.endsAt) vm.warp(uint256(pr.endsAt) + (variant >> 8) % 2 days);
        (Party.Floor memory f, bool fValid) = _floor(p, fKind, fw);

        Party.Status st = p.status();
        bool expected = !pr.executed && block.timestamp >= pr.endsAt && block.timestamp <= uint256(pr.endsAt) + 7 days
            && pr.epoch == p.priceEpoch() && cards.heldNow(address(p), who) > 0
            && (pr.cancel ? st == Party.Status.ASSEMBLED : (st == Party.Status.FULL || st == Party.Status.ASSEMBLED));
        uint256 price;
        uint256 need = 41;
        if (!pr.cancel) {
            if (pr.price.mode == Party.PriceMode.Fixed && f.sig.length == 0) {
                price = uint256(pr.price.value); // no floor reading: treated as below floor
                need = 60;
            } else {
                bool rOk;
                (rOk, price) = _resolve(pr.price, f.floorWei);
                price = _clamp(p, pr.price, price);
                expected = expected && _fresh(p, f, fValid) && rOk;
                if (price < f.floorWei) need = 60;
            }
        }
        if (pr.deadlock && need < 54) need = 54;
        expected = expected && pr.yes >= need && (pr.no == 0 || pr.deadlock);
        uint64 epoch0 = p.priceEpoch();

        curAction = EXECUTE;
        curParty = address(p);
        curActor = who;
        curSt = st;
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.execute, (id, f)));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "I6: execute accepted outside the pass rule" : "execute: passing proposal rejected");
        if (!ok) return;
        ghostLastExec[address(p)] = uint64(block.timestamp);
        ghostBlocked[address(p)] = 0;
        if (p.blockedPriceProposals() != 0) _fail("execute did not reset the blocked counter");
        if (p.priceEpoch() != epoch0 + 1 || !p.proposal(id).executed) _fail("I6: execute did not bump epoch");
        if (pr.cancel) {
            if (p.ask() != 0) _fail("cancel left an ask");
        } else if (st == Party.Status.FULL) {
            (Party.PriceMode m, int256 v) = p.pendingPrice();
            if (!p.hasPendingPrice() || m != pr.price.mode || v != pr.price.value) _fail("pending price not stored");
            ghostPendingDelay[address(p)] = pr.buyDelayHours;
        } else {
            if (p.ask() != price || p.askLiveAt() != block.timestamp) _fail("executed LIST did not set ask");
            ghostBuyableAt[address(p)] = uint64(block.timestamp + uint256(pr.buyDelayHours) * 1 hours);
            if (p.buyableAt() != ghostBuyableAt[address(p)]) _fail("executed LIST: buyableAt != now + its voted wait");
        }
    }

    function countBlocked(uint256 pSeed, uint256 idSeed) external step {
        Party p = _party(pSeed);
        uint256 n = p.proposalCount();
        if (n == 0) return;
        uint256 id = idSeed % n;
        Party.Proposal memory pr = p.proposal(id);
        if (block.timestamp < pr.endsAt && idSeed % 2 == 0) vm.warp(pr.endsAt);
        bool expected = !p.blockedCounted(id) && !pr.cancel && !pr.executed && block.timestamp >= pr.endsAt && pr.no > 0 && !pr.deadlock
            && pr.yes >= 41 && pr.epoch == p.priceEpoch();
        curAction = COUNT;
        curParty = address(p);
        (bool ok,) = address(p).call(abi.encodeCall(Party.countBlocked, (id)));
        curOk = ok;
        if (ok != expected) return _fail("countBlocked model mismatch");
        if (ok) ++ghostBlocked[address(p)];
    }

    function assemble(uint256 aSeed, uint256 pSeed, uint256 variant, uint256 fKind, uint256 fw) external step {
        Party p = _party(pSeed);
        Party.Params memory prm = p.params();
        address who = variant % 3 == 0 ? p.host() : _actor(aSeed);
        // Manual: the host's hand order until MANUAL_GRACE (1 day) after FULL; then any card holder, Time order.
        bool manualHost = prm.arrangement == CreditKeys.Preset.Manual && block.timestamp <= uint256(p.fullAt()) + 1 days;
        if (prm.arrangement == CreditKeys.Preset.Manual && !manualHost) prm.arrangement = CreditKeys.Preset.Time;
        uint256[] memory order = p.depositOrder();
        bool orderOk = order.length == 80;
        if (orderOk) order = _correctOrder(prm, order, variant);
        uint256 wrong = (variant >> 8) % 6;
        if (orderOk && wrong == 0) { // swap: still a permutation; wrong for every preset except Manual
            (order[0], order[1]) = (order[1], order[0]);
            if (prm.arrangement != CreditKeys.Preset.Manual) orderOk = false;
        } else if (orderOk && wrong == 1) { // a Credit that is not in the party
            uint256[] memory stray = credits.tokensOf(_actor(aSeed));
            if (stray.length > 0) { order[5] = stray[0]; orderOk = false; }
        } else if (orderOk && wrong == 2) { // repeat
            order[7] = order[8];
            orderOk = false;
        }
        (Party.Floor memory f, bool fValid) = _floor(p, fKind, fw);
        Party.PriceSpec memory spec = prm.defaultPrice;
        if (p.hasPendingPrice()) (spec.mode, spec.value) = p.pendingPrice();
        (bool rOk, uint256 resolved) = _resolve(spec, f.floorWei);
        bool priceOk = spec.mode == Party.PriceMode.Fixed || (_fresh(p, f, fValid) && rOk);
        uint256 wantAsk = _clamp(p, spec, resolved);
        bool authOk = manualHost ? who == p.host() : cards.heldNow(address(p), who) > 0;
        bool expected = p.status() == Party.Status.FULL && orderOk && priceOk && authOk;
        _arm(who, p);

        curAction = ASSEMBLE;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.assemble, (order, f)));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "assemble: invalid assembly accepted" : "assemble: valid assembly rejected");
        if (!ok) return;
        for (uint256 i; i < 80; ++i) {
            try credits.ownerOf(order[i]) returns (address) { return _fail("I3: credit survived the burn"); } catch {}
        }
        if (statement.ownerOf(p.statementId()) != address(p)) _fail("I3: statement not held by party");
        ghostAssembledAt[address(p)] = uint64(block.timestamp);
        uint256 wait = p.hasPendingPrice() ? ghostPendingDelay[address(p)] : prm.buyDelayHours;
        ghostBuyableAt[address(p)] = uint64(block.timestamp + wait * 1 hours);
        if (p.buyableAt() != ghostBuyableAt[address(p)]) _fail("assemble: buyableAt != now + default/pending wait");
        if (p.ask() != wantAsk) _fail("assembled ask != clamped resolved price");
        uint256[] memory burned = p.burnOrder();
        for (uint256 i; i < 80; ++i) if (burned[i] != order[i]) return _fail("burn order not stored");
    }

    function _correctOrder(Party.Params memory prm, uint256[] memory dep, uint256 variant)
        internal view returns (uint256[] memory)
    {
        CreditKeys.Preset a = prm.arrangement;
        if (a == CreditKeys.Preset.Deposit) return dep;
        if (a == CreditKeys.Preset.Random) return probe.shuffle(dep, prm.seed);
        if (a == CreditKeys.Preset.Manual) {
            // host's hand order: a seeded shuffle
            return probe.shuffle(dep, variant);
        }
        return _sortBy(a, dep);
    }

    function _sortBy(CreditKeys.Preset a, uint256[] memory ids) internal view returns (uint256[] memory) {
        uint256[] memory k = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) k[i] = probe.key(a, ICredits(address(credits)), ids[i]);
        for (uint256 i = 1; i < ids.length; ++i) {
            (uint256 kk, uint256 id) = (k[i], ids[i]);
            uint256 j = i;
            while (j > 0 && k[j - 1] > kk) { k[j] = k[j - 1]; ids[j] = ids[j - 1]; --j; }
            k[j] = kk;
            ids[j] = id;
        }
        return ids;
    }

    function raiseAsk(uint256 aSeed, uint256 pSeed, uint256 fKind, uint256 fw) external step {
        Party p = _party(pSeed);
        address who = _actor(aSeed);
        (Party.Floor memory f, bool fValid) = _floor(p, fKind, fw);
        Party.PriceSpec memory spec;
        (spec.mode, spec.value) = p.askSpec();
        (bool rOk, uint256 next) = _resolve(spec, f.floorWei);
        next = _clamp(p, spec, next);
        bool expected = p.status() == Party.Status.ASSEMBLED && p.ask() > 0 && spec.mode != Party.PriceMode.Fixed
            && _fresh(p, f, fValid) && rOk && next > p.ask();
        curAction = RAISE;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.raiseAsk, (f)));
        curOk = ok;
        if (ok != expected) _fail(ok ? "I7: invalid raiseAsk accepted" : "raiseAsk: valid raise rejected");
    }

    function buy(uint256 aSeed, uint256 pSeed, uint256 variant, uint256 extra) external step {
        Party p = _party(pSeed);
        uint256 ask = p.ask();
        uint256 opensAt = ghostBuyableAt[address(p)];
        if (variant % 4 != 0 && ask > 0 && block.timestamp < opensAt) {
            // usually jump past the wait; 1 in 4 land up to 1 hour early (must be refused)
            vm.warp((extra >> 128) % 4 == 0 && opensAt > block.timestamp + 1 hours ? opensAt - 1 - (extra >> 132) % 1 hours : opensAt + extra % 2 hours);
        }
        address who = _actor(aSeed);
        uint96 bps = uint96(extra % 2001);
        address rTo = (extra >> 16) % 4 == 0 ? address(0) : royaltyTo;
        statement.setRoyalty(rTo, bps);
        uint256 maxPrice = (variant >> 4) % 7 == 1 && ask > 0 ? ask - 1 : ask + (extra >> 32) % 1 ether;
        uint256 value = ask;
        uint256 v5 = (variant >> 8) % 5;
        if (v5 == 2 && ask > 0) value = ask - 1;
        else if (v5 == 3) value = ask + 1 + (extra >> 64) % 2 ether;
        bool expected = p.status() == Party.Status.ASSEMBLED && ask > 0 && block.timestamp >= opensAt
            && maxPrice >= ask && value >= ask && (value == ask || _accepts(who));
        uint256 fee0 = p.owed(feeTo);
        uint256 roy0 = p.owed(royaltyTo);
        uint256 bal0 = address(p).balance;
        _arm(who, p);

        curAction = BUY;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), value, abi.encodeCall(Party.buy, (maxPrice)));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "I4: invalid buy accepted" : "buy: valid buy rejected");
        if (!ok) return;
        buyerOf[address(p)] = who;
        if (address(p).balance - bal0 != ask) _fail("I5: party kept more or less than the price");
        uint256 feeD = p.owed(feeTo) - fee0;
        uint256 royD = p.owed(royaltyTo) - roy0;
        uint256 fee = ask / 100;
        uint256 wantRoy = rTo == address(0) ? 0 : ask * bps / 10_000;
        if (wantRoy > ask / 10) wantRoy = ask / 10;
        if (royD != wantRoy) _fail("I5: royalty wrong or above cap");
        if (feeD < fee || feeD - fee >= 80) _fail("I5: fee/dust wrong");
        if (royD + feeD + 80 * p.perCard() != ask) _fail("I5: split does not sum to price");
        if (p.ask() != 0 || !p.sold() || p.cardsOutstanding() != 80) _fail("post-sale state");
    }

    function _soldParty(uint256 s) internal view returns (Party) {
        uint256 n = parties.length;
        for (uint256 i; i < n; ++i) {
            Party p = parties[(s + i) % n];
            if (p.sold()) return p;
        }
        return parties[s % n];
    }

    /// Every actor claims all of its cards in a sold party; then fee and royalty receivers withdraw.
    function claimAll(uint256 pSeed) external step {
        Party p = _soldParty(pSeed);
        curAction = CLAIM;
        curParty = address(p);
        curSt = p.status();
        for (uint256 a; a < actors.length; ++a) {
            address who = actors[a];
            uint256[] memory ids = _cardsOf(p, who);
            bool expected = p.sold() && _accepts(who);
            uint256 bal0 = who.balance;
            _arm(who, p);
            (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.claim, (ids)));
            curOk = curOk || ok;
            if (ok != expected) return _fail(ok ? "claim: invalid claim accepted" : "claim: valid claim rejected");
            if (ok && who.balance - bal0 != p.perCard() * ids.length) return _fail("I5: claim paid wrong amount");
        }
    }

    function claim(uint256 aSeed, uint256 pSeed, uint256 sub, uint256 variant) external step {
        Party p = pSeed % 2 == 0 ? _soldParty(pSeed >> 1) : _party(pSeed >> 1);
        address who = _actor(aSeed);
        uint256[] memory ids = _subset(_cardsOf(p, who), sub);
        bool valid = true;
        if (variant % 5 == 0) {
            uint256[] memory all = _cardsOf(p, address(0));
            for (uint256 i; i < all.length; ++i) {
                if (cards.ownerOf(all[i]) != who) {
                    uint256[] memory x = new uint256[](ids.length + 1);
                    for (uint256 j; j < ids.length; ++j) x[j] = ids[j];
                    x[ids.length] = all[i];
                    ids = x;
                    valid = false;
                    break;
                }
            }
        } else if (variant % 5 == 1 && ids.length > 0) { // same card twice
            uint256[] memory x = new uint256[](ids.length + 1);
            for (uint256 j; j < ids.length; ++j) x[j] = ids[j];
            x[ids.length] = ids[0];
            ids = x;
            valid = false;
        }
        bool expected = p.sold() && valid && _accepts(who);
        uint256 bal0 = who.balance;
        _arm(who, p);
        curAction = CLAIM;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.claim, (ids)));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "claim: invalid claim accepted" : "claim: valid claim rejected");
        if (ok && who.balance - bal0 != p.perCard() * ids.length) _fail("I5: claim paid wrong amount");
    }

    /// Anyone pushes the shares of some cards to their current holders; holders that refuse ETH are credited.
    function claimFor(uint256 aSeed, uint256 pSeed, uint256 sub, uint256 variant) external step {
        Party p = _soldParty(pSeed);
        address who = _actor(aSeed);
        uint256[] memory ids = variant % 3 == 0 ? _cardsOf(p, address(0)) : _subset(_cardsOf(p, address(0)), sub);
        bool valid = true;
        if (variant % 7 == 1 && ids.length > 0) { // same card twice
            uint256[] memory x = new uint256[](ids.length + 1);
            for (uint256 j; j < ids.length; ++j) x[j] = ids[j];
            x[ids.length] = ids[0];
            ids = x;
            valid = false;
        } else if (variant % 7 == 2) { // a live card of another party
            for (uint256 i; i < parties.length; ++i) {
                if (address(parties[i]) == address(p)) continue;
                uint256[] memory other = _cardsOf(parties[i], address(0));
                if (other.length > 0) {
                    uint256[] memory x = new uint256[](ids.length + 1);
                    for (uint256 j; j < ids.length; ++j) x[j] = ids[j];
                    x[ids.length] = other[0];
                    ids = x;
                    valid = false;
                    break;
                }
            }
        }
        bool expected = p.sold() && valid;
        uint256 na = actors.length;
        uint256[] memory nOf = new uint256[](na);
        uint256[] memory bal0 = new uint256[](na);
        uint256[] memory owed0 = new uint256[](na);
        for (uint256 a; a < na; ++a) {
            bal0[a] = actors[a].balance;
            owed0[a] = p.owed(actors[a]);
            if (isContractActor[actors[a]]) _arm(actors[a], p);
        }
        if (valid) {
            for (uint256 i; i < ids.length; ++i) {
                address o = cards.ownerOf(ids[i]);
                for (uint256 a; a < na; ++a) if (actors[a] == o) ++nOf[a];
            }
        }
        curAction = CLAIMFOR;
        curParty = address(p);
        curActor = who;
        curSt = p.status();
        (bool ok,) = _as(who, address(p), 0, abi.encodeCall(Party.claimFor, (ids)));
        curOk = ok && ids.length > 0;
        if (ok != expected) return _fail(ok ? "claimFor: invalid claimFor accepted" : "claimFor: valid claimFor rejected");
        if (!ok) return;
        uint256 per = p.perCard();
        for (uint256 a; a < na; ++a) {
            uint256 paid = actors[a].balance - bal0[a];
            uint256 credited = p.owed(actors[a]) - owed0[a];
            if (paid + credited != per * nOf[a]) return _fail("claimFor: holder got wrong amount");
            if (!_accepts(actors[a]) && paid != 0) return _fail("claimFor: paid a rejecting holder");
            if (!isContractActor[actors[a]] && credited != 0) return _fail("claimFor: EOA credited instead of paid");
        }
        for (uint256 i; i < ids.length; ++i) {
            (bool live,) = _live(ids[i]);
            if (live) return _fail("claimFor: card not burned");
        }
    }

    function withdraw(uint256 wSeed) external step {
        Party p = _soldParty(wSeed >> 8);
        uint256 w = wSeed % 3;
        address who = w == 0 ? feeTo : w == 1 ? royaltyTo : _actor(wSeed >> 16);
        uint256 owed = p.owed(who);
        bool expected = owed > 0 && _accepts(who);
        uint256 bal0 = who.balance;
        _arm(who, p);
        curAction = WITHDRAW;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        (bool ok,) = isContractActor[who] || w == 2 ? _as(who, address(p), 0, abi.encodeCall(Party.withdraw, ()))
            : _prankCall(who, address(p), abi.encodeCall(Party.withdraw, ()));
        curOk = ok;
        if (ok != expected) return _fail(ok ? "withdraw: nothing owed but paid" : "withdraw: owed but rejected");
        if (ok && (who.balance - bal0 != owed || p.owed(who) != 0)) _fail("I5: withdraw amount");
    }

    function _prankCall(address who, address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = to.call(data);
    }

    /// Tries to move a Statement or push ETH / Credits into a party by paths other than the sanctioned ones.
    function steal(uint256 aSeed, uint256 pSeed, uint256 variant) external step {
        Party p = _party(pSeed);
        address who = _actor(aSeed);
        curAction = STEAL;
        curParty = address(p);
        curActor = who;
        if (curParty != address(0)) curSt = Party(payable(curParty)).status();
        bool ok;
        uint256 v = variant % 4;
        if (v == 0 && p.assembled()) {
            (ok,) = _as(who, address(statement), 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(p), who, p.statementId()));
        } else if (v == 1) {
            (ok,) = _as(who, address(p), 1 ether, "");
        } else if (v == 2) {
            uint256[] memory mine = credits.tokensOf(who);
            if (mine.length == 0) return;
            (ok,) = _as(who, address(credits), 0, abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", who, address(p), mine[0]));
        } else {
            (ok,) = _as(who, address(p), 0, abi.encodeCall(Party.transferHost, (who)));
            if (ok && who != p.host()) _fail("transferHost by non-host");
            ok = false; // host change by the host is legitimate
        }
        if (ok) _fail("steal path succeeded");
    }

    function warp(uint256 s) external step {
        uint256 d = s % 20 < 17 ? _bound(s >> 8, 1 hours, 2 days) : _bound(s >> 8, 2 days, 40 days);
        curAction = WARP;
        vm.warp(block.timestamp + d);
        vm.roll(block.number + d / 12);
        curOk = true;
    }

    // ------------------------------------------------------------------ reentry audit

    function reentrySuccesses() external view returns (uint256 n) {
        for (uint256 i; i < actors.length; ++i) if (isContractActor[actors[i]]) n += HostileActor(payable(actors[i])).reentrySuccesses();
    }

    function reentryAttempts() external view returns (uint256 n) {
        for (uint256 i; i < actors.length; ++i) if (isContractActor[actors[i]]) n += HostileActor(payable(actors[i])).reentryAttempts();
    }
}
