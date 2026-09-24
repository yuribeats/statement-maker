// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase, EthRejecter} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {TestnetPartyFactory} from "../../src/testnet/TestnetPartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement, ICreditTraits} from "../../src/interfaces/IExternal.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface ICreditsBurnW {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
}

/// Statement stand-in whose royaltyInfo answer (served by the fallback) can be made malformed in several ways.
contract WeirdStatement is ERC721 {
    ICreditsBurnW immutable credits;
    uint256 next = 1;
    uint8 public mode; // 0 normal, 1 revert, 2 32-byte answer, 3 dirty address, 4 burns all gas, 5 96-byte answer
    address public recv;
    uint256 public amt;

    constructor(address c) ERC721("W", "W") {
        credits = ICreditsBurnW(c);
    }

    function set(uint8 m, address r, uint256 a) external {
        mode = m;
        recv = r;
        amt = a;
    }

    function make(uint256[] calldata ids) external returns (uint256 id) {
        credits.burn(msg.sender, ids);
        id = next++;
        _mint(msg.sender, id);
    }

    fallback() external {
        uint8 m = mode;
        if (m == 1) revert("royalty says no");
        if (m == 4) {
            uint256 x;
            while (true) ++x;
        }
        bytes memory r;
        if (m == 2) r = abi.encode(uint256(1));
        else if (m == 3) r = abi.encode((uint256(1) << 160) | uint256(uint160(recv)), amt);
        else if (m == 5) r = abi.encode(recv, amt, uint256(7));
        else r = abi.encode(recv, amt);
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}

/// Refuses ETH until switched on.
contract ToggleReceiver {
    bool public open;

    function setOpen(bool o) external {
        open = o;
    }

    receive() external payable {
        require(open, "closed");
    }

    function withdraw(Party p) external {
        p.withdraw();
    }
}

/// Accepts ETH but spends more than the 50k gas claimFor forwards.
contract GasHog {
    uint256[8] public slots;

    receive() external payable {
        for (uint256 i; i < 8; ++i) slots[i] = block.timestamp + i + 1;
    }
}

/// Regression tests for the audit-fix batch (884add5) and the voted buy wait (89f4ff3): each fix, positive and
/// negative, plus the grief scenarios from audit/static/TRIAGE.md.
abstract contract FixesBase is UnitBase {
    uint256 constant FLOOR = 3 ether;

    // ------------------------------------------------------------------ helpers

    function _prop(Party party, address who, Party.PriceSpec memory s, uint16 wait) internal virtual returns (uint256 id) {
        vm.prank(who);
        id = party.propose(s, false, 24, wait);
    }

    function _cancel(Party party, address who) internal returns (uint256 id) {
        Party.PriceSpec memory z;
        vm.prank(who);
        id = party.propose(z, true, 0, 0);
    }

    function _vote(Party party, address who, uint256 id, bool yes) internal {
        vm.prank(who);
        party.vote(id, yes);
    }

    function _end(Party party, uint256 id) internal {
        vm.warp(party.proposal(id).endsAt);
    }

    function _ex(Party party, address who, uint256 id, Party.Floor memory f) internal {
        vm.prank(who);
        party.execute(id, f);
    }

    function _exFail(Party party, address who, uint256 id, Party.Floor memory f, bytes memory err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        party.execute(id, f);
    }

    function _pct(int256 bps) internal pure returns (Party.PriceSpec memory) {
        return Party.PriceSpec(Party.PriceMode.FloorPct, bps);
    }

    function _delta(int256 w) internal pure returns (Party.PriceSpec memory) {
        return Party.PriceSpec(Party.PriceMode.FloorDelta, w);
    }

    /// Filled by holders[0]/[1], assembled with `f`, cards spread over fresh voters.
    function _assembled(Party.Params memory p, Party.Floor memory f, uint256[] memory counts)
        internal
        returns (Party party, address[] memory v)
    {
        party = newParty(p);
        fill(party);
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, f);
        v = spread(party, counts);
    }

    function _buyer(uint256 eth) internal returns (address b) {
        b = makeAddr("buyer");
        vm.deal(b, eth);
    }

}

/// Governance, deadlock, buy wait, minimum ask, floor readings, fixed price without floor.
contract FixesTest is FixesBase {
    // ================================================================== T-1: no lifetime proposal cap

    /// Grief: one card rotated over 100 fresh addresses opens 300 proposals (the old lifetime cap was 256). The
    /// 79-card majority still proposes, passes and executes both a LIST and a CANCEL afterwards.
    function test_grief_proposalSpamCannotFreezeGovernance() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        address cur = v[1];
        uint256 card = cardsOf(party, cur)[0];
        for (uint256 s; s < 100; ++s) {
            for (uint256 k; k < 3; ++k) {
                vm.prank(cur);
                party.propose(fixedPrice(1e24), false, 168, 0);
            }
            vm.prank(cur);
            vm.expectRevert(bad("open limit")); // per-proposer: at most 3 open
            party.propose(fixedPrice(1e24), false, 168, 0);
            address nx = makeAddr(string.concat("sybil", vm.toString(s)));
            vm.prank(cur);
            cards.transferFrom(cur, nx, card);
            cur = nx;
            roll();
        }
        assertEq(party.proposalCount(), 300);
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 24);
        _end(party, id);
        _ex(party, v[0], id, floorSig(FLOOR, 0));
        assertEq(party.ask(), 5 ether);
        uint256 c = _cancel(party, v[0]);
        _end(party, c);
        _ex(party, v[0], c, noFloor());
        assertEq(party.ask(), 0);
    }

    function test_openProposalsOf_tracksOnlyOpenOnes() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        vm.prank(v[0]);
        uint256 a = party.propose(fixedPrice(5 ether), false, 24, 0);
        vm.prank(v[0]);
        uint256 b = party.propose(fixedPrice(5 ether), false, 168, 0);
        uint256[] memory open = party.openProposalsOf(v[0]);
        assertEq(open.length, 2);
        assertEq(open[0], a);
        assertEq(open[1], b);
        assertEq(party.openProposalsOf(v[1]).length, 0);
        vm.warp(party.proposal(a).endsAt); // a closes, b still open
        vm.prank(v[0]);
        uint256 c = party.propose(fixedPrice(6 ether), false, 24, 0);
        open = party.openProposalsOf(v[0]);
        assertEq(open.length, 2, "closed one dropped on the next propose");
        assertTrue((open[0] == b && open[1] == c) || (open[0] == c && open[1] == b));
    }

    // ================================================================== T-2: countBlocked

    function test_countBlocked_needs41Yes_boundary() public {
        (Party party, address[] memory v) = assembledWithVoters(c3(40, 1, 39));
        uint256 id40 = _prop(party, v[0], fixedPrice(5 ether), 0);
        _vote(party, v[1], id40, false);
        _end(party, id40);
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(id40); // 40 YES + NO: would not have passed anyway

        roll();
        uint256 id41 = _prop(party, v[0], fixedPrice(5 ether), 0);
        _vote(party, v[2], id41, true);
        _vote(party, v[1], id41, false);
        assertEq(party.proposal(id41).yes, 79);
        _end(party, id41);
        vm.expectEmit(address(party));
        emit Party.BlockedCounted(id41, 1);
        party.countBlocked(id41);
        assertTrue(party.blockedCounted(id41));
        assertEq(party.blockedPriceProposals(), 1);
    }

    /// Grief (T-2): a 1-card holder NO-votes its own proposals; none count, so the NO veto survives.
    function test_grief_selfNoCannotTriggerDeadlock() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(79, 1));
        uint256[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            ids[i] = _prop(party, v[1], fixedPrice(5 ether), 0);
            _vote(party, v[1], ids[i], false);
        }
        _end(party, ids[2]);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(bad("not blocked"));
            party.countBlocked(ids[i]);
        }
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 0);
        assertFalse(party.proposal(id).deadlock);
        _vote(party, v[1], id, false);
        _end(party, id);
        _exFail(party, v[0], id, floorSig(FLOOR, 0), bad("did not pass")); // one NO still blocks
    }

    function test_countBlocked_staleEpochRejected() public {
        (Party party, address[] memory v) = assembledWithVoters(c3(41, 38, 1));
        uint256 a = _prop(party, v[0], fixedPrice(5 ether), 0);
        _vote(party, v[2], a, false); // blocked: 41 YES, 1 NO
        uint256 b = _prop(party, v[1], fixedPrice(6 ether), 0);
        _vote(party, v[0], b, true); // 79 YES, passes
        _end(party, b);
        _ex(party, v[0], b, floorSig(FLOOR, 0)); // epoch bump
        vm.expectRevert(bad("not blocked"));
        party.countBlocked(a); // blocked in an older epoch: does not count
    }

    function test_execute_resetsPartialBlockedCount() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(60, 20));
        for (uint256 i; i < 2; ++i) {
            uint256 x = _prop(party, v[0], fixedPrice(5 ether), 0);
            _vote(party, v[1], x, false);
        }
        uint256 ok = _prop(party, v[0], fixedPrice(5 ether), 0);
        vm.warp(block.timestamp + 24 hours);
        party.countBlocked(0);
        party.countBlocked(1);
        assertEq(party.blockedPriceProposals(), 2);
        _ex(party, v[0], ok, floorSig(FLOOR, 0));
        assertEq(party.blockedPriceProposals(), 0);
        roll();
        uint256 x2 = _prop(party, v[0], fixedPrice(6 ether), 0);
        _vote(party, v[1], x2, false);
        _end(party, x2);
        party.countBlocked(x2);
        assertEq(party.blockedPriceProposals(), 1);
        uint256 next = _prop(party, v[0], fixedPrice(6 ether), 0);
        assertFalse(party.proposal(next).deadlock, "1 block after the reset is not a deadlock");
    }

    function test_countBlocked_threeCountedThenDeadlock() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(54, 26));
        for (uint256 i; i < 3; ++i) {
            uint256 x = _prop(party, v[0], fixedPrice(5 ether), 0);
            _vote(party, v[1], x, false);
        }
        vm.warp(block.timestamp + 24 hours);
        for (uint256 i; i < 3; ++i) party.countBlocked(i);
        uint256 d = _prop(party, v[0], fixedPrice(5 ether), 0);
        assertTrue(party.proposal(d).deadlock);
    }

    // ================================================================== deadlock clock

    function test_deadlockClock_startsAtAssembly_notFull() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 60;
        Party party = newParty(p);
        fill(party);
        uint256 full = party.fullAt();
        vm.warp(full + 29 days);
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        roll();
        vm.warp(full + 31 days); // 31 days after FULL, 2 after assembly
        vm.prank(holders[0]);
        uint256 a = party.propose(fixedPrice(5 ether), false, 24, 0);
        assertFalse(party.proposal(a).deadlock);
        vm.warp(uint256(party.assembledAt()) + 30 days);
        vm.prank(holders[0]);
        uint256 b = party.propose(fixedPrice(5 ether), false, 24, 0);
        assertFalse(party.proposal(b).deadlock, "exactly 30 days after assembly");
        vm.warp(uint256(party.assembledAt()) + 30 days + 1);
        vm.prank(holders[0]);
        uint256 c = party.propose(fixedPrice(5 ether), false, 24, 0);
        assertTrue(party.proposal(c).deadlock);
    }

    function test_deadlockClock_lastExecutionWinsOverAssembly() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        vm.warp(block.timestamp + 20 days);
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 0);
        _end(party, id);
        _ex(party, v[0], id, noFloor());
        uint256 e = block.timestamp;
        vm.warp(uint256(party.assembledAt()) + 30 days + 1); // past 30 days from assembly, not from execution
        uint256 a = _prop(party, v[0], fixedPrice(6 ether), 0);
        assertFalse(party.proposal(a).deadlock);
        vm.warp(e + 30 days + 1);
        uint256 b = _prop(party, v[0], fixedPrice(6 ether), 0);
        assertTrue(party.proposal(b).deadlock);
    }

    // ================================================================== buy wait (voted with each price)

    function _assembledWithWait(uint16 wait) internal returns (Party party) {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.buyDelayHours = wait;
        party = newParty(p);
        fill(party);
        assembleDeposit(party);
    }

    function test_buyWait_defaultAtAssembly_0_1_72() public {
        uint16[3] memory waits = [uint16(0), 1, 72];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            Party party = _assembledWithWait(waits[i]);
            uint256 opens = uint256(party.assembledAt()) + uint256(waits[i]) * 1 hours;
            assertEq(party.buyableAt(), opens);
            address b = _buyer(10 ether);
            if (waits[i] > 0) {
                vm.warp(opens - 1);
                vm.prank(b);
                vm.expectRevert(bad("not open yet"));
                party.buy{value: 3 ether}(3 ether);
            }
            vm.warp(opens); // wait 0: same block as the assembly
            vm.prank(b);
            party.buy{value: 3 ether}(3 ether);
            assertTrue(party.sold());
            vm.revertToState(snap);
        }
    }

    function test_buyWait_bounds_init() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.buyDelayHours = 73;
        uint256[] memory ids = first(holders[0], 1);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectRevert(bad("buyDelay"));
        factory.createParty(p, ids, new bytes32[][](0));
        vm.stopPrank();
        p.buyDelayHours = 72;
        Party party = newParty(p);
        assertEq(party.params().buyDelayHours, 72);
    }

    function test_buyWait_bounds_propose() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(40, 40));
        vm.prank(v[0]);
        vm.expectRevert(bad("buyDelay"));
        party.propose(fixedPrice(5 ether), false, 24, 73);
        vm.prank(v[0]);
        uint256 ok = party.propose(fixedPrice(5 ether), false, 24, 72);
        assertEq(party.proposal(ok).buyDelayHours, 72);
        // cancels ignore the wait (any value accepted, stored as 0) and always run 24 hours
        Party.PriceSpec memory z;
        vm.prank(v[1]);
        uint256 c = party.propose(z, true, 168, type(uint16).max);
        assertEq(party.proposal(c).buyDelayHours, 0);
        assertEq(party.proposal(c).endsAt, block.timestamp + 24 hours, "cancel window is always 24h");
    }

    function test_buyWait_executedListUsesItsOwnWait() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80)); // default wait 24h
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 2);
        _end(party, id);
        _ex(party, v[0], id, noFloor());
        assertEq(party.buyableAt(), block.timestamp + 2 hours);
        address b = _buyer(10 ether);
        vm.warp(block.timestamp + 2 hours - 1);
        vm.prank(b);
        vm.expectRevert(bad("not open yet"));
        party.buy{value: 5 ether}(5 ether);
        vm.warp(block.timestamp + 1);
        vm.prank(b);
        party.buy{value: 5 ether}(5 ether);
    }

    function test_buyWait_zeroWaitList_buyableImmediately() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 id = _prop(party, v[0], fixedPrice(4 ether), 0);
        _end(party, id);
        _ex(party, v[0], id, noFloor());
        assertEq(party.buyableAt(), block.timestamp);
        address b = _buyer(10 ether);
        vm.prank(b);
        party.buy{value: 4 ether}(4 ether);
    }

    function test_buyWait_pendingPriceCarriesItsWaitIntoAssembly() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit)); // default wait 24h
        fill(party);
        address[] memory v = spread(party, one(80));
        uint256 id = _prop(party, v[0], fixedPrice(7 ether), 5);
        _end(party, id);
        vm.expectEmit(address(party));
        emit Party.PendingPriceSet(id, Party.PriceMode.Fixed, 7 ether);
        _ex(party, v[0], id, noFloor());
        assertEq(party.buyableAt(), 0, "nothing buyable while FULL");
        vm.warp(block.timestamp + 3 hours);
        uint256[] memory dep = party.depositOrder();
        vm.prank(v[0]);
        party.assemble(dep, noFloor());
        assertEq(party.ask(), 7 ether);
        assertEq(party.buyableAt(), block.timestamp + 5 hours, "voted 5h, not the 24h default");
    }

    function test_buyWait_raiseAskAndCancelDoNotMoveBuyableAt() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        (Party party, address[] memory v) = _assembled(p, floorSig(2 ether, 0), one(80));
        uint64 opens = party.buyableAt();
        vm.warp(block.timestamp + 30 minutes);
        party.raiseAsk(floorSig(3 ether, 0));
        assertEq(party.buyableAt(), opens, "raise keeps the wait");
        uint256 c = _cancel(party, v[0]);
        _end(party, c);
        _ex(party, v[0], c, noFloor());
        assertEq(party.ask(), 0);
        address b = _buyer(10 ether);
        vm.prank(b);
        vm.expectRevert(bad("not for sale"));
        party.buy{value: 3 ether}(3 ether);
    }

    /// T-3 as the owner now intends it: a voted wait longer than the 24-hour cancel window lets a cancel land
    /// before buying opens.
    function test_cancelRace_longWait_cancelLandsFirst() public {
        Party party = _assembledWithWait(26);
        address[] memory v = spread(party, one(80));
        uint256 c = _cancel(party, v[0]);
        _end(party, c);
        assertLt(block.timestamp, party.buyableAt());
        _ex(party, v[0], c, noFloor());
        vm.warp(uint256(party.assembledAt()) + 26 hours);
        address b = _buyer(10 ether);
        vm.prank(b);
        vm.expectRevert(bad("not for sale"));
        party.buy{value: 3 ether}(3 ether);
    }

    /// ... and with a short wait (site default 1 hour) the sale wins: a passed price is a legitimate sale (by design,
    /// replaces the old T-3 guarantee).
    function test_cancelRace_shortWait_saleWinsByDesign() public {
        Party party = _assembledWithWait(1);
        address[] memory v = spread(party, one(80));
        uint256 c = _cancel(party, v[0]);
        vm.warp(party.buyableAt());
        address b = _buyer(10 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        _end(party, c);
        _exFail(party, v[0], c, noFloor(), bad("status"));
    }

    // ================================================================== T-4a: host minimum ask

    function test_minAsk_requiredForFloorRelativeDefault() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 0;
        uint256[] memory ids = first(holders[0], 1);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(address(factory), true);
        p.defaultPrice = _pct(0);
        vm.expectRevert(bad("minAsk"));
        factory.createParty(p, ids, new bytes32[][](0));
        p.defaultPrice = _delta(0);
        vm.expectRevert(bad("minAsk"));
        factory.createParty(p, ids, new bytes32[][](0));
        p.defaultPrice = fixedPrice(1 ether); // fixed default: no minimum needed
        Party party = factory.createParty(p, ids, new bytes32[][](0));
        vm.stopPrank();
        assertEq(party.params().minAskWei, 0);
    }

    /// Grief (T-4): a compromised floor key signs 1 gwei at assembly; the ask cannot go below the host's minimum.
    function test_grief_compromisedFloorAtAssembly_clampedToMinAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        p.minAskWei = 2 ether;
        (Party party,) = _assembled(p, floorSig(1 gwei, 0), one(80));
        assertEq(party.ask(), 2 ether);
        // an honest reading above the minimum is used as is
        Party party2;
        {
            Party.Params memory q = params(CreditKeys.Preset.Deposit);
            q.defaultPrice = _pct(0);
            q.minAskWei = 2 ether;
            party2 = openParty(q, holders[2], first(holders[2], 40));
            deposit(party2, holders[3], first(holders[3], 40));
            uint256[] memory dep = party2.depositOrder();
            Party.Floor memory f = floorSig(5 ether, 0);
            vm.prank(holders[2]);
            party2.assemble(dep, f);
        }
        assertEq(party2.ask(), 5 ether);
    }

    function test_grief_compromisedFloorAtExecute_clampedToMinAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 1 ether; // fixed 3 ETH default; floor-relative votes still clamp
        (Party party, address[] memory v) = _assembled(p, noFloor(), one(80));
        uint256 id = _prop(party, v[0], _pct(-5000), 1);
        _end(party, id);
        _ex(party, v[0], id, floorSig(1 gwei, 0));
        assertEq(party.ask(), 1 ether);
        uint256 id2 = _prop(party, v[0], _delta(-1 ether), 1);
        _end(party, id2);
        _ex(party, v[0], id2, floorSig(1.5 ether, 0)); // 0.5 ETH resolved
        assertEq(party.ask(), 1 ether);
        uint256 id3 = _prop(party, v[0], _delta(-1 ether), 1);
        _end(party, id3);
        _ex(party, v[0], id3, floorSig(4 ether, 0)); // 3 ETH resolved, above the minimum
        assertEq(party.ask(), 3 ether);
    }

    /// A clamped price is compared with the floor as clamped: below an honest floor it still needs 60. With a
    /// compromised (low) floor the clamped price counts as at/above floor, so 41 suffices, but the ask is still
    /// the host minimum.
    function test_minAsk_clampedPriceThresholds() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 0.8 ether;
        (Party party, address[] memory v) = _assembled(p, noFloor(), c2(59, 21));
        uint256 id = _prop(party, v[0], _pct(-5000), 1); // 0.5 ETH at a 1 ETH floor, clamped to 0.8 < 1
        _end(party, id);
        assertEq(party.needFor(id, 0.8 ether, 1 ether), 60);
        _exFail(party, v[0], id, floorSig(1 ether, 0), bad("did not pass"));
        _ex(party, v[0], id, floorSig(0.1 ether, 0)); // low floor: 0.05 resolved, clamped 0.8 >= 0.1: 41 rule
        assertEq(party.ask(), 0.8 ether);
    }

    function test_minAsk_doesNotApplyToFixedPrices() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 1 ether;
        (Party party, address[] memory v) = _assembled(p, noFloor(), one(80));
        uint256 id = _prop(party, v[0], fixedPrice(0.1 ether), 0);
        _end(party, id);
        _ex(party, v[0], id, noFloor());
        assertEq(party.ask(), 0.1 ether, "an explicitly voted fixed price is not clamped");
    }

    function test_minAsk_raiseAskClamps() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        p.minAskWei = 2 ether;
        (Party party,) = _assembled(p, floorSig(1 ether, 0), one(80));
        assertEq(party.ask(), 2 ether);
        vm.warp(block.timestamp + 1);
        Party.Floor memory low = floorSig(1.5 ether, 0);
        vm.expectRevert(bad("not higher"));
        party.raiseAsk(low); // clamps to 2 ETH: not higher
        party.raiseAsk(floorSig(2.5 ether, 0));
        assertEq(party.ask(), 2.5 ether);
    }

    /// Observed: a floor-relative price that resolves to <= 0 reverts instead of clamping to minAskWei.
    function test_minAsk_nonPositiveResolveStillReverts() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minAskWei = 1 ether;
        (Party party, address[] memory v) = _assembled(p, noFloor(), one(80));
        uint256 id = _prop(party, v[0], _delta(-2 ether), 1);
        _end(party, id);
        _exFail(party, v[0], id, floorSig(1 ether, 0), bad("price <= 0"));
    }

    // ================================================================== T-4b: monotonic floor readings

    function test_olderFloor_rejected_raiseAsk() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        (Party party,) = _assembled(p, floorSig(2 ether, 0), one(80));
        uint64 t0 = uint64(block.timestamp);
        assertEq(party.lastFloorAt(), t0, "assembly records the reading it used");
        vm.warp(t0 + 8 minutes);
        Party.Floor memory newer = floorAt(3 ether, 0, t0 + 6 minutes, signerKey, factory);
        Party.Floor memory older = floorAt(4 ether, 0, t0 + 4 minutes, signerKey, factory);
        party.raiseAsk(newer);
        assertEq(party.lastFloorAt(), t0 + 6 minutes);
        vm.expectRevert(bad("older floor"));
        party.raiseAsk(older); // fresh (< 10 min) and higher, but older than the last reading used
        Party.Floor memory same = floorAt(3.5 ether, 0, t0 + 6 minutes, signerKey, factory);
        party.raiseAsk(same); // same issuedAt is allowed
        assertEq(party.ask(), 3.5 ether);
    }

    /// Grief (T-4): the executor cannot cherry-pick the lowest reading of the past 10 minutes once a newer one was used.
    function test_grief_staleOlderFloorRejectedAtExecute() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        (Party party, address[] memory v) = _assembled(p, floorSig(2 ether, 0), one(80));
        uint256 id = _prop(party, v[0], _pct(-1000), 1);
        _end(party, id);
        uint64 t = uint64(block.timestamp);
        Party.Floor memory low = floorAt(1 ether, 0, t - 8 minutes, signerKey, factory);
        party.raiseAsk(floorAt(5 ether, 0, t - 4 minutes, signerKey, factory)); // a keeper used a newer reading
        _exFail(party, v[0], id, low, bad("older floor"));
        _ex(party, v[0], id, floorAt(5 ether, 0, t, signerKey, factory));
        assertEq(party.ask(), 4.5 ether);
    }

    function test_olderFloor_revertedCallDoesNotAdvance() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = _pct(0);
        (Party party,) = _assembled(p, floorSig(2 ether, 0), one(80));
        vm.warp(block.timestamp + 10 minutes);
        uint64 before = party.lastFloorAt();
        Party.Floor memory low = floorSig(1 ether, 0);
        vm.expectRevert(bad("not higher"));
        party.raiseAsk(low);
        assertEq(party.lastFloorAt(), before);
        Party.Floor memory forged = floorAt(9 ether, 0, uint64(block.timestamp), 0xB0B, factory);
        vm.expectRevert(bad("floor sig"));
        party.raiseAsk(forged);
        assertEq(party.lastFloorAt(), before);
    }

    // ================================================================== T-4c: fixed price without a floor reading

    function _fixedNoFloorCase(uint256 yesW, bool pass) internal {
        (Party party, address[] memory v) = assembledWithVoters(c2(yesW, 80 - yesW));
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 0); // above any sane floor
        _end(party, id);
        assertEq(party.needFor(id, 5 ether, type(uint256).max), 60);
        if (pass) {
            _ex(party, v[1], id, noFloor());
            assertEq(party.ask(), 5 ether);
            assertEq(party.lastFloorAt(), 0);
        } else {
            _exFail(party, v[1], id, noFloor(), bad("did not pass"));
            _ex(party, v[1], id, floorSig(FLOOR, 0)); // with a reading, 5 ETH >= floor needs only 41
            assertEq(party.ask(), 5 ether);
        }
    }

    function test_fixedNoFloor_60passes() public { _fixedNoFloorCase(60, true); }
    function test_fixedNoFloor_59fails() public { _fixedNoFloorCase(59, false); }

    function test_fixedNoFloor_sigLengthDecides() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(59, 21));
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 0);
        _end(party, id);
        // floorWei/issuedAt filled but no signature: still "no reading" (needs 60)
        _exFail(party, v[0], id, Party.Floor(1 wei, uint64(block.timestamp), ""), bad("did not pass"));
        // a non-empty invalid signature is not downgraded to "no reading"
        _exFail(party, v[0], id, Party.Floor(1 wei, uint64(block.timestamp), hex"00"), bad("floor sig"));
    }

    function test_fixedNoFloor_underDeadlockStillNeeds60() public {
        (Party party, address[] memory v) = assembledWithVoters(c2(59, 21));
        vm.warp(uint256(party.assembledAt()) + 30 days + 1);
        uint256 id = _prop(party, v[0], fixedPrice(5 ether), 0);
        assertTrue(party.proposal(id).deadlock);
        _end(party, id);
        _exFail(party, v[0], id, noFloor(), bad("did not pass")); // 59 >= 54, but no reading means 60
        _ex(party, v[0], id, floorSig(FLOOR, 0)); // with a reading: 54 rule applies
    }

    function test_floorRelativeNoFloor_rejected() public {
        (Party party, address[] memory v) = assembledWithVoters(one(80));
        uint256 id = _prop(party, v[0], _delta(1 ether), 1);
        _end(party, id);
        _exFail(party, v[0], id, noFloor(), bad("stale floor"));
    }

    function test_fixedNoFloor_whileFull_setsPending() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        address[] memory v = spread(party, one(80));
        uint256 id = _prop(party, v[0], fixedPrice(6 ether), 3);
        _end(party, id);
        _ex(party, v[0], id, noFloor());
        assertTrue(party.hasPendingPrice());
    }

}

/// Royalty call, claimFor, fill grace, time unit, opening deposit, order verification.
contract FixesSaleTest is FixesBase {
    // ================================================================== T-5: royaltyInfo is never called (no royalty leg)

    function _weirdParty(uint8 mode, address r, uint256 a) internal returns (Party party, WeirdStatement st) {
        st = new WeirdStatement(address(credits));
        st.set(mode, r, a);
        PartyFactory f2 = new PartyFactory(ICredits(address(credits)), IStatement(address(st)), feeTo, vm.addr(signerKey), collectionOwner, traits);
        party = openPartyWith(f2, params(CreditKeys.Preset.Deposit), holders[0], first(holders[0], 60), new bytes32[][](0));
        deposit(party, holders[1], first(holders[1], 20));
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        vm.warp(party.buyableAt());
    }

    function _buyWeird(uint8 mode, address r, uint256 a) internal returns (Party party) {
        WeirdStatement st;
        (party, st) = _weirdParty(mode, r, a);
        address b = _buyer(3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        assertEq(st.ownerOf(1), b);
    }

    function test_royalty_malformedAnswersIgnored() public {
        address artist = makeAddr("artist");
        uint256 noRoyaltyShare = (3 ether - 3 ether / 100) / 80;
        uint8[4] memory modes = [uint8(1), 2, 3, 4]; // revert, short, dirty address, gas bomb
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            Party party = _buyWeird(modes[i], artist, 0.1 ether);
            assertEq(party.owed(artist), 0);
            assertEq(party.perCard(), noRoyaltyShare);
            vm.revertToState(snap);
        }
    }

    /// No creator royalty is paid, even for a well-formed ERC-2981 answer (any length, any amount).
    function test_royalty_wellFormedAnswerNeverPaid() public {
        address artist = makeAddr("artist");
        uint8[2] memory modes = [uint8(0), 5];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            Party party = _buyWeird(modes[i], artist, 0.1 ether);
            assertEq(party.owed(artist), 0);
            assertEq(party.perCard(), (3 ether - 3 ether / 100) / 80);
            vm.revertToState(snap);
        }
    }

    // ================================================================== T-6: claimFor

    function _sold() internal returns (Party party) {
        party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.warp(party.buyableAt());
        address b = _buyer(3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
    }

    function test_claimFor_paysCurrentHolders_anyoneCalls() public {
        Party party = _sold();
        uint256 per = party.perCard();
        address friend = makeAddr("friend");
        vm.prank(holders[0]);
        cards.transferFrom(holders[0], friend, 2);
        vm.expectEmit(address(party));
        emit Party.Claimed(holders[0], 1, per);
        vm.expectEmit(address(party));
        emit Party.Claimed(friend, 2, per);
        vm.prank(makeAddr("keeper"));
        party.claimFor(c3(1, 2, 61));
        assertEq(holders[0].balance, per);
        assertEq(friend.balance, per);
        assertEq(holders[1].balance, per);
        assertEq(party.cardsOutstanding(), 77);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        party.claimFor(one(1)); // burned
        vm.prank(holders[0]);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        party.claim(one(1));
    }

    /// Grief (T-6): a holder contract that rejects ETH neither blocks the batch nor loses its share.
    function test_claimFor_rejectingContract_creditedOwed() public {
        Party party = _sold();
        uint256 per = party.perCard();
        ToggleReceiver tr = new ToggleReceiver();
        GasHog hog = new GasHog();
        EthRejecter rj = new EthRejecter();
        vm.startPrank(holders[0]);
        cards.transferFrom(holders[0], address(tr), 3);
        cards.transferFrom(holders[0], address(hog), 4);
        cards.transferFrom(holders[0], address(rj), 5);
        vm.stopPrank();
        party.claimFor(c3(3, 4, 5));
        party.claimFor(one(6));
        assertEq(party.owed(address(tr)), per);
        assertEq(party.owed(address(hog)), per, "over 50k gas: credited, not paid");
        assertEq(party.owed(address(rj)), per);
        assertEq(holders[0].balance, per, "the rest of the batch still paid");
        assertEq(address(party).balance, party.owed(feeTo) + 3 * per + per * party.cardsOutstanding());
        tr.setOpen(true);
        vm.expectEmit(address(party));
        emit Party.Withdrawn(address(tr), per);
        tr.withdraw(party);
        assertEq(address(tr).balance, per);
        assertEq(party.owed(address(tr)), 0);
    }

    function test_claimFor_negatives() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        fill(party);
        assembleDeposit(party);
        vm.expectRevert(bad("not sold"));
        party.claimFor(one(1));
        Party other = openParty(params(CreditKeys.Preset.Deposit), holders[2], first(holders[2], 1)); // card 81
        vm.warp(party.buyableAt());
        address b = _buyer(3 ether);
        vm.prank(b);
        party.buy{value: 3 ether}(3 ether);
        vm.expectRevert(bad("not this party"));
        party.claimFor(one(81));
        vm.expectRevert(bad("not this party"));
        party.claimFor(one(999)); // never minted
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        party.claimFor(c2(7, 7)); // duplicate in one call
        assertEq(other.count(), 1);
    }

    function test_claimFor_fullDrain() public {
        Party party = _sold();
        uint256[] memory all = partyCards(party);
        party.claimFor(all);
        assertEq(party.cardsOutstanding(), 0);
        vm.prank(feeTo);
        party.withdraw();
        assertEq(address(party).balance, 0);
    }

    // ================================================================== fill grace

    function test_fillGrace_lateFillExtendsDeadline() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 1;
        Party party = newParty(p);
        vm.warp(uint256(party.deadline()) - 1 hours);
        fill(party);
        assertEq(party.deadline(), block.timestamp + 2 days);
        vm.warp(block.timestamp + 2 days);
        assertEq(uint256(party.status()), uint256(Party.Status.FULL));
        vm.warp(block.timestamp + 1);
        assertEq(uint256(party.status()), uint256(Party.Status.EXPIRED));
    }

    function test_fillGrace_earlyFillLeavesDeadline() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 3;
        Party party = newParty(p);
        uint64 d = party.deadline();
        vm.warp(uint256(d) - 2 days); // exactly two days left: unchanged
        fill(party);
        assertEq(party.deadline(), d);
    }

    // ================================================================== time unit (testnet factory)

    function test_timeUnit_scalesBuyWaitAndGrace() public {
        TestnetPartyFactory tf = new TestnetPartyFactory(
            ICredits(address(credits)), IStatement(address(statement)), feeTo, vm.addr(signerKey), collectionOwner, traits, 60
        );
        Party.Params memory p = params(CreditKeys.Preset.Deposit); // 24h wait, 1 day duration below
        p.durationDays = 1;
        Party party = openPartyWith(tf, p, holders[0], first(holders[0], 60), new bytes32[][](0));
        assertEq(party.deadline(), block.timestamp + 1440, "1 day = 1440 s at 60 s per hour");
        vm.warp(uint256(party.deadline()) - 10);
        deposit(party, holders[1], first(holders[1], 20));
        assertEq(party.deadline(), block.timestamp + 2880, "2-day grace = 2880 s");
        uint256[] memory dep = party.depositOrder();
        vm.prank(holders[0]);
        party.assemble(dep, noFloor());
        assertEq(party.buyableAt(), block.timestamp + 1440, "24h wait = 1440 s");
    }

    // ================================================================== opening deposit

    function test_onDeposit_onlyFactory() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        uint256[] memory ids = first(holders[0], 1);
        vm.prank(holders[0]);
        vm.expectRevert(bad("factory only"));
        party.onDeposit(holders[0], ids, new bytes32[][](0));
        vm.prank(address(factory)); // even the factory cannot record a Credit the party did not receive
        vm.expectRevert(bad("not received"));
        party.onDeposit(holders[0], ids, new bytes32[][](0));
    }

    /// Only the factory can record a deposit; it moves Credits only from its own caller.
    function test_onDeposit_factoryOnly_strayCannotBeClaimed() public {
        Party party = newParty(params(CreditKeys.Preset.Deposit));
        uint256 id = first(holders[1], 1)[0];
        vm.prank(holders[1]);
        credits.transferFrom(holders[1], address(party), id); // a stray Credit sent straight to the party
        vm.prank(holders[1]);
        vm.expectRevert(bad("factory only"));
        party.onDeposit(holders[1], one(id), new bytes32[][](0));
        vm.startPrank(holders[1]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(factory), id));
        factory.deposit(party, one(id), new bytes32[][](0)); // the factory pulls from the caller, who no longer owns it
        vm.stopPrank();
        assertEq(party.count(), 1);
    }

    function test_factoryDeposit_rejectsUnknownParty() public {
        Party raw = Party(payable(Clones.clone(address(factory.implementation()))));
        uint256[] memory ids = first(holders[1], 1);
        vm.startPrank(holders[1]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectRevert(bytes("not a party"));
        factory.deposit(raw, ids, new bytes32[][](0));
        vm.expectRevert(bytes("not a party"));
        factory.deposit(Party(payable(makeAddr("eoa"))), ids, new bytes32[][](0));
        vm.stopPrank();
        assertEq(credits.ownerOf(ids[0]), holders[1]);
    }

    /// Approving the (predicted) party address, the old flow, no longer does anything: only the factory is approved.
    function test_opening_requiresApprovalOfFactory() public {
        uint256[] memory ids = first(holders[0], 1);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(predicted, true);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(factory), ids[0]));
        factory.createParty(params(CreditKeys.Preset.Deposit), ids, new bytes32[][](0));
        vm.stopPrank();
        assertEq(factory.partiesCount(), 0);
        assertEq(factory.nonces(holders[0]), 0, "failed creation does not burn a nonce");
    }

    function test_opening_belowMinimumRejected() public {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.minDeposit = 5;
        uint256[] memory ids = first(holders[0], 4);
        address predicted = factory.predictParty(holders[0]);
        vm.startPrank(holders[0]);
        credits.setApprovalForAll(address(factory), true);
        vm.expectRevert(bad("count"));
        factory.createParty(p, ids, new bytes32[][](0));
        vm.expectRevert(bad("count"));
        factory.createParty(p, new uint256[](0), new bytes32[][](0));
        vm.stopPrank();
    }

    function test_predictParty_perHostNonces() public {
        address a0 = factory.predictParty(holders[0]);
        address b0 = factory.predictParty(holders[1]);
        assertTrue(a0 != b0);
        Party p0 = newParty(params(CreditKeys.Preset.Deposit));
        assertEq(address(p0), a0);
        assertEq(factory.predictParty(holders[1]), b0, "other hosts' predictions unaffected");
        Party p1 = newParty(params(CreditKeys.Preset.Deposit));
        assertTrue(address(p1) != a0);
        assertEq(factory.nonces(holders[0]), 2);
    }

    // ================================================================== order verification lives in CreditKeys

    function test_verifyOrder_sameRevertDataAsParty() public {
        assertEq(CreditKeys.Bad.selector, Party.Bad.selector);
        OrderProbe op = new OrderProbe(c3(5, 6, 7));
        vm.expectRevert(bad("length"));
        op.verify(CreditKeys.Preset.Deposit, traits, c2(5, 6));
        vm.expectRevert(bad("repeat"));
        op.verify(CreditKeys.Preset.Manual, traits, c3(5, 5, 6));
        vm.expectRevert(bad("not deposited"));
        op.verify(CreditKeys.Preset.Manual, traits, c3(5, 6, 8));
        vm.expectRevert(bad("order"));
        op.verify(CreditKeys.Preset.Deposit, traits, c3(6, 5, 7));
        vm.expectRevert(bad("order"));
        op.verify(CreditKeys.Preset.Time, traits, c3(5, 7, 6)); // Time/Number: strictly ascending ids
        vm.expectRevert(bad("not deposited"));
        op.verify(CreditKeys.Preset.Number, traits, c3(5, 6, 8));
        op.verify(CreditKeys.Preset.Manual, traits, c3(7, 5, 6));
        op.verify(CreditKeys.Preset.Manual, traits, c3(7, 5, 6)); // transient marks are cleared after a check
        op.verify(CreditKeys.Preset.Deposit, traits, c3(5, 6, 7));
        op.verify(CreditKeys.Preset.Time, traits, c3(5, 6, 7));
    }
}

/// Party-shaped storage (deposit order + credit -> card map) for calling CreditKeys.verifyOrder directly.
contract OrderProbe {
    uint256[] internal dep;
    mapping(uint256 => uint256) internal cardOf;

    constructor(uint256[] memory ids) {
        for (uint256 i; i < ids.length; ++i) { dep.push(ids[i]); cardOf[ids[i]] = i + 1; }
    }

    function verify(CreditKeys.Preset p, ICreditTraits t, uint256[] calldata order) external {
        CreditKeys.verifyOrder(p, t, dep, cardOf, order, 0);
    }
}
