# Run 1 — solidity-auditor

<!--RUN pass=1 of=2 stamp=20260924-135350 sha=001fe60 agents=6/12-->

Pass 1 of 2 · 2026-09-24 · `001fe60` · 6/12 agents returned — the math-precision, access-control, economic-security, invariant, first-principles and boundary agents died (API safety filter).

## Findings

<!--F key=party|countblocked|deadlock-self-trigger conf=85 kind=FINDING agents=4-->

[85] **KNOWN: R-2. A coalition blocks its own proposals and ends the minority veto in two hours**

`Party.countBlocked` · Confidence: 85

**Description**
A coalition that holds 42 cards votes NO on its own three 1-hour proposals, so deadlock starts and 60 cards then sell the Statement for 1 wei.

**Fix**

```diff
  struct Proposal {
+     uint16 windowHours; // voting window chosen at propose
  }
- if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked");
+ if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch
+     || p.windowHours < 24 || countedFrom[priceEpoch][p.proposer]) revert Bad("not blocked"); // full-length windows, one count per proposer per epoch
+ countedFrom[priceEpoch][p.proposer] = true;
```

<!--/F-->

<!--F key=party|_resolvewith|floor-delta-no-clamp conf=75 kind=FINDING agents=3-->

[75] **A negative FloorDelta price reverts before the minimum ask applies**

`Party._resolveWith` · Confidence: 75

**Description**
When the signed floor is at or below the FloorDelta amount, `_resolveWith` reverts, so no caller can assemble and the full party waits for expiry.

**Fix**

```diff
-        if (r <= 0) revert Bad("price <= 0");
-        return uint256(r);
+        return r <= 0 ? 0 : uint256(r); // _clampMin raises it to minAskWei (> 0 for floor-relative specs)
```

<!--/F-->

<!--F key=party|assemble|assemble-supersedes-passed-price conf=75 kind=FINDING agents=2-->

[75] **KNOWN: R-7. One card holder burns before a passed price executes**

`Party.assemble` · Confidence: 75

**Description**
A holder of one card calls assemble before execute, so the host default goes live, and with a 0-hour wait the holder buys at once.

**Fix**

```diff
-        buyableAt = uint64(block.timestamp + _t(uint256(hasPendingPrice ? _pendingBuyDelay : _params.buyDelayHours) * 1 hours));
+        buyableAt = uint64(block.timestamp + _t(uint256(hasPendingPrice ? _pendingBuyDelay : _params.buyDelayHours) * 1 hours));
+        if (buyableAt < block.timestamp + _t(24 hours)) buyableAt = uint64(block.timestamp + _t(24 hours)); // a CANCEL can close first
```

<!--/F-->

## Leads

<!--F key=party|execute|caller-chosen-floor-reading kind=LEAD agents=3-->

- **KNOWN: R-6. The executor chooses the floor reading** — `Party.execute` — The executor or assembler picks any signed reading from the last 10 minutes, so the caller sets the 41 or 60 threshold. The signing frequency is not verified.

<!--/F-->

<!--F key=party|raiseask|floor-reading-selection kind=LEAD agents=2-->

- **KNOWN: R-6. raiseAsk moves lastFloorAt forward for every caller** — `Party.raiseAsk` — Any caller picks the highest valid reading, and the newer lastFloorAt makes a pending execute with an older reading revert. The executor can retry with a new reading.

<!--/F-->

<!--F key=party|execute|pending-price-floor-not-rechecked kind=LEAD agents=1-->

- **A FULL-phase Fixed price is not checked against the floor at burn** — `Party.execute` — Holders pass a Fixed price with 41 votes while FULL, and assemble makes it live later with no new floor check. SPEC judges below-floor at execution, so this can be intended.

<!--/F-->

<!--F key=party|_deadlocked|deadlock-clock-not-reset-on-assembly kind=LEAD agents=2-->

- **KNOWN: R-2. The deadlock clock and counter survive the burn** — `Party._deadlocked` — Assemble does not reset blockedPriceProposals or lastPriceExecutedAt, so a FULL-phase execution starts the 30-day clock before the burn. SPEC intent is unclear.

<!--/F-->

<!--F key=party|propose|fill-block-snapshot-veto-gap kind=LEAD agents=1-->

- **A proposal in the fill block gives the last depositors no weight** — `Party.propose` — A proposal made in the block that fills slot 80 snapshots the previous block, so the last depositors cannot vote NO. Assembly supersedes it, so the harm is not proven.

<!--/F-->

<!--F key=party|_delayok|timeunit-floor-age-mismatch kind=LEAD agents=2-->

- **On a short testnet clock the buy wait is shorter than the floor age** — `Party._delayOk` — TestnetPartyFactory lets timeUnit fall under 600 seconds, so the 1-hour buy wait is shorter than FLOOR_MAX_AGE. Mainnet uses 1 hour and is not affected.

<!--/F-->

<!--F key=party|redeemfor|push-to-contract-holder kind=LEAD agents=1-->

- **redeemFor pushes a Credit to a contract that holds the card** — `Party.redeemFor` — Any caller sends an expired party's Credit to the card holder, and a holder contract with no ERC-721 exit keeps it. No such holder was shown.

<!--/F-->

<!--F key=creditkeys|key|gas-cap-untested-presets kind=LEAD agents=1-->

- **The gas test covers five of the eleven presets** — `CreditKeys.key` — test/gas/Cap.t.sol measures presets 0 to 4 only, so Print, Weight, Eights, Ink and Random have no measurement against the 16,777,216 cap.

<!--/F-->
