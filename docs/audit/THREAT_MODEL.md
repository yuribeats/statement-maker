# Statement Maker: threat model

Code: `contracts/src/` at `5040009`. See ARCHITECTURE.md for mechanics and INVARIANTS.md for properties.

## 1. Assets at risk

| Asset | Where | Typical size |
|---|---|---|
| Deposited Credits (up to 80 per party) | Party, OPEN/FULL/EXPIRED | Credits floor 0.0276 ETH at research time (RESEARCH.md), so about 2.2 ETH per full party |
| The Statement (1 per party) | Party, ASSEMBLED | Unknown until a Statement market exists |
| Sale proceeds | Party, SOLD, until claimed or withdrawn | The ask |
| Governance rights (vote, price) | CreditCards checkpoints | n/a |

The system never holds ETH before a sale. No Statement Maker key can move Credits, the Statement, or ETH.

## 2. Actors

| Actor | Capabilities | Trust |
|---|---|---|
| **Host** | Opens the party and sets immutable params: eligibility root, preset, seed, default price, floor mode, duration. Only it can assemble a Manual party (choosing any order), and only within 1 day of FULL; after that any card holder burns in Time order. Can `transferHost`. | Trusted for the params they publish. Depositors accept those params by depositing. Not trusted for liveness: an absent Manual host means the party expires. |
| **Card holders** | Redeem (OPEN/EXPIRED). Propose, vote, execute price decisions. Assemble auto-preset parties. Claim 1/80. Cards trade freely. | Untrusted and possibly adversarial. One holder can be a buyer's accomplice. A holder can split cards across many addresses at no cost. |
| **Depositors** | Deposit their own Credits. They have no residual rights once their card moves. | Untrusted |
| **Buyers** | `buy` at the ask after the delay | Untrusted. They can front-run, back-run, and collude with card holders. |
| **Floor signer** (off-chain key + server) | Signs `(floorWei, mode, issuedAt)`. The signature is accepted by every party of the factory for 10 minutes (and never after a newer one was used in that party). | **Trusted for floor values and liveness** (§3). Immutable. It cannot be rotated without a new factory. |
| **Fee recipient** | Pulls 1% plus rounding dust through `withdraw` on each party | Trusted only to be able to receive ETH. It has no control powers. |
| **Statement contract** (Jack Butcher, unpublished) | During `make`, holds operator approval over all of the party's Credits. Mints the Statement. Its `transferFrom` gates the sale. | **Trusted.** Immutable in the factory. Behavior assumed in SCOPE.md §5.3. |
| **Credits contract** | Live, sealed, owner has no remaining powers over tokens | Trusted (verified source) |
| **Merkle root publisher** (indexer) | Computes `eligibleRoot` from the host's filters | Trusted by the host. Anyone can verify the root off-chain from public traits. The rarity-rank filter relies on OpenSea data. |
| **Arbitrary contracts** | Can hold cards, deposit, buy, and receive refunds or payouts. They can revert on ETH receipt and re-enter through callbacks. | Untrusted |

## 3. Trust assumptions and their failure impact

| Assumption | If violated |
|---|---|
| The floor signer reports honest floors | **Compromise, low floor:** in a party with a floor-relative default price and an auto preset, anyone holding one card can assemble with `floorWei = 1 wei`, setting `ask ≈ 0`. After 24 h they (or an accomplice) buy the Statement for about nothing. Cancelling needs a CANCEL vote with zero NO, so the attacker's single card blocks it (R-3). The same key makes a below-floor LIST pass at 41 instead of 60. **Compromise, high floor:** `raiseAsk` pushes the ask out of reach, which blocks sales but does not steal. Members can recover with CANCEL plus a Fixed LIST, which needs the vote (see R-3). |
| The floor signer is live | Every LIST execution needs a fresh signature, **including Fixed prices** (R-5). Floor-relative default prices cannot assemble without one, so those parties expire. `raiseAsk` stops, which is harmless. |
| The Statement contract behaves as SCOPE.md §5.3 describes | Rejects contract callers: `assemble` reverts and parties expire (Credits safe). Restricts transfers: `buy` reverts forever and the Statement is stuck (no other exit). Moves Credits instead of burning them: the burn check passes because it only requires `ownerOf ≠ party`. Malicious `make`: it has operator rights over the party's Credits for the duration of the call. |
| Hosts publish sensible params | Default price is not checked against the floor. A depositor who did not read the default can see their Credit sold at it. This is the accepted SPEC model: "depositing accepts the defaults". |
| The Credits owner has no post-seal powers | Verified in source: `distribute` and `seal` revert once sealed, and there is no pause or admin burn. |

## 4. Known risks and accepted trade-offs

Severity is the preparer's estimate, for triage. Auditors should re-grade. Items marked **NEW** were found while preparing this package and are not reflected in SPEC.md.

| ID | Risk | Status |
|---|---|---|
| R-1 | **NEW. `MAX_PROPOSALS` exhaustion permanently freezes price governance.** `propose` reverts forever once a party has 256 proposals. The per-address limit (3 open) is Sybil-trivial: one card moved to a fresh address each block gives 3 proposals per block, because weight only has to exist at `block.number − 1`. One card holder can therefore reach 256 in about 86 blocks (about 17 minutes) for gas alone. After that no LIST or CANCEL can ever be proposed. Whatever ask exists is final, and if the party is still FULL, the default price goes live at assembly with no recourse. | Open. Suggested directions: count only proposals that are still open (or recycle ids), require a minimum snapshot weight or a deposit per proposal, or rate-limit per party rather than per address. Estimated Medium to High. |
| R-2 | **NEW. The deadlock counter is permanent and cheap to trip.** `blockedPriceProposals` never resets, counts any closed LIST with `no > 0` (even ones that never had 41 YES, and superseded ones), and anyone can call `countBlocked`. A holder with 2 cards in 2 addresses can open 3 proposals and vote NO from the other address. About 24 h later the party is in deadlock mode **forever**: zero-NO veto gone, 54 needed. Honest disagreement trips it too. Assembly does not reset the 30-day clock either (it runs from `fullAt`), unlike SPEC "30 days since FULL/assembly". | Open, a design-level difference from SPEC ("after 3 NO-blocked proposals of a kind"). Estimated Medium. |
| R-3 | **NEW. The single-NO veto on CANCEL, plus `BUY_DELAY == minimum window`, makes the 24 h pre-sale reaction window ineffective.** The shortest window is 24 h, and `execute` needs `now ≥ endsAt`. A CANCEL proposed in the same block as the ask goes live can execute no earlier than the exact second `buy` opens. Proposed any later, it always loses the race. One NO from any card holder (a buyer's accomplice) kills it before deadlock. In practice the default or voted price is final once live. | Open. SPEC §3 says "Buying opens 24 h after a price goes live, so card holders can react before a sale." Consider BUY_DELAY > the max window, or a pause-on-cancel-proposal. Estimated Medium. |
| R-4 | Floor signer compromise enables cheap sale of floor-relative parties (§3). Trust is concentrated in one immutable EOA shared by every party. The signature is not party-bound. | Accepted in SPEC ("the key can only ever raise an ask" is **not accurate** for the code: the floor also sets the price at assembly and execution, and the below-floor threshold). Mitigations to consider: a party address in the signed struct, a deviation bound vs the last accepted floor, a signer multisig or threshold, and ruling out floor-relative defaults for auto presets. |
| R-5 | **NEW.** `execute` of a Fixed LIST still calls `_floor()`, only to decide the 41/60 threshold, so a signer outage blocks all price governance. | Open. Estimated Low to Medium (liveness). |
| R-6 | **Floor cherry-picking.** Whoever calls `assemble`, `execute`, or `raiseAsk` picks any valid reading. An executor can pick a high reading to push a LIST below floor (60 needed), or a low one to keep it at 41; an assembler picks the lowest reading for a floor-relative default. | Mitigated (audit 3, finding 2): readings expire after 10 minutes (was 1 hour) and may never be older than the last one the party used; a floor-relative price needs a buy wait of at least 1 hour, so a stale-low ask can be raised by anyone before buying opens (the site should run that keeper). Residual: the threshold choice at `execute` still spans the readings of the last 10 minutes. Tests: unit/Findings3 `test_floor_*`, `test_floorRelative_*`. |
| R-7 | **Instant assembly for auto presets.** The depositor who fills slot 80 (any Credit owner) can assemble in the same transaction sequence. No LIST can be voted while FULL, and the default price goes live. Filling the last slots also locks everyone's Credits until the deadline (up to 60 days) for Manual parties with an absent host. | Accepted in SPEC §3 (one-step arrange + burn, defaults run automatically). Worth a UI warning. |
| R-8 | **Manual arrangement depended on the host being live.** | Fixed: the host's Manual burn window is 1 day after FULL (`MANUAL_GRACE`, time-unit scaled, shorter than `FILL_GRACE`); after that any card holder burns with the Time order. Tests: unit/ManualGrace. |
| R-9 | **Stray Credits sent directly are unrecoverable.** A Credit sent to a party with `transferFrom` (not `deposit`) is not recorded and has no exit path. `safeTransferFrom` is rejected by `onERC721Received`. The same holds for Credit Cards sent to a party: that card's 1/80 (or its Credit, after expiry) is stuck. | Accepted. User error. The docs should warn. |
| R-10 | **Thin Statement market.** Once the floor source switches to the Statement collection, one or two listings set it. The 24 h average (server-side), raise-only asks, and the 60/80 below-floor rule limit the damage, but R-4 and R-6 still apply. | Accepted (SPEC §13) |
| R-11 | **`MAX_PROPOSALS` bound (256) with a `_refreshOpen` scan.** `propose` loops over all prior proposals, so gas is bounded by 256 iterations. See R-1 for the liveness side. | Bound accepted. The liveness issue is open (R-1). |
| R-12 | **Assembly gas.** Worst-case trait preset measured at about 11.7M gas on a mainnet fork (80 `CreditArt.describe` calls, plus the permutation scan and burn), excluding the real Statement contract's `make`. Mainnet gas limit read 2026-09-24: 59,882,873. | Accepted, with headroom. Re-measure once the real `make` exists. |
| R-13 | **No exit after assembly.** With no buyer, the Statement stays in the party forever. Card holders keep only a claim on a future sale. | Accepted (SPEC §4: Statements cannot be split back into Credits) |
| R-14 | **Pull payouts.** `claim` can only be called by the card holder. A card held by a contract that cannot call `claim` (or cannot receive ETH) strands its share. SPEC's `claimFor` does not exist. The fee recipient must call `withdraw` on every party. | Accepted, with a documentation note |
| R-15 | **Preset coverage.** `printRank`, `weightRank`, and `eightsWeight` revert on values they don't know (eights > 5). If any sealed Credit hits those, parties using that preset and holding it can never assemble and will expire. | Needs an exhaustive off-chain sweep of all 122,154 ids (INVARIANTS I-35) |
| R-16 | **Unguarded entry points.** `propose`, `vote`, `countBlocked`, `raiseAsk`, and `transferHost` lack `nonReentrant`, so a malicious Statement contract could call them during `make`. It gains nothing it lacks already as a trusted party, but it widens the surface. | Accepted, given the trusted Statement contract |
| R-17 | **Random preset.** The seed is host-chosen and public, and the final order depends on deposit order, so a late depositor can predict where their Credit lands. | Accepted: presets are deterministic by design |
| R-18 | **Eligibility.** The `filters` string is informational. Only `eligibleRoot` is enforced, and it is computed off-chain. The rarity-rank filter uses OpenSea data. | Accepted (SPEC §3) |
| R-19 | **Static analysis.** Slither and Aderyn output is in `contracts/audit/static/`. Aderyn H-3 ("storage array edited with memory", Party L406/L457) is a false positive: the price spec is only read. Aderyn H-1/H-2 and Slither reentrancy items concern calls to trusted tokens under `nonReentrant`. Divide-before-multiply in `buy` is intentional (the remainder is sent to the fee recipient as dust). | For auditor confirmation |
| R-20 | **StatementMarket stale listings.** A listing cannot see transfers; if the token left the seller and came back, the old listing (old price) became buyable again forever. | Fixed (audit 3, finding 4): listings expire (`list` 30 days, `listFor` up to 180 days) and `cancelAll()` bumps a per-seller counter that voids every older listing. Residual: a round trip inside the listing's lifetime with no `cancelAll()` or re-list still revives it; the site should prompt sellers to re-list or `cancelAll()` after moving Statements. Tests: market/Market `test_staleListing_*`, `test_listFor_durationBounds`. |
| R-21 | **Royalty lookup.** | Removed: no creator royalty is paid and `royaltyInfo` is never called (Party and StatementMarket), so a malformed, reverting or gas-hungry royalty implementation cannot affect a sale. `Sold.royalty` is kept and always 0. |

## 5. Earlier reviews

No written audit report exists in the repository, and **the Solidity contracts have not had an external review.** Two internal review passes happened, and their conclusions are in SPEC.md and the commit history.

### 5.1 Design review (SPEC v0.2 → v0.8, commits `16849a7`, `6bde567`, `89ed59e`, `d298c34`, `342668f`, `b59d9cb`, `b267b19`)
| Issue raised | Resolution now in SPEC / code |
|---|---|
| Dust veto: an ERC-20 share of 1 wei could cast a blocking NO | Shares became ERC-721 Credit Cards, which are whole units ("Dust veto: impossible") |
| Permanent deadlock: one holder blocks every sale forever | Deadlock escape: 54/80 with NO ignored, after 3 blocked proposals or 30 days (see R-2 for how the code implements it) |
| Buy-vote-sell and flash-loan voting | Snapshot weight at the block before proposal creation |
| Floor manipulation (list a cheap Statement to drag the ask down, then buy) | 24 h average floor, asks that only ratchet up, below-floor LIST needs 60/80 |
| Predatory lowball offers on thin parties | Asks only. No offers, auctions, or marketplace listings, and no code path for them. |
| Royalty lookup draining a sale | No royalty leg: `royaltyInfo` is never called |
| Keeper or floor-key abuse | Key can only raise the ask (partly true in code; see R-4) |
| Statement contract may reject contract callers | Credits are never burned before assembly, and parties expire with Credits returned |
| Arranger stall and extra votes | Host-only arranger, one-step arrange + burn, auto presets verified on-chain |

### 5.2 Code review of the site prototype (commits `3b3369b`, `e7156b0`)
This covered `server.mjs` and the web app, not the Solidity contracts. Fixes: 64 KB JSON-only bodies, input schemas, dev clock off in production, arrangement only through `/arrange`, status checks per proposal type, superseding stale proposals, nominee validation, per-member quotas, frozen snapshots, atomic state writes, security headers, localhost bind, generic 500s, an anvil bytecode check, EIP-4361 sign-in with session cookies and an origin check, and on-chain `ownerOf` at deposit. The contracts later adopted some of these rules (superseding, per-member quota, frozen snapshots).

## 6. Questions for auditors

1. R-1 to R-3 and R-5: are the governance liveness and veto issues exploitable as described, and what is the minimal fix that keeps the SPEC's "one NO blocks" property?
2. Can `CreditCards` checkpoints be desynchronized, for example through transfers to self or batch transfers in one block?
3. Is any path left where a Credit or the Statement leaves the party other than `_redeem`, `assemble`, or `buy`?
4. Once the real Statement ABI is known: is an adapter needed, and does the burn verification in `assemble` still hold?
5. Is the ETH accounting in `buy`, `claim`, and `withdraw` sound against every receiver behavior (reverting, re-entering, gas griefing)?
