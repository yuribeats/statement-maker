// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {LocalBase} from "../LocalBase.t.sol";
import {KeyProbe} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {Handler} from "./Handler.sol";

/// @notice Handler-based invariant suite over many parties, 6 EOAs and 3 hostile contract holders.
///         Run: forge test --match-path 'test/invariant/*'
contract PartyInvariants is LocalBase {
    Handler public h;

    function setUp() public override {
        super.setUp();
        address[] memory eoas = new address[](6);
        for (uint256 i; i < 6; ++i) eoas[i] = holders[i];
        h = new Handler(credits, factory, statement, new KeyProbe(traits), signerKey, feeTo, eoas);

        // Hostile contracts get Credits from holders 6 and 7: 40 / 40 / 40.
        uint256[] memory c6 = credits.tokensOf(holders[6]);
        uint256[] memory c7 = credits.tokensOf(holders[7]);
        vm.startPrank(holders[6]);
        for (uint256 i; i < 40; ++i) credits.transferFrom(holders[6], h.actors(6), c6[i]);
        for (uint256 i = 40; i < 60; ++i) credits.transferFrom(holders[6], h.actors(7), c6[i]);
        vm.stopPrank();
        vm.startPrank(holders[7]);
        for (uint256 i; i < 20; ++i) credits.transferFrom(holders[7], h.actors(7), c7[i]);
        for (uint256 i = 20; i < 60; ++i) credits.transferFrom(holders[7], h.actors(8), c7[i]);
        vm.stopPrank();

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](31);
        sel[0] = Handler.createParty.selector;
        sel[1] = Handler.deposit.selector;
        sel[2] = Handler.deposit.selector; // weighted: filling parties is the long pole
        sel[3] = Handler.redeem.selector;
        sel[4] = Handler.redeemFor.selector;
        sel[5] = Handler.transferCard.selector;
        sel[6] = Handler.propose.selector;
        sel[7] = Handler.vote.selector;
        sel[8] = Handler.execute.selector;
        sel[9] = Handler.countBlocked.selector;
        sel[10] = Handler.assemble.selector;
        sel[11] = Handler.raiseAsk.selector;
        sel[12] = Handler.buy.selector;
        sel[13] = Handler.claim.selector;
        sel[14] = Handler.withdraw.selector;
        sel[15] = Handler.warp.selector;
        sel[16] = Handler.steal.selector;
        sel[17] = Handler.fill.selector;
        sel[18] = Handler.assemble.selector;
        sel[19] = Handler.buy.selector;
        sel[20] = Handler.fill.selector;
        sel[21] = Handler.vote.selector;
        sel[22] = Handler.voteAll.selector;
        sel[23] = Handler.voteAll.selector;
        sel[24] = Handler.govRound.selector;
        sel[25] = Handler.govRound.selector;
        sel[26] = Handler.raiseAsk.selector;
        sel[27] = Handler.claimAll.selector;
        sel[28] = Handler.withdraw.selector;
        sel[29] = Handler.claimFor.selector;
        sel[30] = Handler.claimFor.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    // ------------------------------------------------------------------ helpers

    function _party(uint256 i) internal view returns (Party) {
        return Party(payable(address(h.parties(i))));
    }

    function _actorIndex(address o) internal view returns (uint256) {
        uint256 na = h.actorCount();
        for (uint256 a; a < na; ++a) if (h.actors(a) == o) return a;
        return type(uint256).max;
    }

    function _liveCards(Party p) internal view returns (uint256[] memory out, address[] memory owners) {
        uint256 total = cards.nextId();
        uint256[] memory tmp = new uint256[](total);
        address[] memory tmpO = new address[](total);
        uint256 n;
        for (uint256 c = 1; c < total; ++c) {
            if (cards.partyOf(c) != address(p)) continue;
            try cards.ownerOf(c) returns (address o) { tmp[n] = c; tmpO[n++] = o; } catch {}
        }
        out = new uint256[](n);
        owners = new address[](n);
        for (uint256 i; i < n; ++i) { out[i] = tmp[i]; owners[i] = tmpO[i]; }
    }

    // ------------------------------------------------------------------ invariants

    /// Transition invariants 3, 4, 6, 7 and the spec model of every action, checked inside the handler.
    function _A_transitionsAndModel() internal view {
        assertEq(h.violation(), "", "handler recorded a violation");
        assertEq(h.reentrySuccesses(), 0, "a hostile re-entry succeeded");
    }

    /// Invariants 1, 2, 3 (state part): custody, card <-> credit bijection, vote weights.
    function _B_custodyAndWeights() internal view {
        uint256 np = h.partyCount();
        uint256 na = h.actorCount();
        uint256 total = cards.nextId();
        uint256[] memory live = new uint256[](np);
        uint256[][] memory held = new uint256[][](np);
        for (uint256 i; i < np; ++i) held[i] = new uint256[](na);

        for (uint256 c = 1; c < total; ++c) {
            address o;
            try cards.ownerOf(c) returns (address x) { o = x; } catch { continue; }
            address pa = cards.partyOf(c);
            uint256 pi = h.partyIndexPlusOne(pa);
            assertGt(pi, 0, "card of unknown party");
            Party p = Party(payable(pa));
            ++live[pi - 1];
            uint256 ai = _actorIndex(o);
            assertTrue(ai != type(uint256).max, "card left the actor set");
            ++held[pi - 1][ai];
            uint256 credit = p.creditOfCard(c);
            assertEq(p.cardOfCredit(credit), c, "I1: card -> credit -> card");
            if (!p.assembled()) assertEq(credits.ownerOf(credit), pa, "I1: live card's credit not in party");
        }

        for (uint256 i; i < np; ++i) {
            Party p = _party(i);
            uint256 sum;
            for (uint256 a; a < na; ++a) {
                assertEq(cards.heldNow(address(p), h.actors(a)), held[i][a], "I2: heldNow != cards owned");
                sum += held[i][a];
            }
            assertEq(sum, live[i], "I2: weights != live cards");
            assertEq(p.cardsOutstanding(), live[i], "cardsOutstanding != live cards");
            if (!p.assembled()) {
                assertEq(credits.balanceOf(address(p)), p.count(), "I1: credits held != count");
                assertEq(p.count(), live[i], "I1: count != live cards");
                uint256[] memory order = p.depositOrder();
                for (uint256 k; k < order.length; ++k) {
                    uint256 c = p.cardOfCredit(order[k]);
                    assertGt(c, 0, "I1: deposited credit without card");
                    assertEq(p.creditOfCard(c), order[k], "I1: credit -> card -> credit");
                    assertEq(cards.partyOf(c), address(p), "I1: card of another party");
                }
                uint256[] memory ever = h.everDeposited(address(p));
                for (uint256 k; k < ever.length; ++k) {
                    address o;
                    try credits.ownerOf(ever[k]) returns (address x) { o = x; } catch {}
                    bool inParty = p.cardOfCredit(ever[k]) != 0;
                    assertEq(o == address(p), inParty, "I1: stale or missing credit mapping");
                }
            } else {
                assertEq(credits.balanceOf(address(p)), 0, "I3: credits left after burn");
                assertEq(p.count(), 80, "count after burn");
                uint256[] memory burned = p.depositOrder(); // the burned set is exactly the deposits
                assertEq(burned.length, 80, "burn order length");
                for (uint256 k; k < 80; ++k) {
                    bool exists;
                    try credits.ownerOf(burned[k]) returns (address) { exists = true; } catch {}
                    assertFalse(exists, "I3: a burned credit still exists");
                }
                address owner = statement.ownerOf(p.statementId());
                assertEq(owner, p.sold() ? h.buyerOf(address(p)) : address(p), "I3/I4: statement owner");
                if (!p.sold()) assertEq(live[i], 80, "all 80 cards live until sale");
            }
        }
    }

    /// Invariant 6 (tallies): YES/NO equal the sum of recorded snapshot weights; weights never exceed 80.
    function _C_tallies() internal view {
        uint256 np = h.partyCount();
        uint256 na = h.actorCount();
        for (uint256 i; i < np; ++i) {
            Party p = _party(i);
            uint256 n = p.proposalCount();
            for (uint256 id; id < n; ++id) {
                Party.Proposal memory pr = p.proposal(id);
                uint256 yes;
                uint256 no;
                uint256 snapSum;
                for (uint256 a; a < na; ++a) {
                    address who = h.actors(a);
                    uint8 v = p.voteOf(id, who);
                    uint256 w = p.weightOf(id, who);
                    if (v != 0) assertEq(w, cards.heldAt(address(p), who, pr.snapshot), "I6: weight != snapshot");
                    if (v == 1) yes += w;
                    else if (v == 2) no += w;
                    snapSum += cards.heldAt(address(p), who, pr.snapshot);
                }
                assertEq(pr.yes, yes, "I6: yes tally");
                assertEq(pr.no, no, "I6: no tally");
                assertLe(snapSum, 80, "I6: snapshot weights > 80");
            }
        }
    }

    /// Invariants 5 and 9: ETH accounting with zero dust.
    function _D_money() internal view {
        uint256 np = h.partyCount();
        uint256 na = h.actorCount();
        for (uint256 i; i < np; ++i) {
            Party p = _party(i);
            uint256 owedSum = p.owed(feeTo) + p.owed(h.royaltyTo());
            // actors are owed only what claimFor could not push to them (contract holders that refuse ETH)
            for (uint256 a; a < na; ++a) {
                address who = h.actors(a);
                if (!h.isContractActor(who)) assertEq(p.owed(who), 0, "owed to an EOA");
                owedSum += p.owed(who);
            }
            if (!p.sold()) {
                assertEq(address(p).balance, 0, "I5: ETH before sale");
                assertEq(owedSum, 0, "I5: owed before sale");
            } else {
                assertEq(address(p).balance, owedSum + p.perCard() * p.cardsOutstanding(), "I5: balance != owed + unclaimed");
                if (p.cardsOutstanding() == 0 && owedSum == 0) {
                    assertEq(address(p).balance, 0, "I9: ETH stuck");
                    assertEq(credits.balanceOf(address(p)), 0, "I9: credits stuck");
                }
            }
        }
    }

    /// Invariant 8: once expired unassembled, every live card's Credit can be pushed to its holder in one call.
    function _E_expiredAllRedeemable() internal {
        uint256 np = h.partyCount();
        for (uint256 i; i < np; ++i) {
            Party p = _party(i);
            if (p.status() != Party.Status.EXPIRED || p.count() == 0) continue;
            (uint256[] memory ids, address[] memory owners) = _liveCards(p);
            uint256[] memory creds = new uint256[](ids.length);
            for (uint256 k; k < ids.length; ++k) creds[k] = p.creditOfCard(ids[k]);
            uint256 snap = vm.snapshotState();
            vm.prank(address(0xBEEF));
            p.redeemFor(ids);
            for (uint256 k; k < ids.length; ++k) assertEq(credits.ownerOf(creds[k]), owners[k], "I8: credit not sent to holder");
            assertEq(p.count(), 0, "I8: count after full redeemFor");
            assertEq(credits.balanceOf(address(p)), 0, "I8/I9: credits stuck after expiry");
            vm.revertToState(snap);
        }
    }

    /// One campaign checks everything after every call (separate invariant_ functions would each run their own
    /// campaign, multiplying the cost).
    function invariant_all() public {
        _A_transitionsAndModel();
        _B_custodyAndWeights();
        _C_tallies();
        _D_money();
        _E_expiredAllRedeemable();
    }

    /// Coverage across runs: afterInvariant runs after every run; counters accumulate in process env vars.
    function afterInvariant() public {
        string[18] memory names = ["", "deposit", "redeem", "redeemFor", "transfer", "propose", "vote", "execute", "countBlocked",
            "assemble", "raiseAsk", "buy", "claim", "withdraw", "warp", "create", "steal", "claimFor"];
        for (uint8 a = 1; a <= 17; ++a) {
            string memory k = string.concat("SMCOV_OK_", names[a]);
            string memory t = string.concat("SMCOV_TRY_", names[a]);
            uint256 ok = vm.envOr(k, uint256(0)) + h.okCount(a);
            uint256 tr = vm.envOr(t, uint256(0)) + h.tryCount(a);
            vm.setEnv(k, vm.toString(ok));
            vm.setEnv(t, vm.toString(tr));
            console2.log(names[a], ok, "/", tr);
        }
        uint256 runs = vm.envOr("SMCOV_RUNS", uint256(0)) + 1;
        vm.setEnv("SMCOV_RUNS", vm.toString(runs));
        uint256 np = h.partyCount();
        for (uint256 i; i < np; ++i) {
            Party p = _party(i);
            string memory key = string.concat("SMCOV_STATUS_", vm.toString(uint256(p.status())));
            vm.setEnv(key, vm.toString(vm.envOr(key, uint256(0)) + 1));
        }
        uint256 re = vm.envOr("SMCOV_REENTRY", uint256(0)) + h.reentryAttempts();
        vm.setEnv("SMCOV_REENTRY", vm.toString(re));
        console2.log("runs", runs, "hostile re-entry attempts (all failed)", re);
        console2.log("final party status counts OPEN/FULL/ASSEMBLED/SOLD/EXPIRED:");
        console2.log(vm.envOr("SMCOV_STATUS_0", uint256(0)), vm.envOr("SMCOV_STATUS_1", uint256(0)), vm.envOr("SMCOV_STATUS_2", uint256(0)));
        console2.log(vm.envOr("SMCOV_STATUS_3", uint256(0)), vm.envOr("SMCOV_STATUS_4", uint256(0)));
    }
}
