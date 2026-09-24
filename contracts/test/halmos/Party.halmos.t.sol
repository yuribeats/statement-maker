// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// Verbatim copies of Party.sol logic that halmos cannot reach through the deployed contract cheaply
/// (internal/pure helpers and inline arithmetic). Each block names its source lines in src/Party.sol.
/// If Party.sol changes, re-copy these blocks.
contract PartyLogic {
    uint256 public constant SLOTS = 80; // Party.sol:43
    uint256 public constant PASS = 41; // :44
    uint256 public constant PASS_BELOW_FLOOR = 60; // :45
    uint256 public constant PASS_DEADLOCK = 54; // :46
    uint256 public constant ROYALTY_CAP_BPS = 1000; // :53
    uint16 public constant FEE_BPS = 100; // PartyFactory.sol FEE_BPS constant

    enum PriceMode { Fixed, FloorPct, FloorDelta }
    struct PriceSpec { PriceMode mode; int256 value; } // :60

    error Bad(string why);

    uint256 public minAskWei; // stands for _params.minAskWei (:75)

    function setMinAsk(uint256 m) external { minAskWei = m; }

    // Party.sol:593-594 (_royalty after a well-formed answer with a nonzero receiver) + :474-477 (buy).
    // hasReceiver=false covers every other _royalty outcome, which returns (0, 0).
    function split(uint256 price, bool hasReceiver, uint256 v)
        external
        pure
        returns (uint256 royalty, uint256 fee, uint256 share, uint256 dust)
    {
        if (hasReceiver) {
            uint256 cap = price * ROYALTY_CAP_BPS / 10_000;
            royalty = v > cap ? cap : v;
        }
        fee = price * FEE_BPS / 10_000;
        uint256 pot = price - royalty - fee;
        share = pot / SLOTS;
        dust = pot - share * SLOTS;
    }

    // Party.sol:376-381 (needFor) with the Proposal fields passed in, and :406 (execute's pass test) inverted.
    function needFor(bool cancel, bool deadlock, uint256 price, uint256 floorWei) public pure returns (uint256) {
        uint256 need = (!cancel && price < floorWei) ? PASS_BELOW_FLOOR : PASS;
        if (deadlock && need < PASS_DEADLOCK) need = PASS_DEADLOCK;
        return need;
    }

    function passes(uint128 yes, uint128 no, bool cancel, bool deadlock, uint256 price, uint256 floorWei)
        external
        pure
        returns (bool)
    {
        uint256 need = needFor(cancel, deadlock, price, floorWei);
        return !(yes < need || (no > 0 && !deadlock)); // :406 reverts "did not pass" on the bracketed condition
    }

    // Party.sol:565-571 (_resolveWith), verbatim.
    function _resolveWith(PriceSpec memory p, uint256 floorWei) internal pure returns (uint256 v) {
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        int256 f = int256(floorWei);
        int256 r = p.mode == PriceMode.FloorPct ? f * (10_000 + p.value) / 10_000 : f + p.value;
        if (r <= 0) revert Bad("price <= 0");
        return uint256(r);
    }

    // Party.sol:574-576 (_clampMin), verbatim.
    function _clampMin(uint256 v) internal view returns (uint256) {
        return v < minAskWei ? minAskWei : v;
    }

    function resolveWith(PriceMode mode, int256 value, uint256 floorWei) external pure returns (uint256) {
        return _resolveWith(PriceSpec(mode, value), floorWei);
    }

    // Party.sol:560-563 (_resolve) after _floor has returned floorWei: what assemble/raiseAsk/execute price at.
    function resolve(PriceMode mode, int256 value, uint256 floorWei) external view returns (uint256) {
        PriceSpec memory p = PriceSpec(mode, value);
        if (p.mode == PriceMode.Fixed) return uint256(p.value);
        return _clampMin(_resolveWith(p, floorWei));
    }

    // Party.sol:545-549 (_checkPrice), verbatim: the bounds every stored PriceSpec satisfies.
    function _checkPrice(PriceSpec memory p) internal pure {
        if (p.mode == PriceMode.Fixed && (p.value <= 0 || p.value > 1e24)) revert Bad("price");
        if (p.mode == PriceMode.FloorPct && (p.value <= -10_000 || p.value > 1_000_000)) revert Bad("price");
        if (p.mode == PriceMode.FloorDelta && (p.value < -1e24 || p.value > 1e24)) revert Bad("price");
    }

    function checkPrice(PriceMode mode, int256 value) external pure returns (bool) {
        _checkPrice(PriceSpec(mode, value));
        return true;
    }
}

contract PartyHalmos is Test {
    PartyLogic internal L;

    function setUp() public {
        L = new PartyLogic();
    }

    // ---------------------------------------------------------------- 1. sale split

    function _split(uint256 price, bool hasReceiver, uint256 amt) internal view {
        try L.split(price, hasReceiver, amt) returns (uint256 royalty, uint256 fee, uint256 share, uint256 dust) {
            assert(royalty <= price * 1000 / 10_000); // cap holds
            assert(fee == price / 100);
            assert(dust < 80);
            assert(royalty + fee + 80 * share + dust == price); // exact conservation, nothing minted or lost
        } catch {
            assert(false); // no underflow / overflow revert for any input in range
        }
    }

    /// price in [1, 1e30] (1e12 ETH), any royaltyInfo answer.
    function check_split_1e30(uint256 price, bool hasReceiver, uint256 amt) public view {
        vm.assume(price >= 1 && price <= 1e30);
        _split(price, hasReceiver, amt);
    }

    /// Stronger: every price that does not overflow price * 1000.
    function check_split_full(uint256 price, bool hasReceiver, uint256 amt) public view {
        vm.assume(price >= 1 && price <= type(uint256).max / 1000);
        _split(price, hasReceiver, amt);
    }

    // ---------------------------------------------------------------- 2. pass rule

    function check_passRule(uint128 yes, uint128 no, bool cancel, bool deadlock, uint256 price, uint256 floorWei)
        public
        view
    {
        vm.assume(yes <= 80 && no <= 80 && yes + no <= 80);
        bool got = L.passes(yes, no, cancel, deadlock, price, floorWei);

        // Spec §4 stated independently of the code.
        uint256 need = (!cancel && price < floorWei) ? 60 : 41;
        if (deadlock && need < 54) need = 54;
        bool want = yes >= need && (no == 0 || deadlock);
        assert(got == want);

        if (yes <= 40) assert(!got); // 40 never passes
        if (no > 0 && !deadlock) assert(!got); // any NO blocks unless deadlock
        if (!cancel && price < floorWei && yes < 60) assert(!got); // below floor needs 60, deadlock or not
        if (deadlock && yes < 54) assert(!got);
    }

    /// Same, for any uint128 tallies (the contract stores yes/no as uint128).
    function check_passRule_anyTally(uint128 yes, uint128 no, bool cancel, bool deadlock, uint256 price, uint256 floorWei)
        public
        view
    {
        bool got = L.passes(yes, no, cancel, deadlock, price, floorWei);
        uint256 need = (!cancel && price < floorWei) ? 60 : 41;
        if (deadlock && need < 54) need = 54;
        assert(got == (yes >= need && (no == 0 || deadlock)));
    }

    // ---------------------------------------------------------------- 3. price resolution

    uint256 internal constant FLOOR_MAX = type(uint256).max >> 1; // int256 max: larger floors wrap negative

    function check_resolve_fixed(int256 value, uint256 floorWei) public view {
        vm.assume(value > 0 && value <= 1e24); // _checkPrice bounds
        assert(L.resolveWith(PartyLogic.PriceMode.Fixed, value, floorWei) == uint256(value));
    }

    /// FloorPct, for every value _checkPrice admits and every floor up to 1e30 wei:
    /// returns floor*(10000+value)/10000 exactly; reverts only when that is 0.
    function check_resolve_pct(int256 value, uint256 floorWei) public view {
        vm.assume(value > -10_000 && value <= 1_000_000);
        vm.assume(floorWei > 0 && floorWei <= 1e30);
        // Exact product, computed unchecked with the same signed ops so the solver compares like terms;
        // at these bounds |f * k| < 2^100 * 2^20, far below 2^255, so the unchecked product is the true product.
        int256 want;
        unchecked { want = int256(floorWei) * (10_000 + value) / 10_000; }
        try L.resolveWith(PartyLogic.PriceMode.FloorPct, value, floorWei) returns (uint256 got) {
            assert(want > 0 && got == uint256(want));
        } catch {
            assert(want <= 0); // the only revert is Bad("price <= 0"); no overflow Panic
        }
    }

    /// Same with price above zero guaranteed by construction: isolates the "no overflow Panic" obligation.
    function check_resolve_pct_noPanic(int256 value, uint256 floorWei) public view {
        vm.assume(value > -10_000 && value <= 1_000_000);
        vm.assume(floorWei >= 10_000 && floorWei <= 1e30); // floor >= 10000 wei ⇒ result >= 1 wei
        try L.resolveWith(PartyLogic.PriceMode.FloorPct, value, floorWei) returns (uint256 got) {
            assert(got > 0);
        } catch {
            assert(false); // any revert (overflow Panic included) is a failure
        }
    }

    /// FloorDelta: returns floor + value; reverts only when that is <= 0.
    function check_resolve_delta(int256 value, uint256 floorWei) public view {
        vm.assume(value >= -1e24 && value <= 1e24);
        vm.assume(floorWei > 0 && floorWei <= 1e30);
        int256 want = int256(floorWei) + value;
        try L.resolveWith(PartyLogic.PriceMode.FloorDelta, value, floorWei) returns (uint256 got) {
            assert(want > 0 && got == uint256(want));
        } catch {
            assert(want <= 0);
        }
    }

    /// Monotonic in the floor, through _resolve (resolveWith then the host's minimum-ask clamp), for any minAskWei:
    /// f1 <= f2 ⇒ price(f1) <= price(f2), and if f1 resolves then f2 resolves. This is what makes raiseAsk
    /// (accept only next > ask) move the ask up only when the signed floor rises.
    function _mono(PartyLogic.PriceMode mode, int256 value, uint256 f1, uint256 f2, uint256 fmax, uint256 minAsk) internal {
        vm.assume(f1 > 0 && f1 <= f2 && f2 <= fmax);
        vm.assume(L.checkPrice(mode, value));
        L.setMinAsk(minAsk);
        try L.resolve(mode, value, f1) returns (uint256 p1) {
            assert(p1 >= minAsk);
            try L.resolve(mode, value, f2) returns (uint256 p2) {
                assert(p1 <= p2);
            } catch {
                assert(false);
            }
        } catch {}
    }

    function check_resolve_monotone_pct(int256 value, uint256 f1, uint256 f2, uint256 minAsk) public {
        _mono(PartyLogic.PriceMode.FloorPct, value, f1, f2, 1e30, minAsk);
    }

    function check_resolve_monotone_delta(int256 value, uint256 f1, uint256 f2, uint256 minAsk) public {
        _mono(PartyLogic.PriceMode.FloorDelta, value, f1, f2, 1e30, minAsk);
    }

    /// Where the bound comes from: the largest floor with no overflow or sign wrap anywhere.
    /// FloorPct: f * 1_010_000 must fit int256 ⇒ f <= int256.max / 1_010_000 (~5.7e70 wei).
    function check_resolve_monotone_pct_maxfloor(int256 value, uint256 f1, uint256 f2, uint256 minAsk) public {
        _mono(PartyLogic.PriceMode.FloorPct, value, f1, f2, uint256(type(int256).max) / 1_010_000, minAsk);
    }

    function check_resolve_monotone_delta_maxfloor(int256 value, uint256 f1, uint256 f2, uint256 minAsk) public {
        _mono(PartyLogic.PriceMode.FloorDelta, value, f1, f2, uint256(type(int256).max) - 1e24, minAsk);
    }

    /// Unbounded floor (any uint256 the signer could attest). Expected to FAIL: documents the wrap at 2^255.
    function check_resolve_monotone_delta_anyfloor(int256 value, uint256 f1, uint256 f2, uint256 minAsk) public {
        _mono(PartyLogic.PriceMode.FloorDelta, value, f1, f2, type(uint256).max, minAsk);
    }
}

/// Split proof, decomposed. The direct proofs (check_split_*) time out: every solver tried (bitwuzla, yices,
/// cvc5, bitwuzla-abs; 300-900 s) stalls on 256-bit DIV. Here each EVM division x / c is replaced by its
/// definition: the unique q, r with x == q * c + r and r < c (EVM DIV semantics for c != 0). With the
/// quotients as witnesses, everything left is linear, and the obligations are exactly the ones in split().
contract SplitLemmaHalmos is Test {
    function check_split_linear(uint256 price, bool hasReceiver, uint256 v, uint256 cap, uint256 rc, uint256 fee, uint256 rf, uint256 share, uint256 rs)
        public
        pure
    {
        vm.assume(price >= 1 && price <= 1e30);
        // cap = price * 1000 / 10_000   (Party.sol:593)
        vm.assume(price * 1000 == cap * 10_000 + rc && rc < 10_000);
        // fee = price * 100 / 10_000    (Party.sol:474, FEE_BPS = 100)
        vm.assume(price * 100 == fee * 10_000 + rf && rf < 10_000);
        uint256 royalty = hasReceiver ? (v > cap ? cap : v) : 0; // Party.sol:92-96
        // no underflow in pot = price - royalty - fee (Party.sol:475)
        assert(royalty <= price && fee <= price - royalty);
        uint256 pot = price - royalty - fee;
        // share = pot / 80              (Party.sol:476)
        vm.assume(pot == share * 80 + rs && rs < 80);
        uint256 dust = pot - share * 80; // Party.sol:477
        assert(dust == rs && dust < 80);
        assert(royalty + fee + 80 * share + dust == price);
    }

    /// The one fact the witnesses rely on, checked once per constant divisor at full width by halmos:
    /// EVM DIV returns the q with x == q*c + r, r < c. (Timeout here = the same wall; recorded in the report.)
    function check_div_def_10000(uint256 x) public pure {
        vm.assume(x <= 1e33);
        uint256 q = x / 10_000;
        assert(q * 10_000 <= x && x - q * 10_000 < 10_000);
    }

    function check_div_def_80(uint256 x) public pure {
        vm.assume(x <= 1e30);
        uint256 q = x / 80;
        assert(q * 80 <= x && x - q * 80 < 80);
    }
}
