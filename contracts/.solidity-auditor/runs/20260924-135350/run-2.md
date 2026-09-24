# Run 2 — solidity-auditor

<!--RUN pass=2 of=2 stamp=20260924-135350 sha=165a33e agents=12/12-->

Pass 2 of 2 · 2026-09-24 · `165a33e` · 12/12 agents returned (Sonnet; pass 1 Opus agents were stopped by an API safety filter).

## Findings

<!--F key=party|countblocked|deadlock-self-trigger conf=90 kind=FINDING agents=6-->

[90] **KNOWN: R-2. A coalition trips deadlock and removes the minority veto in two hours**

`Party.countBlocked` · Confidence: 90

**Description**
countBlocked counts a NO from the coalition itself and uses 41 instead of the real threshold, so 60 cards sell the Statement for 1 wei two hours after the burn.

**Fix (Option A — restrict)**

```diff
- if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked");
+ if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch
+     || p.endsAt - p.startedAt < _t(24 hours) || countedFrom[priceEpoch][p.proposer]) revert Bad("not blocked");
+ countedFrom[priceEpoch][p.proposer] = true;
```

**Fix (Option B — validate)**

```diff
- function countBlocked(uint256 id) external {
+ function countBlocked(uint256 id, Floor calldata floor) external {
+     uint256 f = _floor(floor);
+     uint256 price = p.price.mode == PriceMode.Fixed ? uint256(p.price.value) : _clampMin(_resolveWith(p.price, f));
+     if (p.yes < needFor(id, price, f)) revert Bad("not blocked");
```

<!--/F-->

<!--F key=party|assemble|assemble-supersedes-passed-price conf=85 kind=FINDING agents=5-->

[85] **KNOWN: R-7. One card holder burns before a passed price executes**

`Party.assemble` · Confidence: 85

**Description**
A holder of one card calls assemble before execute, so the host default goes live, and with a 0-hour wait that holder buys the Statement at once.

**Fix**

```diff
+        // FULL-phase votes need time to finish: no default-price burn before the shortest window has passed
+        if (!hasPendingPrice && block.timestamp < fullAt + _t(1 hours)) revert Bad("vote window");
         buyableAt = uint64(block.timestamp + _t(uint256(hasPendingPrice ? _pendingBuyDelay : _params.buyDelayHours) * 1 hours));
+        if (buyableAt < block.timestamp + _t(24 hours)) buyableAt = uint64(block.timestamp + _t(24 hours));
```

<!--/F-->

<!--F key=party|_resolvewith|floor-delta-no-clamp conf=80 kind=FINDING agents=7-->

[80] **A negative floor-relative price reverts before the minimum ask applies**

`Party._resolveWith` · Confidence: 80

**Description**
When the signed floor is at or below the FloorDelta amount, or FloorPct rounds to 0, _resolveWith reverts, so no caller can assemble, execute or raiseAsk.

**Fix**

```diff
-        if (r <= 0) revert Bad("price <= 0");
-        return uint256(r);
+        return r <= 0 ? 0 : uint256(r); // _clampMin raises it to minAskWei (> 0 for floor-relative specs)
```

<!--/F-->

<!--F key=party|propose|fill-block-snapshot-veto-gap conf=60 kind=FINDING agents=3-->

[60] **A proposal in the fill block gives the last depositors no weight**

`Party.propose` · Confidence: 60

**Description**
A proposal made in the block that fills slot 80 snapshots the previous block, so the last depositors cannot vote NO on it.

<!--/F-->

<!--F key=party|execute|pending-price-floor-not-rechecked conf=55 kind=FINDING agents=4-->

[55] **A FULL-phase Fixed price is not checked against the floor at burn**

`Party.execute` · Confidence: 55

**Description**
Holders pass a Fixed price with 41 votes while FULL, and assemble makes it live later with no new floor check. SPEC judges below-floor at execution.

<!--/F-->

## Leads

<!--F key=party|execute|caller-chosen-floor-reading kind=LEAD agents=7-->

- **KNOWN: R-6. The executor chooses the floor reading** — `Party.execute` — The executor picks any signed reading from the last 10 minutes, or none for a Fixed price, so the executor sets the 41 or 60 threshold.

<!--/F-->

<!--F key=party|assemble|caller-chosen-floor-reading kind=LEAD agents=1-->

- **KNOWN: R-6. The assembler chooses the floor reading** — `Party.assemble` — The assembler picks the lowest valid reading for a floor-relative ask. The 1-hour buy wait and raiseAsk limit this.

<!--/F-->

<!--F key=party|raiseask|floor-reading-selection kind=LEAD agents=2-->

- **KNOWN: R-6. raiseAsk moves lastFloorAt forward for every caller** — `Party.raiseAsk` — Any caller picks which valid reading raises the ask, and the newer lastFloorAt makes an older execute reading revert.

<!--/F-->

<!--F key=partyfactory|isvalidfloor|floor-signature-not-party-scoped kind=LEAD agents=1-->

- **KNOWN: R-4. A floor signature is valid in every party** — `PartyFactory.isValidFloor` — The signed struct names no party, so one reading works in every party that uses the same floor mode.

<!--/F-->

<!--F key=party|_deadlocked|deadlock-clock-not-reset-on-assembly kind=LEAD agents=2-->

- **KNOWN: R-2. The deadlock clock and counter survive the burn** — `Party._deadlocked` — Assemble does not reset blockedPriceProposals or lastPriceExecutedAt, so FULL-phase state carries into the first vote after the burn.

<!--/F-->

<!--F key=party|_delayok|timeunit-floor-age-mismatch kind=LEAD agents=1-->

- **On a short testnet clock the buy wait is shorter than the floor age** — `Party._delayOk` — TestnetPartyFactory lets timeUnit fall under 600 seconds, so the buy wait is shorter than FLOOR_MAX_AGE. Mainnet is not affected.

<!--/F-->

<!--F key=party|redeemfor|push-to-contract-holder kind=LEAD agents=1-->

- **redeemFor pushes a Credit to a contract that holds the card** — `Party.redeemFor` — Any caller sends an expired party's Credit to the card holder, and a holder contract with no ERC-721 exit keeps it.

<!--/F-->

<!--F key=party|execute|majority-floor-price-selfdeal kind=LEAD agents=1-->

- **41 holders vote a price at the floor and one of them buys** — `Party.execute` — A 41-card group passes a Fixed price equal to the lagging floor. Any single NO stops this outside deadlock mode.

<!--/F-->

<!--F key=party|assemble|manual-host-zero-stake kind=LEAD agents=1-->

- **A Manual host with no cards chooses the burn order** — `Party.assemble` — The host can redeem or transfer the host role and still choose any order during MANUAL_GRACE. The order moves no funds.

<!--/F-->

<!--F key=party|raiseask|reentrant-ask-raise-during-assemble kind=LEAD agents=1-->

- **KNOWN: R-16. The Statement contract can call raiseAsk during make** — `Party.raiseAsk` — raiseAsk has no reentrancy lock, so a Statement contract can raise the ask inside make, and the AskSet event then shows the old price.

<!--/F-->

<!--F key=statementmarket|buy|safe-transfer-before-seller-payment kind=LEAD agents=1-->

- **The buyer callback runs before the seller is paid** — `StatementMarket.buy` — safeTransferFrom calls the buyer before the seller payment. The reentrancy lock blocks buy and withdraw, so no loss was found.

<!--/F-->

<!--F key=party|assemble|blanket-approval-exposes-extra-credits kind=LEAD agents=1-->

- **The Statement approval also covers stray Credits in the party** — `Party.assemble` — setApprovalForAll covers every Credit the party holds. Only Credits sent straight to the party are exposed, and they are already stuck (R-9).

<!--/F-->

