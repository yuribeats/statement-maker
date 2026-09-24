# Static analysis triage: Statement Maker contracts (2026-09-23)

Scope: contracts/src (Party.sol, PartyFactory.sol, CreditCards.sol, CreditKeys.sol, interfaces/, mocks/MockStatement.sol).
Checked against SPEC.md v0.8. No files under src/ were modified.

## Raw outputs in this folder
| File | Tool |
|---|---|
| slither-detectors.txt / .json | `slither . --filter-paths "lib\|test"` (slither 0.11.6, 102 detectors, 65 results) |
| slither-print-human-summary.txt, -function-summary.txt, -vars-and-auth.txt | slither printers |
| slither-check-erc-CreditCards.txt | `slither-check-erc . CreditCards --erc ERC721`: all functions/events present, all checks pass |
| slither-check-upgradeability-Party.txt | `slither-check-upgradeability . Party`: 1 finding |
| aderyn-report.md, aderyn-stdout.txt | aderyn 0.6.8 (3 High, 11 Low categories) |
| Poc.t.sol.txt, poc-results-isolate.txt | Proof-of-concept tests (run in a scratch copy using the repo's LocalBase harness, `forge test --isolate`; all 7 pass) |

## Counts
| Source | Finding groups | TRUE POSITIVE | ACCEPTED | FALSE POSITIVE |
|---|---|---|---|---|
| Slither detectors + upgradeability | 21 | 0 | 10 | 11 |
| Aderyn | 14 | 1 | 7 | 6 |
| Manual review (not flagged by tools) | 6 | 6 | – | – |

---

## Slither

| ID | Detector | Location | Verdict | Reason |
|---|---|---|---|---|
| S1 | divide-before-multiply | Party.buy L480-481 | FALSE POSITIVE | `share = pot/80; dust = pot - share*80` is the exact remainder by design; dust goes to the fee recipient, so price = royalty + fee + dust + 80·share with no loss. Royalty and fee lines multiply before dividing. |
| S2 | reentrancy-no-eth | Party.claim (cards.burn before `--cardsOutstanding`) | FALSE POSITIVE | Within one iteration the writes precede `cards.burn`; slither flags the loop-carried order (iteration i+1 writes after iteration i's call). `cards` is the factory-deployed CreditCards; `_burn` has no receiver callback. Function is `nonReentrant`. |
| S3 | reentrancy-no-eth | Party.deposit (transferFrom, mint before `_order.push`) | FALSE POSITIVE | Credits is the fixed mainnet contract (plain `transferFrom`, no callback); CreditCards uses `_mint` (no callback). `nonReentrant`. Status re-entry would see the pre-push count only inside a callback that cannot happen. |
| S4 | uninitialized-local ×6 | buy.royalty/royaltyTo, execute.price/floorWei, claim.total, _checkPermutation.seen | FALSE POSITIVE | Zero default is the intended initial value in every case. |
| S5 | unused-return ×3 | CreditCards._update (Trace208.push), PartyFactory.isValidFloor (tryRecover 3rd value) | FALSE POSITIVE | push's (old,new) return is not needed; the error enum is checked, the discarded value is the error argument. |
| S6 | write-after-write | Party._assembling true→false around `st.make` | ACCEPTED | Deliberate flag scoping the only window where `onERC721Received` accepts a token. Could be transient storage (cheaper), no correctness impact. |
| S7 | missing-zero-check ×2 | CreditCards ctor `factory_`; MockStatement.setRoyalty | FALSE POSITIVE | CreditCards is only deployed by PartyFactory with `address(this)`. Mock is test-only. |
| S8 | calls-loop ×13 | deposit, _redeem (redeem/redeemFor), assemble ownerOf loop, claim | ACCEPTED | All callees are the immutable Credits contract or the factory-owned CreditCards; loops are ≤80 or caller-sized. A revert fails only the caller's own batch. |
| S9 | reentrancy-benign ×3 | assemble: `_assembling`, `statementId` written after calls | ACCEPTED | `factory.statement()` is immutable and trusted. All price/status effects (`assembled`, `_burnOrder`, `ask`, `askLiveAt`, `priceEpoch`) are written before `make()`; status is ASSEMBLED during the call, so deposit/redeem/assemble/propose-for-FULL all fail; function is `nonReentrant`. |
| S10 | reentrancy-benign | PartyFactory.createParty | FALSE POSITIVE | Callees are its own CreditCards and a fresh clone. |
| S11 | reentrancy-benign | deposit (`creditOfCard`, `fullAt`) | FALSE POSITIVE | Same as S3. |
| S12 | reentrancy-benign | MockStatement.make | FALSE POSITIVE | Test mock. |
| S13 | reentrancy-events | createParty event after calls | FALSE POSITIVE | Trusted callees; ordering of logs irrelevant. |
| S14 | timestamp ×9 | status, _vote, execute, countBlocked, _deadlocked, _refreshOpen, buy, _floor, propose | ACCEPTED | Windows are hours/days; ~12 s proposer drift does not matter. (Two flagged comparisons, `_proposals.length >= MAX_PROPOSALS` and `openBy > 0`, are not timestamp comparisons.) One real timing bug exists but is a design issue, not drift: see M-3. |
| S15 | assembly | CreditCards._clean `mstore(out,n)` | ACCEPTED | Shrinks the length of a freshly allocated buffer, n ≤ allocated length. Safe. |
| S16 | costly-loop ×12 | deposit, _redeem, _removeFromOrder, claim | ACCEPTED | Bounded; measured gas in "Loop gas" below. |
| S17 | cyclomatic-complexity | assemble, execute (12) | ACCEPTED | Informational. |
| S18 | low-level-calls ×3 | buy refund, claim, withdraw | ACCEPTED | All three set state before sending (`sold/ask/owed` in buy; burn in claim; `owed=0` in withdraw), all `nonReentrant`, all pay `msg.sender` only. |
| S19 | missing-inheritance | Party ⇏ ICardParty; Mock ⇏ IStatement/IERC2981Like | ACCEPTED | Informational; declaring `Party is ICardParty` would let the compiler check the signature. |
| S20 | naming-convention | IFactory.FEE_BPS() | FALSE POSITIVE | Getter of a constant. |
| U1 | upgradeability initialize-target | Party.initialize | ACCEPTED | Implementation calls `_disableInitializers()`; the factory clones and initializes in the same transaction (PartyFactory L39-41), so no front-run window. A clone made outside the factory cannot mint cards (`registerParty` is factory-only), so any deposit into it reverts. |

ERC721 conformance (slither-check-erc): no findings.

## Aderyn

| ID | Title | Verdict | Reason |
|---|---|---|---|
| A-H1 | ETH transferred without address checks (withdraw) | FALSE POSITIVE | Pays only `owed[msg.sender]`, zeroed first. |
| A-H2 | State change after external call (21 sites) | FALSE POSITIVE | Same analysis as S2/S3/S9/S10: trusted immutable callees, `nonReentrant`, and sites 148-149 are `initialize` reading the factory. |
| A-H3 | Storage array edited with memory (L406, L457) | FALSE POSITIVE | `p.price` / `askSpec` are copied to memory for read-only `_resolveWith`/`_resolve`; nothing is meant to be written back. |
| A-L1 | Costly operations inside loop | ACCEPTED | See S16 and gas table. |
| A-L2 | Internal function used only once | ACCEPTED | Style. |
| A-L3 | Large numeric literal | ACCEPTED | Style (1e24 bounds, 10_000 bps). |
| A-L4 | Literal instead of constant | ACCEPTED | Style (rarity tables). |
| A-L5 | Loop contains revert | ACCEPTED | Batches are meant to be atomic. |
| A-L6 | State change without event: countBlocked, withdraw, registerParty (+ mock) | TRUE POSITIVE (Info) | See T-7. Mock instance is FALSE POSITIVE. |
| A-L7 | Address state variable set without checks (mock) | FALSE POSITIVE | Test mock. |
| A-L8 | Unchecked return (Trace208.push ×2, `_requireOwned`) | FALSE POSITIVE | Values not needed. |
| A-L9 | Uninitialized local (loop counters) | FALSE POSITIVE | Zero default intended. |
| A-L10 | Unsafe ERC721 `_mint` | ACCEPTED | Deliberate: no callback into depositor; depositor is the caller of deposit, so it chose to receive a card. |
| A-L11 | Public function not used internally (count) | ACCEPTED | Style. |

---

## TRUE POSITIVES

### T-1 (HIGH): one card permanently freezes all price governance (lifetime MAX_PROPOSALS)
`_proposals.length >= MAX_PROPOSALS (256)` is a lifetime cap (Party.sol L345). Any address holding a card at block-1 may propose 3 times; the card can be passed to a fresh address each block. After 256 proposals no one can ever propose LIST or CANCEL_LISTING again. There is no DISTRIBUTE and no post-assembly exit, so if the default ask is too high the Statement is stuck in the vault forever and card holders get nothing.
PoC `test_poc_proposalCapExhaustion_oneCard`: 1 card, 86 addresses, 168.7M gas total (isolated). At 0.077 gwei that is about 0.013 ETH; at 1 gwei about 0.17 ETH. Plus the price of one card on a marketplace. Works in FULL (before assembly) too.
Patch (removes the lifetime cap and the loop over all proposals; the per-proposer open list is at most 3 long). Any cap on total or per-epoch proposals re-creates the freeze, because an execution is the only thing that could reset it and no one could propose one.
```diff
-    uint256 public constant MAX_PROPOSALS = 256;
-    mapping(address => uint256) public openBy;
-    mapping(uint256 id => bool) internal _openCounted;
+    mapping(address => uint256[]) internal _openIds; // length <= MAX_OPEN_PER_PROPOSER
@@ propose
-        if (_proposals.length >= MAX_PROPOSALS) revert Bad("too many");
         _refreshOpen(msg.sender);
-        if (openBy[msg.sender] >= MAX_OPEN_PER_PROPOSER) revert Bad("open limit");
+        if (_openIds[msg.sender].length >= MAX_OPEN_PER_PROPOSER) revert Bad("open limit");
@@
-        ++openBy[msg.sender];
-        _openCounted[id] = true;
+        _openIds[msg.sender].push(id);
@@
-    function _refreshOpen(address who) internal {
-        uint256 n = _proposals.length;
-        for (uint256 i; i < n && openBy[who] > 0; ++i) { ... }
-    }
+    function _refreshOpen(address who) internal {
+        uint256[] storage ids = _openIds[who];
+        for (uint256 i = ids.length; i > 0; --i) {
+            if (block.timestamp >= _proposals[ids[i - 1]].endsAt) { ids[i - 1] = ids[ids.length - 1]; ids.pop(); }
+        }
+    }
```
Spam then costs the spammer gas and clutters the UI but blocks nothing. Optional hardening: require proposer weight at snapshot >= 2, or a small ETH bond refunded when the proposal reaches 41 YES.

### T-2 (MEDIUM): a single card holder can switch the party into deadlock mode (NO ignored) forever
`countBlocked` counts any closed price proposal with `no > 0` (L432). A proposer may vote NO on their own proposal (`_vote` allows changing vote), and `blockedPriceProposals` never resets after an execution. With 1 card: propose, vote NO, ×3, wait, `countBlocked` ×3. Every later proposal is created with `deadlock = true`: 54 YES passes and NO is ignored. The zero-NO minority protection is gone from the first day of FULL.
PoC `test_poc_selfBlockDeadlock`: 60 YES vs 19 NO passes.
Patch:
```diff
     function countBlocked(uint256 id) external {
         Proposal storage p = _proposals[id];
         if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock) revert Bad("not blocked");
+        if (p.epoch != priceEpoch) revert Bad("stale");               // blocks count only in the current epoch
+        if (voteOf[id][p.proposer] == 2) revert Bad("self-blocked");  // proposer's own NO does not count
+        if (p.yes < PASS) revert Bad("not a majority");                // only count proposals NO actually blocked
         blockedCounted[id] = true;
         ++blockedPriceProposals;
     }
@@ execute
         ++priceEpoch;
+        blockedPriceProposals = 0;
```
(`p.yes < PASS` also makes "blocked" mean what SPEC §4 says: a proposal that would have passed except for NO.)

### T-3 (MEDIUM): the 24 h buy delay cannot be used to cancel
SPEC §3: "Buying opens 24 h after a price goes live, so card holders can react." The shortest voting window is 24 h and execution requires the window to be closed, so a CANCEL proposed in the same block the ask goes live becomes executable at exactly `askLiveAt + 24h`, the same second `buy()` opens (L468 vs L396). Whoever is ordered first in that block wins; a buyer can always front-run.
PoC `test_poc_cancelRacesBuy`.
Patch:
```diff
-    uint256 public constant BUY_DELAY = 24 hours;
+    uint256 public constant BUY_DELAY = 26 hours; // > shortest window + margin to execute a CANCEL
@@ propose
-        uint16 h = hours_ == 0 ? _params.voteHours : hours_;
+        uint16 h = cancel ? 24 : (hours_ == 0 ? _params.voteHours : hours_);
```

### T-4 (MEDIUM): floor key can set a low ask; caller can cherry-pick readings; every LIST execution needs the key
SPEC §4c: "the key can only ever raise an ask, never lower one." In code the signed floor also sets the ask at `assemble` (L267) and at `execute` of floor-relative LISTs (L405-406), with no lower bound. A compromised or buggy signer can make a floor-relative ask arbitrarily small; after T-3's race, a colluding buyer takes the Statement. PoC `test_poc_floorKeySetsLowAsk` (ask = 1 gwei).
Also: any valid signature ≤1 h old is accepted, so the caller of `assemble`/`execute` may choose the lowest reading of the past hour; and `execute` calls `_floor` for every non-cancel proposal, including Fixed prices, so no price vote can execute while the signer is offline (contradicts §4c "no Statement Maker key is required to move a party forward").
Patch (adds the absolute ETH minimum the spec already describes in §4b "The LIST proposal carries an absolute minimum in ETH"):
```diff
-    struct PriceSpec { PriceMode mode; int256 value; }
+    struct PriceSpec { PriceMode mode; int256 value; uint256 minWei; } // resolved ask never below minWei
+    uint64 public lastFloorIssuedAt;
@@ _resolveWith
-        if (r <= 0) revert Bad("price <= 0");
-        return uint256(r);
+        if (r <= 0) revert Bad("price <= 0");
+        return uint256(r) < p.minWei ? p.minWei : uint256(r);
@@ _floor (make it non-view)
+        if (f.issuedAt < lastFloorIssuedAt) revert Bad("older floor"); // no cherry-picking older readings
+        lastFloorIssuedAt = f.issuedAt;
@@ execute
-        if (!p.cancel) {
+        if (!p.cancel && (p.price.mode != PriceMode.Fixed || floor.sig.length != 0)) {
             floorWei = _floor(floor);
             price = _resolveWith(p.price, floorWei);
+        } else if (!p.cancel) {
+            price = uint256(p.price.value);
+            floorWei = type(uint256).max; // no floor reading: treat a fixed price as below floor (needs 60)
         }
```
`_checkPrice` should require `minWei > 0` for floor-relative modes.

### T-5 (LOW): royalty lookup can brick buy(), or silently skip the royalty
L474: `try ... royaltyInfo{gas: 50_000}(...) returns (address r, uint256 amt)`. A revert while decoding the return value is not caught by `catch`. If the real Statement contract (ABI unknown until ~2026-10-01) has a fallback that returns fewer than 64 bytes, every `buy()` reverts and the Statement can never leave the vault. If a real lookup needs more than 50k gas, it runs out of gas and the artist is silently paid 0. The Royalty Registry fallback in SPEC §4b is not implemented (Party.sol's header documents that as a decision, so that part is a spec gap).
Patch:
```diff
-        try IERC2981Like(address(factory.statement())).royaltyInfo{gas: 50_000}(statementId, price) returns (address r, uint256 amt) {
-            uint256 cap = price * ROYALTY_CAP_BPS / 10_000;
-            if (r != address(0)) { royaltyTo = r; royalty = amt > cap ? cap : amt; }
-        } catch {}
+        (bool ok, bytes memory ret) = address(factory.statement()).staticcall{gas: 100_000}(
+            abi.encodeCall(IERC2981Like.royaltyInfo, (statementId, price)));
+        if (ok && ret.length >= 64) {
+            (uint256 rAddr, uint256 amt) = abi.decode(ret, (uint256, uint256));
+            uint256 cap = price * ROYALTY_CAP_BPS / 10_000;
+            if (rAddr != 0 && rAddr <= type(uint160).max) { royaltyTo = address(uint160(rAddr)); royalty = amt > cap ? cap : amt; }
+        }
```

### T-6 (LOW): no exit after ASSEMBLED if unsold; shares of cards held by contracts are stranded
There is no DISTRIBUTE path (spec §2/§4 list one) and no expiry after assembly. The only way out is a buyer at the ask. Combined with T-1 this is permanent. Separately, `claim` is holder-pull only (no `claimFor` as in spec §4c): cards held by NFT AMM pools, escrow contracts, or lost wallets leave their 1/80 in the party forever with no sweep. Patch: add a `claimFor(uint256[] cardIds)` that pays `cards.ownerOf(c)` (callable by anyone, same checks, push per holder), and decide on a post-assembly exit (e.g. a DISTRIBUTE vote that transfers the Statement to a fractional/auction module) before mainnet.

### T-7 (INFO): missing events (from A-L6)
`countBlocked` (governance rule change is invisible to indexers), `withdraw` (fee/royalty payouts), `CreditCards.registerParty`, and the FULL-state branch of `execute` (pendingPrice set; only `Executed` fires).
```diff
+    event BlockedCounted(uint256 indexed id, uint256 total);
+    event Withdrawn(address indexed to, uint256 amount);
+    event PendingPriceSet(PriceMode mode, int256 value);
```
Emit in `countBlocked`, `withdraw`, and `execute` (FULL branch); add `event PartyRegistered(address indexed party)` in CreditCards.

---

## Loop gas (measured, `forge test --isolate`, local Credits source + MockStatement)
| Path | Worst case | Block-limit risk | Griefable? |
|---|---|---|---|
| `_removeFromOrder` (redeem) | 1 card at slot 0 of 79: 642k; 59 cards in one call: 6.31M | No (≤80 entries) | Only the caller pays; max 80 shifts. |
| `_positionOf` + `_checkPermutation` | part of assemble: deposit preset 7.08M total, rarity preset 12.2M total (incl. 80 `describe` calls and mock burn) | No; the real Statement mint cost is unknown and adds on top | No: fixed 80×80. |
| `_refreshOpen` | grows with proposal count; 256 proposals cost 168.7M gas total (avg 659k each) | No per call | The cap it relies on is the DoS (T-1). |
| `claim`, `redeem`, `redeemFor` | caller-sized arrays | Caller chooses | No. |

## ReentrancyGuardTransient in clones
OZ 5.4 stores the guard in a transient slot of the executing context. A clone delegates to the implementation, so the slot is the clone's own; no initialization needed (transient storage starts at 0 every tx). Requires Cancun (foundry.toml `evm_version = "cancun"`; mainnet has it). The guard is per party, which is correct: no cross-party callback exists. Unguarded functions (`propose`, `vote`, `countBlocked`, `raiseAsk`, `transferHost`) reached from a guarded function's ETH callback see a SOLD party and fail their status checks.

## Manual review: access control and state machine
| Function | Who | Status allowed | Notes |
|---|---|---|---|
| initialize | factory (once) | – | atomic with clone |
| deposit | Credit owner | OPEN | merkle-gated |
| redeem | card holder | OPEN, EXPIRED | |
| redeemFor | anyone | EXPIRED | pays the card holder |
| assemble | host (Manual) / any card holder (auto) | FULL | irreversible; per SPEC v0.8 §3 no vote. SPEC §2/§4 tables still describe APPROVE_ARRANGEMENT/ASSEMBLE votes: spec is internally inconsistent. |
| propose | card holder now + weight at block-1 | FULL/ASSEMBLED (cancel: ASSEMBLED, ask>0) | T-1, T-2 |
| vote | weight at snapshot | window open, any status | harmless after close/supersede |
| execute | card holder now | FULL/ASSEMBLED | T-4 liveness |
| countBlocked | anyone | any | T-2 |
| raiseAsk | anyone | ASSEMBLED, floor mode | spec says "any member"; anyone is harmless (can only raise), but can front-run a buyer into a `maxPrice` revert |
| buy | anyone | ASSEMBLED, ask>0, ≥24 h live | T-3, T-5 |
| claim | card holder | SOLD | T-6 |
| withdraw | owed address | any | |
| transferHost | host | any | single-step; typo = host lost (Manual parties then cannot assemble and expire) |

Status transitions: OPEN↔OPEN (redeem shrinks), OPEN→FULL (80th deposit), OPEN/FULL→EXPIRED (time only, `>` deadline), FULL→ASSEMBLED (assemble), ASSEMBLED→SOLD (buy). ASSEMBLED ignores the deadline (correct) and has no exit (T-6). No path skips a state. `DEADLOCK_TIME` counts from `fullAt`, not assembly (spec says "since FULL/assembly").

Spec features absent from the contracts (not bugs, decisions to record): multiple hosts, host param edits, host early close, NOMINATE_ARRANGER / APPROVE_ARRANGEMENT votes, claimFor, Royalty Registry fallback, "any Credit holder" gate on createParty.
