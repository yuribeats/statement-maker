# Run 1 — solidity-auditor

<!--RUN pass=1 of=2 stamp=20260924-155040 sha=d548e55 agents=12/12-->

Pass 1 of 2 · 2026-09-24 · `d548e55` · 12/12 agents returned — the economic-security, execution-trace and asymmetry agents were stopped by a safety filter on Opus and re-ran on Sonnet; the math-precision and trust-gap agents returned their reports after a filter cut one response each.

## Findings

<!--F key=party|countblocked|deadlock-self-trigger conf=90 kind=FINDING agents=1-->

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

<!--F key=party|execute|pending-price-floor-not-rechecked conf=55 kind=FINDING agents=1-->

[55] **A FULL-phase Fixed price is not checked against the floor at burn**

`Party.execute` · Confidence: 55

**Description**
Holders pass a Fixed price with 41 votes while FULL, and assemble makes it live later through _resolve, which returns a Fixed price with no new floor check.

<!--/F-->

## Leads

<!--F key=party|assemble|floor-needed-burn-block kind=LEAD agents=2-->

**A passed price makes every burn depend on the floor signer**

`Party.assemble`

**Description**
_passedUnexecuted reverts "floor needed" or calls _floor for a passed candidate, so every burn needs a fresh floorSigner signature. We did not test a signer outage near the deadline.

**Code smells**
revert on empty signature inside the candidate loop; `_floor` needs a signature at most 10 minutes old; FILL_GRACE is 2 days.

<!--/F-->

<!--F key=party|claimfor|push-to-contract-holder kind=LEAD agents=1-->

**claimFor sends a card's share to a contract that holds the card**

`Party.claimFor`

**Description**
Any caller burns a card and sends its ETH share to the holder contract with 50,000 gas. We did not find a real holder contract that then loses the ETH.

**Code smells**
push payment to `cards.ownerOf(c)` chosen by any caller; the card is burned before the send.

<!--/F-->

<!--F key=partyfactory|isvalidfloor|floor-signature-not-party-scoped kind=LEAD agents=2-->

**KNOWN: R-4. A floor signature is valid in every party**

`PartyFactory.isValidFloor`

**Description**
The signed struct names no party, so one reading works in every party that uses the same floor mode.

**Code smells**
`floorDigest(floorWei, mode, issuedAt)` has no party field.

<!--/F-->

<!--F key=statementmarket|buy|safe-transfer-before-seller-payment kind=LEAD agents=2-->

**The buyer callback runs before the seller is paid**

`StatementMarket.buy`

**Description**
safeTransferFrom calls the buyer before the seller payment. The reentrancy lock blocks buy and withdraw, so no loss was found.

**Code smells**
external callback before the seller's ETH transfer.

<!--/F-->

<!--F key=party|assemble|caller-chosen-floor-reading kind=LEAD agents=1-->

**KNOWN: R-6. The assembler chooses the floor reading**

`Party.assemble`

**Description**
The assembler picks which valid reading judges a passed candidate and resolves a floor-relative ask. The 1-hour minimum wait and raiseAsk limit this.

**Code smells**
caller-supplied `Floor` in `_passedUnexecuted` and `_resolve`.

<!--/F-->

<!--F key=party|assemble|blanket-approval-exposes-extra-credits kind=LEAD agents=1-->

**The Statement approval also covers stray Credits in the party**

`Party.assemble`

**Description**
setApprovalForAll covers every Credit the party holds. Only Credits sent straight to the party are exposed, and they are already stuck.

**Code smells**
`credits.setApprovalForAll(address(st), true)` during make.

<!--/F-->

<!--F key=party|assemble|manual-host-zero-stake kind=LEAD agents=1-->

**A Manual host with no cards chooses the burn order**

`Party.assemble`

**Description**
The host can redeem or transfer the host role and still choose any order during MANUAL_GRACE. The order moves no funds.

**Code smells**
host check with no card check in the Manual branch.

<!--/F-->

<!--F key=party|raiseask|floor-reading-selection kind=LEAD agents=1-->

**KNOWN: R-6. raiseAsk moves lastFloorAt forward for every caller**

`Party.raiseAsk`

**Description**
Any caller picks which valid reading raises the ask, and the newer lastFloorAt makes an older execute reading revert.

**Code smells**
unrestricted caller; shared `lastFloorAt`.

<!--/F-->
