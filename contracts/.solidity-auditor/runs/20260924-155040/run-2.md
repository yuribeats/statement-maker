# Run 2 — solidity-auditor

<!--RUN pass=2 of=2 stamp=20260924-155040 sha=d548e55 agents=12/12-->

Pass 2 of 2 · 2026-09-24 · `d548e55` · 12/12 agents returned — the execution-trace, first-principles, asymmetry, trust-gap and flow-gap agents were stopped by a safety filter on Opus and re-ran on Sonnet; five Opus agents returned reports after a filter cut one response each.

## Findings

<!--F key=party|countblocked|deadlock-self-trigger conf=90 kind=FINDING agents=2-->

[90] **KNOWN: R-2 (ACCEPTED). A coalition trips deadlock and removes the minority veto in two hours**

`Party.countBlocked` · Confidence: 90

**Description**
countBlocked counts a NO from the coalition itself and uses 41 instead of the real threshold, so 60 cards reach deadlock mode in hours. The owner accepted this risk (H1).

**Fix**

```diff
- if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked");
+ if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch
+     || p.endsAt - p.startedAt < _t(24 hours) || countedFrom[priceEpoch][p.proposer]) revert Bad("not blocked");
+ countedFrom[priceEpoch][p.proposer] = true;
```

<!--/F-->

<!--F key=party|execute|pending-price-floor-not-rechecked conf=85 kind=FINDING agents=6-->

[85] **A price that passed with 41 votes while FULL goes live below the floor at the burn**

`Party.execute` · Confidence: 85

**Description**
execute stores a FULL-phase price as pendingPrice, and assemble applies it with no needFor check, so 41 holders list the Statement below the burn floor. This holds for a Fixed price and for a floor-relative price that the minAskWei clamp raised.

**Fix (Option A — validate)**

```diff
         } else {
-            spec = hasPendingPrice ? pendingPrice : _params.defaultPrice;
-            price = _resolve(spec, floor);
+            spec = hasPendingPrice ? pendingPrice : _params.defaultPrice;
+            if (hasPendingPrice) {
+                (uint256 pp, uint256 fw) = _judgePrice(spec, floor);
+                if (_pendingYes < ((pp < fw) ? PASS_BELOW_FLOOR : PASS)) revert Bad("pending price below floor");
+                price = pp;
+            } else price = _resolve(spec, floor);
```

**Fix (Option B — ban-path)**

```diff
-        } else if (s == Status.FULL) {
-            pendingPrice = p.price;
-            _pendingBuyDelay = p.buyDelayHours;
-            hasPendingPrice = true;
+        } else if (s == Status.FULL) {
+            revert Bad("vote the price after the burn"); // or: let _passedUnexecuted judge it at the burn floor
```

<!--/F-->

<!--F key=party|assemble|burn-scan-proposal-spam conf=80 kind=FINDING agents=12-->

[80] **One card holder adds proposals until the burn needs more gas than the cap**

`Party.assemble` · Confidence: 80

**Description**
A holder moves one card to a new address each block and proposes 3 times from each, so _passedUnexecuted reads about 1,650 proposals and assemble fails for every caller.

**Fix (Option A — allow-and-handle)**

```diff
+    mapping(uint64 epoch => uint256[]) internal _passedIds; // LIST proposals whose YES reached PASS or PASS_DEADLOCK
     function _vote(uint256 id, address voter, bool support) internal {
         ...
         if (support) p.yes += w; else p.no += w;
+        if (!p.cancel && prevYes < PASS && p.yes >= PASS) _passedIds[p.epoch].push(id);
-        for (uint256 i = _proposals.length; i > 0; --i) {
-            Proposal storage q = _proposals[i - 1];
-            if (q.epoch != priceEpoch) break;
+        uint256[] storage c = _passedIds[priceEpoch];
+        for (uint256 i = c.length; i > 0; --i) {
+            Proposal storage q = _proposals[c[i - 1]];
```

**Fix (Option B — restrict)**

```diff
+    uint256 public constant MAX_PROPOSALS_PER_EPOCH = 300;
+    mapping(uint64 epoch => uint256) internal _epochProposals;
     function propose(...) external returns (uint256 id) {
         ...
+        if (++_epochProposals[priceEpoch] > MAX_PROPOSALS_PER_EPOCH) revert Bad("epoch limit");
```

<!--/F-->

## Leads

<!--F key=party|assemble|floor-needed-burn-block kind=LEAD agents=9-->

**A passed price makes every burn depend on the floor signer**

`Party.assemble`

**Description**
_passedUnexecuted reverts "floor needed" for a passed Fixed candidate with 41 to 59 YES, and calls _floor for a floor-relative one, so every burn needs a fresh floorSigner signature. The revert is intended; a signer outage near the deadline was not tested.

**Code smells**
revert inside the candidate loop; immutable floorSigner; FLOOR_MAX_AGE 10 minutes; FILL_GRACE 2 days.

<!--/F-->

<!--F key=party|assemble|blanket-approval-exposes-extra-credits kind=LEAD agents=7-->

**The Statement approval also covers stray Credits in the party**

`Party.assemble`

**Description**
setApprovalForAll covers every Credit the party holds. Only Credits sent straight to the party are exposed, and they are already stuck.

**Code smells**
`credits.setApprovalForAll(address(st), true)` during make.

<!--/F-->

<!--F key=party|assemble|caller-chosen-floor-reading kind=LEAD agents=4-->

**KNOWN: R-6. The assembler chooses the floor reading**

`Party.assemble`

**Description**
The assembler picks which valid reading judges a passed Fixed candidate, so it can skip the newest passed price and apply an older one or the default.

**Code smells**
caller-supplied `Floor` in `_passedUnexecuted` and `_resolve`.

<!--/F-->

<!--F key=party|assemble|manual-host-zero-stake kind=LEAD agents=3-->

**A Manual host with no cards chooses the burn order**

`Party.assemble`

**Description**
The host can redeem or transfer the host role and still choose any order during MANUAL_GRACE. The order moves no funds.

**Code smells**
host check with no card check in the Manual branch.

<!--/F-->

<!--F key=party|assemble|statement-interface-assumption kind=LEAD agents=1-->

**The real Statement contract may not match IStatement**

`Party.assemble`

**Description**
IStatement.make follows MockStatement, and the factory fixes the Statement address, so a different real ABI makes every burn fail. The real contract is unpublished.

**Code smells**
immutable `statement`; DeployMainnet checks only `code.length > 0`.

<!--/F-->

<!--F key=party|initialize|unbounded-min-ask kind=LEAD agents=2-->

**The host can set minAskWei with no upper bound**

`Party.initialize`

**Description**
A host sets a very high minAskWei, so every floor-relative price resolves to it. Holders can still vote a Fixed price, and depositors see the value first.

**Code smells**
no upper bound on `minAskWei`; `_clampMin` on every floor-relative price.

<!--/F-->

<!--F key=party|raiseask|reentrant-ask-raise-during-assemble kind=LEAD agents=1-->

**KNOWN: R-16. The Statement contract can call raiseAsk during make**

`Party.raiseAsk`

**Description**
raiseAsk has no reentrancy lock, so a Statement contract can raise the ask inside make, and the AskSet event then shows the old price.

**Code smells**
no `nonReentrant` on raiseAsk; status is ASSEMBLED before `st.make`.

<!--/F-->

<!--F key=party|redeemfor|push-to-contract-holder kind=LEAD agents=1-->

**redeemFor pushes a Credit to a contract that holds the card**

`Party.redeemFor`

**Description**
Any caller sends an expired party's Credit to the card holder, and a holder contract with no ERC-721 exit keeps it.

**Code smells**
push transfer to `cards.ownerOf(c)` chosen by any caller.

<!--/F-->

<!--F key=partyfactory|isvalidfloor|floor-signature-not-party-scoped kind=LEAD agents=3-->

**KNOWN: R-4. A floor signature is valid in every party**

`PartyFactory.isValidFloor`

**Description**
The signed struct names no party, so one reading works in every party that uses the same floor mode.

**Code smells**
`floorDigest(floorWei, mode, issuedAt)` has no party field.

<!--/F-->

<!--F key=statementmarket|buy|safe-transfer-before-seller-payment kind=LEAD agents=5-->

**The buyer callback runs before the seller is paid**

`StatementMarket.buy`

**Description**
safeTransferFrom calls the buyer before the seller payment. The reentrancy lock blocks buy and withdraw, so no loss was found.

**Code smells**
external callback before the seller's ETH transfer.

<!--/F-->

<!--F key=creditkeys|verifyorder|random-order-predictable kind=LEAD agents=1-->

**A depositor knows the Random position of each deposit slot in advance**

`CreditKeys.verifyOrder`

**Description**
The Random seed is public at creation, so a depositor picks a slot that maps to a chosen burn position. The docs call the seed published, so this may be intended.

**Code smells**
fixed public `seed`; shuffle depends only on seed and n.

<!--/F-->

<!--F key=deploysepolia|run|traits-table-unsealed-collection kind=LEAD agents=2-->

**The Sepolia table misses Credits minted after the build**

`DeploySepolia.run`

**Description**
The EXISTING_CREDITS path builds the table from supply() with no isSealed check, so a later Credit makes trait-preset burns revert. Mainnet is sealed and not affected.

**Code smells**
no `isSealed()` check; no `traits.count()` check against supply.

<!--/F-->

<!--F key=deploysepolia|run|resume-reissues-known-seeds kind=LEAD agents=1-->

**The Sepolia resume path sends seeds that are already minted**

`DeploySepolia.run`

**Description**
With EXISTING_UNSEALED_CREDITS set, the distribute loop restarts at k = 0, so the resumed deploy reverts on a known seed. The script was not run.

**Code smells**
loop index restarts at 0 on resume.

<!--/F-->

<!--F key=party|assemble|testnet-time-unit-buy-delay kind=LEAD agents=2-->

**On a short testnet clock the buy wait is shorter than the floor age**

`Party.assemble`

**Description**
TestnetPartyFactory lets timeUnit fall under 600 seconds, so the 1-hour buy wait is shorter than FLOOR_MAX_AGE. Mainnet is not affected.

**Code smells**
`_t()` scales the buy wait; FLOOR_MAX_AGE stays in real time.

<!--/F-->
