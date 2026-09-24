# 🔐 Security Review — statement-maker-2026-09-23

---

## Scope

|  |  |
| --- | --- |
| **Mode** | default |
| **Files reviewed** | `./script/DeploySepolia.s.sol` · `./script/DeployMainnet.s.sol` · `./src/CreditKeys.sol`<br>`./src/StatementMarket.sol` · `./src/Party.sol` · `./src/CreditCards.sol`<br>`./src/PartyFactory.sol` · `./src/testnet/KeyProbe.sol` |
| **Confidence threshold (1-100)** | 75 |
| **Passes** | 2 (pass 1 ran 6/12 agents) |
| **Memory** | 0 records before this scan · 18 after · `165a33e` |

---

## Findings

[90] **1. KNOWN: R-2. A coalition trips deadlock and removes the minority veto in two hours**

`Party.countBlocked` · Confidence: 90 · seen in 2/2 runs · NEW

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

---

[85] **2. KNOWN: R-7. One card holder burns before a passed price executes**

`Party.assemble` · Confidence: 85 · seen in 2/2 runs · NEW

**Description**
A holder of one card calls assemble before execute, so the host default goes live, and with a 0-hour wait that holder buys the Statement at once.

**Fix**

```diff
+        // FULL-phase votes need time to finish: no default-price burn before the shortest window has passed
+        if (!hasPendingPrice && block.timestamp < fullAt + _t(1 hours)) revert Bad("vote window");
         buyableAt = uint64(block.timestamp + _t(uint256(hasPendingPrice ? _pendingBuyDelay : _params.buyDelayHours) * 1 hours));
+        if (buyableAt < block.timestamp + _t(24 hours)) buyableAt = uint64(block.timestamp + _t(24 hours));
```

---

[80] **3. A negative floor-relative price reverts before the minimum ask applies**

`Party._resolveWith` · Confidence: 80 · seen in 2/2 runs · NEW

**Description**
When the signed floor is at or below the FloorDelta amount, or FloorPct rounds to 0, _resolveWith reverts, so no caller can assemble, execute or raiseAsk.

**Fix**

```diff
-        if (r <= 0) revert Bad("price <= 0");
-        return uint256(r);
+        return r <= 0 ? 0 : uint256(r); // _clampMin raises it to minAskWei (> 0 for floor-relative specs)
```

---

[60] **4. A proposal in the fill block gives the last depositors no weight**

`Party.propose` · Confidence: 60 · seen in 2/2 runs · NEW

**Description**
A proposal made in the block that fills slot 80 snapshots the previous block, so the last depositors cannot vote NO on it.

---

[55] **5. A FULL-phase Fixed price is not checked against the floor at burn**

`Party.execute` · Confidence: 55 · seen in 2/2 runs · NEW

**Description**
Holders pass a Fixed price with 41 votes while FULL, and assemble makes it live later with no new floor check. SPEC judges below-floor at execution.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [90] | KNOWN: R-2. A coalition trips deadlock and removes the minority veto in two hours |
| 2 | [85] | KNOWN: R-7. One card holder burns before a passed price executes |
| 3 | [80] | A negative floor-relative price reverts before the minimum ask applies |
| | | **Below Confidence Threshold** |
| 4 | [60] | A proposal in the fill block gives the last depositors no weight |
| 5 | [55] | A FULL-phase Fixed price is not checked against the floor at burn |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- **The gas test covers five of the eleven presets** — `CreditKeys.key` · seen in 1/2 runs · NEW — test/gas/Cap.t.sol measures presets 0 to 4 only, so Print, Weight, Eights, Ink and Random have no measurement against the 16,777,216 cap.
- **KNOWN: R-2. The deadlock clock and counter survive the burn** — `Party._deadlocked` · seen in 2/2 runs · NEW — Assemble does not reset blockedPriceProposals or lastPriceExecutedAt, so FULL-phase state carries into the first vote after the burn.
- **On a short testnet clock the buy wait is shorter than the floor age** — `Party._delayOk` · seen in 2/2 runs · NEW — TestnetPartyFactory lets timeUnit fall under 600 seconds, so the buy wait is shorter than FLOOR_MAX_AGE. Mainnet is not affected.
- **The Statement approval also covers stray Credits in the party** — `Party.assemble` · seen in 1/2 runs · NEW — setApprovalForAll covers every Credit the party holds. Only Credits sent straight to the party are exposed, and they are already stuck (R-9).
- **KNOWN: R-6. The assembler chooses the floor reading** — `Party.assemble` · seen in 1/2 runs · NEW — The assembler picks the lowest valid reading for a floor-relative ask. The 1-hour buy wait and raiseAsk limit this.
- **A Manual host with no cards chooses the burn order** — `Party.assemble` · seen in 1/2 runs · NEW — The host can redeem or transfer the host role and still choose any order during MANUAL_GRACE. The order moves no funds.
- **KNOWN: R-6. The executor chooses the floor reading** — `Party.execute` · seen in 2/2 runs · NEW — The executor picks any signed reading from the last 10 minutes, or none for a Fixed price, so the executor sets the 41 or 60 threshold.
- **41 holders vote a price at the floor and one of them buys** — `Party.execute` · seen in 1/2 runs · NEW — A 41-card group passes a Fixed price equal to the lagging floor. Any single NO stops this outside deadlock mode.
- **KNOWN: R-6. raiseAsk moves lastFloorAt forward for every caller** — `Party.raiseAsk` · seen in 2/2 runs · NEW — Any caller picks which valid reading raises the ask, and the newer lastFloorAt makes an older execute reading revert.
- **KNOWN: R-16. The Statement contract can call raiseAsk during make** — `Party.raiseAsk` · seen in 1/2 runs · NEW — raiseAsk has no reentrancy lock, so a Statement contract can raise the ask inside make, and the AskSet event then shows the old price.
- **redeemFor pushes a Credit to a contract that holds the card** — `Party.redeemFor` · seen in 2/2 runs · NEW — Any caller sends an expired party's Credit to the card holder, and a holder contract with no ERC-721 exit keeps it.
- **KNOWN: R-4. A floor signature is valid in every party** — `PartyFactory.isValidFloor` · seen in 1/2 runs · NEW — The signed struct names no party, so one reading works in every party that uses the same floor mode.
- **The buyer callback runs before the seller is paid** — `StatementMarket.buy` · seen in 1/2 runs · NEW — safeTransferFrom calls the buyer before the seller payment. The reentrancy lock blocks buy and withdraw, so no loss was found.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
