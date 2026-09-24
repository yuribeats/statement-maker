# 🔐 Security Review — contracts

---

## Scope

|  |  |
| --- | --- |
| **Mode** | default |
| **Files reviewed** | `./script/DeploySepolia.s.sol` · `./script/TraitsTable.sol` · `./script/DeployMainnet.s.sol`<br>`./src/CreditTraits.sol` · `./src/CreditKeys.sol` · `./src/StatementMarket.sol`<br>`./src/Party.sol` · `./src/CreditCards.sol` · `./src/PartyFactory.sol`<br>`./src/testnet/KeyProbe.sol` |
| **Confidence threshold (1-100)** | 75 |
| **Passes** | 2 |
| **Memory** | 14 records before this scan · 23 after · `d548e55` |

---

## Findings

[90] **1. KNOWN: R-2 (ACCEPTED). A coalition trips deadlock and removes the minority veto in two hours**

`Party.countBlocked` · Confidence: 90 · seen in 2/2 runs · KNOWN (2 scans)

**Description**
countBlocked counts a NO from the coalition itself and uses 41 instead of the real threshold, so 60 cards reach deadlock mode in hours. The owner accepted this risk (H1).

**Fix**

```diff
- if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked");
+ if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch
+     || p.endsAt - p.startedAt < _t(24 hours) || countedFrom[priceEpoch][p.proposer]) revert Bad("not blocked");
+ countedFrom[priceEpoch][p.proposer] = true;
```

---

[85] **2. A price that passed with 41 votes while FULL goes live below the floor at the burn**

`Party.execute` · Confidence: 85 · seen in 2/2 runs · KNOWN (2 scans)

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

---

[80] **3. One card holder adds proposals until the burn needs more gas than the cap**

`Party.assemble` · Confidence: 80 · seen in 2/2 runs · NEW

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

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [90] | KNOWN: R-2 (ACCEPTED). A coalition trips deadlock and removes the minority veto in two hours |
| 2 | [85] | A price that passed with 41 votes while FULL goes live below the floor at the burn |
| 3 | [80] | One card holder adds proposals until the burn needs more gas than the cap |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 1 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · NEW — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · KNOWN (2 scans) — **Body missing** — pass 1 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 1/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.
- ****Title missing** — the lead's line could not be read** — **location missing** · seen in 2/2 runs · KNOWN (2 scans) — **Body missing** — pass 2 raised this lead and wrote no description.

---

## Known from earlier scans

_Recorded by earlier scans of this repo, not raised again by this one. Not re-checked — a record here may be fixed, or may still be live and missed. `.solidity-auditor/memory.tsv`._

| Scans | Kind | Location | Title |
|---|---|---|---|
| 1 | FINDING | `Party.assemble` | KNOWN: R-7. One card holder burns before a passed price executes |
| 1 | LEAD | `Party.execute` | KNOWN: R-6. The executor chooses the floor reading |
| 1 | LEAD | `Party.execute` | 41 holders vote a price at the floor and one of them buys |
| 1 | FINDING | `Party.propose` | A proposal in the fill block gives the last depositors no weight |

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
