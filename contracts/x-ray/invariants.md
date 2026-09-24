# Invariant Map

> Statement Maker | 99 guards | 47 inferred (34 single-contract, 8 cross-contract, 5 economic) | 7 not enforced on-chain

Code reference: `contracts/src/` at `d548e55` (`main`). Line numbers refer to that commit.

---

## 1. Enforced Guards (Reference)

Per-call preconditions. Heading IDs below (`G-N`) are anchor targets from x-ray.md attack surfaces.

### Party.sol

#### G-1
`if (timeUnit == 0 || timeUnit > 1 hours) revert Bad("timeUnit")` · `Party.sol:172` · Rule windows can only be shortened (testnet), never stretched past real hours; a zero unit would collapse every window.

#### G-2
`if (host_ == address(0)) revert Bad("host")` · `Party.sol:173` · The Manual burn gate needs a real host address.

#### G-3
`if (p.minDeposit == 0 || p.minDeposit > SLOTS) revert Bad("minDeposit")` · `Party.sol:174` · Keeps the per-deposit minimum reachable inside 80 slots.

#### G-4
`if (p.durationDays == 0 || p.durationDays > 60) revert Bad("duration")` · `Party.sol:175` · Bounds how long Credits can sit locked before expiry frees them.

#### G-5
`if (!_windowOk(p.voteHours)) revert Bad("voteHours")` · `Party.sol:176` · Default window must be one of 1/24/48/72/168 h.

#### G-6
`_checkPrice(p.defaultPrice)` · `Party.sol:177` · Default price must be in range before it can go live at the burn.

#### G-7
`if (p.defaultPrice.mode != PriceMode.Fixed && p.minAskWei == 0) revert Bad("minAsk")` · `Party.sol:178` · A floor-relative default needs a positive floor for the ask (clamp target).

#### G-8
`if (!_delayOk(p.defaultPrice.mode, p.buyDelayHours)) revert Bad("buyDelay")` · `Party.sol:179` · Default buy wait ≤ 72 h, ≥ 1 h for floor-relative prices (room for raiseAsk).

#### G-9
`if (bytes(p.name).length == 0 || bytes(p.name).length > 60) revert Bad("name")` · `Party.sol:180` · Bounds host-supplied display text rendered in card metadata.

#### G-10
`if (bytes(p.description).length > 1000) revert Bad("description")` · `Party.sol:181` · Bounds stored host text.

#### G-11
`if (msg.sender != address(factory)) revert Bad("factory only")` · `Party.sol:215` · Only the factory, which moves Credits from its own caller, may record deposits and mint cards.

#### G-12
`if (status() != Status.OPEN) revert Bad("not open")` · `Party.sol:216` · No deposits after FULL, burn, sale or expiry.

#### G-13
`if (ids.length < min || ids.length > remaining || ids.length == 0) revert Bad("count")` · `Party.sol:219` · Enforces the minimum deposit and the 80-slot cap (lifted in I-5).

#### G-14
`if (_params.eligibleRoot != bytes32(0) && proofs.length != ids.length) revert Bad("proofs")` · `Party.sol:220` · One proof per Credit when eligibility is restricted.

#### G-15
`if (cardOfCredit[id] != 0) revert Bad("duplicate")` · `Party.sol:223` · One card per Credit; keeps the credit↔card map a bijection.

#### G-16
`if (!MerkleProof.verifyCalldata(proofs[i], _params.eligibleRoot, leaf)) revert Bad("not eligible")` · `Party.sol:226` · Host eligibility filter is enforced on-chain through the Merkle root only.

#### G-17
`if (credits.ownerOf(id) != address(this)) revert Bad("not received")` · `Party.sol:228` · A card is minted only for a Credit the party actually holds.

#### G-18
`if (status() != Status.EXPIRED) revert Bad("not expired")` · `Party.sol:251` · Third-party redemption pushes only after expiry.

#### G-19
`if (s != Status.OPEN && s != Status.EXPIRED) revert Bad("locked")` · `Party.sol:257` · Credits are locked from FULL on, so the 80 cannot shrink before the burn.

#### G-20
`if (cards.partyOf(cardId) != address(this) || cards.ownerOf(cardId) != holder) revert Bad("not holder")` · `Party.sol:258` · The Credit goes only to the current holder of this party's card.

#### G-21
`revert Bad("missing")` · `Party.sol:278` · `_order` must contain the redeemed id (internal consistency of I-4).

#### G-22
`if (status() != Status.FULL) revert Bad("not full")` · `Party.sol:287` · The burn happens exactly once, from FULL, before the deadline.

#### G-23
`if (msg.sender != host) revert Bad("host only")` · `Party.sol:290` · Manual order is the host's for MANUAL_GRACE after FULL.

#### G-24
`if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only")` · `Party.sol:293` · Auto-preset / post-grace burns need a current card holder.

#### G-25
`if (st.ownerOf(sid) != address(this)) revert Bad("statement not received")` · `Party.sol:338` · The party must actually receive the Statement it burned for.

#### G-26
`try credits.ownerOf(order[i]) returns (address) { revert Bad("not burned"); } catch (bytes memory r) { if (bytes4(r) != 0x7e273289) revert Bad("not burned"); }` · `Party.sol:342-343` · Every one of the 80 Credits must be destroyed; a Statement contract that keeps or moves them is refused.

#### G-27
`if (floor.sig.length == 0) revert Bad("floor needed")` · `Party.sol:363` · A passed LIST that cannot be judged without a reading forces the burn caller to supply one, so omitting the floor cannot skip a passed price.

#### G-28
`if (!_assembling || msg.sender != address(factory.statement())) revert Bad("unexpected token")` · `Party.sol:378` · Only the Statement mint during `assemble` may safe-transfer an NFT in.

#### G-29
`if (cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status")` · `Party.sol:387` · LIST from FULL on; CANCEL only once a Statement exists.

#### G-30
`if (cancel && ask == 0) revert Bad("not listed")` · `Party.sol:388` · Cancels need a live ask.

#### G-31
`if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only")` · `Party.sol:389` · Only current card holders propose.

#### G-32
`if (block.number <= fullBlock) revert Bad("just filled")` · `Party.sol:391` · Snapshot (block − 1) always includes the last depositors' cards (Pashov L4).

#### G-33
`if (_openIds[msg.sender].length >= MAX_OPEN_PER_PROPOSER) revert Bad("open limit")` · `Party.sol:393` · Caps concurrently open proposals per address (not total proposals; see I-12).

#### G-34
`if (!cancel && price.mode != PriceMode.Fixed && _params.minAskWei == 0) revert Bad("minAsk")` · `Party.sol:396` · Floor-relative LISTs need the host's minimum ask as a lower bound.

#### G-35
`if (!cancel && !_delayOk(price.mode, buyDelayHours)) revert Bad("buyDelay")` · `Party.sol:397` · Each LIST's buy wait ≤ 72 h, ≥ 1 h if floor-relative.

#### G-36
`if (!_windowOk(h)) revert Bad("window")` · `Party.sol:399` · Proposal windows limited to 1/24/48/72/168 h; cancels fixed at 24 h.

#### G-37
`if (block.timestamp >= p.endsAt) revert Bad("closed")` · `Party.sol:418` · Votes only inside the window.

#### G-38
`if (w == 0) revert Bad("no weight at snapshot")` · `Party.sol:422` · Only holders at the snapshot block vote (flash/buy-vote-sell resistance).

#### G-39
`if (p.executed) revert Bad("executed")` · `Party.sol:443` · A proposal executes once.

#### G-40
`if (block.timestamp < p.endsAt) revert Bad("voting open")` · `Party.sol:444` · A late NO can still kill a proposal until the window closes.

#### G-41
`if (block.timestamp > uint256(p.endsAt) + _t(EXECUTE_WINDOW)) revert Bad("lapsed")` · `Party.sol:445` · Passed proposals lapse after 7 days.

#### G-42
`if (p.epoch != priceEpoch) revert Bad("superseded")` · `Party.sol:446` · Any executed price decision (or the burn) kills older proposals.

#### G-43
`if (cards.heldNow(address(this), msg.sender) == 0) revert Bad("card holders only")` · `Party.sol:447` · Execution (and floor choice) restricted to current card holders.

#### G-44
`if (p.cancel ? s != Status.ASSEMBLED : (s != Status.FULL && s != Status.ASSEMBLED)) revert Bad("status")` · `Party.sol:448` · Same status rule at execution as at proposal.

#### G-45
`if (p.yes < need || (p.no > 0 && !p.deadlock)) revert Bad("did not pass")` · `Party.sol:455` · Pass rule: 41 / 60 below floor / ≥ 54 in deadlock; any NO blocks unless created in deadlock.

#### G-46
`if (blockedCounted[id] || p.cancel || p.executed || block.timestamp < p.endsAt || p.no == 0 || p.deadlock || p.yes < PASS || p.epoch != priceEpoch) revert Bad("not blocked")` · `Party.sol:484` · Only closed, current-epoch LISTs with ≥ 41 YES stopped by NO feed the deadlock counter, once each.

#### G-47
`if (status() != Status.ASSEMBLED || ask == 0 || askSpec.mode == PriceMode.Fixed) revert Bad("fixed")` · `Party.sol:508` · raiseAsk only moves live floor-relative asks.

#### G-48
`if (next <= ask) revert Bad("not higher")` · `Party.sol:510` · Keeper path can only raise the ask (lifted in I-7).

#### G-49
`if (status() != Status.ASSEMBLED || ask == 0) revert Bad("not for sale")` · `Party.sol:519` · Sale only from ASSEMBLED with a live ask.

#### G-50
`if (block.timestamp < buyableAt) revert Bad("not open yet")` · `Party.sol:520` · Buy wait gives holders time to react / raise.

#### G-51
`if (price > maxPrice || msg.value < price) revert Bad("price")` · `Party.sol:522` · Buyer slippage guard against a same-block raise.

#### G-52
`if (!ok) revert Bad("refund")` · `Party.sol:537` · Excess ETH is returned or the sale reverts.

#### G-53
`if (!sold) revert Bad("not sold")` · `Party.sol:544` · Claims only after the sale sets `perCard`.

#### G-54
`if (cards.partyOf(c) != address(this) || cards.ownerOf(c) != msg.sender) revert Bad("not holder")` · `Party.sol:548` · Each share is paid once to the card's holder (card burned).

#### G-55
`if (!ok) revert Bad("send")` · `Party.sol:556` · Self-claim reverts rather than losing the batch.

#### G-56
`if (!sold) revert Bad("not sold")` · `Party.sol:562` · Push payouts only after the sale.

#### G-57
`if (cards.partyOf(c) != address(this)) revert Bad("not this party")` · `Party.sol:565` · claimFor cannot burn another party's cards.

#### G-58
`if (amt == 0) revert Bad("nothing")` · `Party.sol:579` · Pull payment requires a balance.

#### G-59
`if (!ok) revert Bad("send")` · `Party.sol:582` · Failed pull reverts (balance restored).

#### G-60
`if (msg.sender != host || to == address(0)) revert Bad("host")` · `Party.sol:587` · Host seat moves only by the host, never to zero.

#### G-61
`if (p.mode == PriceMode.Fixed && (p.value <= 0 || p.value > 1e24)) …; FloorPct (p.value <= -10_000 || p.value > 1_000_000); FloorDelta (p.value < -1e24 || p.value > 1e24)` · `Party.sol:595-597` · Keeps prices positive (Fixed), percentage > −100 %, and all int math in range.

#### G-62
`if (f.issuedAt > block.timestamp || block.timestamp - f.issuedAt > FLOOR_MAX_AGE) revert Bad("stale floor")` · `Party.sol:601` · Readings valid for 10 real minutes.

#### G-63
`if (f.issuedAt < lastFloorAt) revert Bad("older floor")` · `Party.sol:602` · No going back to an older reading in this party.

#### G-64
`if (!factory.isValidFloor(f.floorWei, uint8(_params.floorMode), f.issuedAt, f.sig)) revert Bad("floor sig")` · `Party.sol:604` · Only the factory's floor signer, for this party's floor mode.

#### G-65
`if (f.floorWei == 0 || f.floorWei > 1e30) revert Bad("floor")` · `Party.sol:605` · Keeps int256 casts and FloorPct math in range (Halmos counterexample fix).

#### G-66
`receive() external payable { revert Bad("no direct ETH"); }` · `Party.sol:643-645` · ETH enters only through `buy` (I-3).

### CreditKeys.sol

#### G-67
`if (order.length != n) revert Bad("length")` · `CreditKeys.sol:51` · The burn order has exactly as many ids as deposits.

#### G-68
`for (...) if (order[i] != deposited[i]) revert Bad("order")` · `CreditKeys.sol:53` · Deposit preset = stored order exactly.

#### G-69
`for (...) if (order[i] != want[i]) revert Bad("order")` · `CreditKeys.sol:58` · Random preset = seeded shuffle of the stored order.

#### G-70
`for (...) if (cardOf[order[i]] == 0) revert Bad("not deposited")` · `CreditKeys.sol:61` · Every id in a sorted/Manual order is one of this party's deposits.

#### G-71
`if (seen != 0) revert Bad("repeat")` · `CreditKeys.sol:67` · Manual orders have no duplicate (transient marks) → a permutation.

#### G-72
`for (uint256 i = 1; i < n; ++i) if (order[i] <= order[i - 1]) revert Bad("order")` · `CreditKeys.sol:77` · Number/Time: strictly ascending ids (distinct → permutation).

#### G-73
`for (uint256 i = 1; i < n; ++i) if (k[i] <= k[i - 1]) revert Bad("order")` · `CreditKeys.sol:81` · Trait presets: strictly ascending CreditTraits keys.

#### G-74
`if (id >= 2 ** ID_BITS) revert Bad("id")` · `CreditKeys.sol:87` · Id fits in the key's low 32 bits so keys stay unique.

### CreditTraits.sol

#### G-75
`if (n == 0 || n > MAX_CHUNKS || count_ == 0 || (count_ + IDS_PER_CHUNK - 1) / IDS_PER_CHUNK != n) revert Bad("chunks")` · `CreditTraits.sol:43` · Chunk count matches the id count.

#### G-76
`if (chunks[i].code.length != want) revert Bad("chunk size")` · `CreditTraits.sol:47` · Each data contract is exactly 1 + 3 × ids bytes (content is NOT checked; see X-5).

#### G-77
`if (i >= chunkCount) revert Bad("chunk")` · `CreditTraits.sol:70` · Verifier view stays in range.

#### G-78
`if (id == 0 || id > count) revert Bad("id")` · `CreditTraits.sol:76` · Reads only committed ids.

### CreditCards.sol

#### G-79
`if (msg.sender != factory) revert NotFactory()` · `CreditCards.sol:43` · Only the factory registers parties (card minters).

#### G-80
`if (!isParty[msg.sender]) revert NotParty()` · `CreditCards.sol:49` · Only registered parties mint.

#### G-81
`if (partyOf[id] != msg.sender) revert NotParty()` · `CreditCards.sol:57` · Only a card's own party burns it.

#### G-82
`if (blockNumber >= block.number) revert FutureLookup()` · `CreditCards.sol:63` · Snapshot weights only from completed blocks.

### PartyFactory.sol / TestnetPartyFactory.sol

#### G-83
`require(address(credits_) != address(0) && ... && address(traits_).code.length > 0, "zero")` · `PartyFactory.sol:33` · Immutable dependencies set once; traits must be a contract (not verified further).

#### G-84
`require(isParty[address(party)], "not a party")` · `PartyFactory.sol:59` · The factory moves Credits only into its own clones.

#### G-85
`require(block.chainid != 1, "testnet only")` · `TestnetPartyFactory.sol:17` · Short clocks cannot ship to mainnet.

#### G-86
`require(unit > 0 && unit <= 1 hours, "unit")` · `TestnetPartyFactory.sol:18` · Mirrors G-1 at the source.

### StatementMarket.sol

#### G-87
`if (address(statement_) == address(0) || feeRecipient_ == address(0)) revert Bad("zero")` · `StatementMarket.sol:55` · Immutable token and fee target.

#### G-88
`if (duration == 0 || duration > MAX_DURATION) revert Bad("duration")` · `StatementMarket.sol:67` · Listings live ≤ 180 days.

#### G-89
`if (price == 0) revert Bad("price")` · `StatementMarket.sol:72` · No zero-price listing.

#### G-90
`if (statement.ownerOf(tokenId) != msg.sender) revert Bad("not owner")` · `StatementMarket.sol:73` · Only the current owner lists.

#### G-91
`if (!_approved(msg.sender, tokenId)) revert Bad("approve the market first")` · `StatementMarket.sol:74` · A listing is only created when it can settle.

#### G-92
`if (l.seller == address(0)) revert Bad("not listed")` · `StatementMarket.sol:89` · Cancel needs a listing.

#### G-93
`try statement.ownerOf(tokenId) returns (address o) { if (o == l.seller) revert Bad("not seller"); } catch {}` · `StatementMarket.sol:92` · Third parties may clear only dead listings.

#### G-94
`if (l.seller == address(0) || !isLive(tokenId)) revert Bad("not for sale")` · `StatementMarket.sol:109` · Owner, approval, expiry and nonce all re-checked at sale.

#### G-95
`if (price > maxPrice || msg.value < price) revert Bad("price")` · `StatementMarket.sol:111` · Buyer protection against a re-price landing first.

#### G-96
`if (msg.sender == l.seller) revert Bad("own listing")` · `StatementMarket.sol:112` · No self-trade fee churn.

#### G-97
`if (!r) revert Bad("refund")` · `StatementMarket.sol:125` · Excess ETH returned or the sale reverts.

#### G-98
`if (amt == 0) revert Bad("nothing")` · `StatementMarket.sol:132` · Pull payment requires a balance.

#### G-99
`if (!ok) revert Bad("send")` · `StatementMarket.sol:135` · Failed pull reverts.

---

## 2. Inferred Invariants (Single-Contract)

Inferred invariants are derived from structural analysis of the source code. Each block below cites one of five extraction methods in its `Derivation` field:

- **Δ-pair (delta-pair) analysis** — two or more storage variables in the same function body that change by equal-and-opposite amounts, implying a conservation law.
- **Guard lift** — a `require` / `if-revert` on a storage variable, promoted to a global property by checking every write site. Any unguarded write site → On-chain=**No**.
- **State-machine edge** — `require(state == A); state = B` with no reverse path.
- **Temporal predicate** — a check tied to `block.timestamp` / `block.number` and a stored deadline.
- **NatSpec-stated global property** — a developer-asserted invariant, then confirmed or contradicted by the structural scan.

Each block is classified into one of five **categories**: `Conservation` · `Bound` · `Ratio` · `StateMachine` · `Temporal`.

---

#### I-1

`Conservation` · On-chain: **Yes**

> `fee + dust + SLOTS × perCard == price` for the one sale of a party.

**Derivation** — Δ-pair: `Party.sol:524-527` (fee, pot, share, dust from `price`) ↔ `Party.sol:530,532` (`perCard = share`, `owed[feeRecipient] += fee + dust`). No royalty term since f06b3c5.

**If violated** — Card holders or fee recipient are under/over-paid; ETH stranded or overdrawn.

---

#### I-2

`Conservation` · On-chain: **Yes**

> After SOLD: `address(this).balance ≥ Σ owed[·] + perCard × cardsOutstanding`.

**Derivation** — Δ-pair: `buy` `Party.sol:529-532` (+price in, owed += fee+dust, all 80 cards outstanding) ↔ `claim` `Party.sol:550-555` (−perCard per burned card, `--cardsOutstanding`) ↔ `claimFor` `Party.sol:568-572` (`--cardsOutstanding`, pay or `owed[holder] += perCard`) ↔ `withdraw` `Party.sol:580-581` (`owed = 0`, −amt).

**If violated** — Late claimers or the fee recipient cannot be paid.

---

#### I-3

`Conservation` · On-chain: **Yes**

> The only ETH that enters a party is `buy`'s `msg.value` (minus refund); nothing reads `address(this).balance`.

**Derivation** — Δ-pair (negative): `receive` reverts `Party.sol:643-645`; `buy` is the only `payable` function (`Party.sol:518`). Forced ETH (selfdestruct) is possible and unread.

**If violated** — Accounting that assumed zero pre-sale balance would drift.

---

#### I-4

`Conservation` · On-chain: **Yes**

> Before SOLD: `_order.length == cardsOutstanding`.

**Derivation** — Δ-pair: `onDeposit` `Party.sol:232-233` (`_order.push`, `++cardsOutstanding`) ↔ `_redeem` `Party.sol:262-263` (`_removeFromOrder`, `--cardsOutstanding`). Post-sale `claim`/`claimFor` decrement only `cardsOutstanding` (by design; `_order` is frozen after the burn).

**If violated** — Status (`_order.length == SLOTS` → FULL) and the card count disagree.

---

#### I-5

`Bound` · On-chain: **Yes**

> `_order.length ≤ SLOTS (80)` at all times.

**Derivation** — guard-lift: `if (ids.length < min || ids.length > remaining || ids.length == 0)` `Party.sol:219` with `remaining = SLOTS - _order.length`; write sites of `_order`: push `Party.sol:232` (only inside `onDeposit` after G-13), shift/pop `Party.sol:273-274` (shrinks).

**If violated** — Burn order length check (G-67) and the 1/80 share math break.

---

#### I-6

`Bound` · On-chain: **Yes**

> Whenever ASSEMBLED and listed, `ask > 0`; a floor-relative ask is `≥ minAskWei > 0`.

**Derivation** — guard-lift: `_checkPrice` `Party.sol:595` (Fixed `value > 0`) applied at `Party.sol:177,394`; `minAskWei > 0` required for floor-relative at `Party.sol:178,396`; `_clampMin` `Party.sol:623-625`. Write sites of `ask`: `Party.sol:325` (burn, resolved price), `Party.sol:470` (execute), `Party.sol:511` (raise, `> ask`), `Party.sol:462,531` (explicit 0 on CANCEL / sale).

**If violated** — A zero ask would make the Statement unsellable or sellable for dust.

---

#### I-7

`Bound` · On-chain: **Yes**

> Between votes the ask only rises: every decrease comes from an executed proposal or the sale.

**Derivation** — guard-lift: `if (next <= ask) revert Bad("not higher")` `Party.sol:510`; write sites of `ask`: `Party.sol:325` (burn), `Party.sol:462,470` (execute), `Party.sol:511` (raiseAsk, guarded), `Party.sol:531` (sale).

**If violated** — A keeper/floor path could undersell the Statement.

---

#### I-8

`Bound` · On-chain: **Yes**

> `buyableAt − askLiveAt ∈ [0, 72 h]`, and `≥ 1 h` when the live spec is floor-relative.

**Derivation** — guard-lift: `_delayOk` `Party.sol:634-636` enforced at `Party.sol:179` (default) and `Party.sol:397` (every LIST, stored in `Proposal.buyDelayHours`); write sites of `buyableAt`: `Party.sol:328` (burn: wait from the candidate / `_pendingBuyDelay` / default, floored to 1) and `Party.sol:473` (execute: `p.buyDelayHours`). `raiseAsk` changes neither `askLiveAt` nor `buyableAt`.

**If violated** — A stale-low floor-relative ask could be bought before anyone can raise it.

---

#### I-9

`Temporal` · On-chain: **Yes**

> Every price that goes live at the burn waits at least 1 h before buying opens.

**Derivation** — temporal: `if (wait == 0) wait = 1;` `Party.sol:319` then `buyableAt = uint64(block.timestamp + _t(wait * 1 hours))` `Party.sol:328` (Pashov H2).

**If violated** — Holders get no window to CANCEL or raise a price that went live at the burn.

---

#### I-10

`Bound` · On-chain: **Yes**

> `lastFloorAt` never decreases; a party never accepts a reading older than one it already used (and none older than 10 real minutes).

**Derivation** — guard-lift: `if (f.issuedAt < lastFloorAt) revert` `Party.sol:602` + age check `Party.sol:601`; sole write site `lastFloorAt = f.issuedAt` `Party.sol:603`. Called from `_judgePrice` (burn scan, execute), `_resolve` (burn default/pending, raiseAsk).

**If violated** — A caller could reuse an old favorable reading.

---

#### I-11

`Bound` · On-chain: **Yes**

> Each address has at most 3 open (not yet closed) proposals per party.

**Derivation** — guard-lift: `if (_openIds[msg.sender].length >= MAX_OPEN_PER_PROPOSER) revert` `Party.sol:393` after `_refreshOpen` `Party.sol:496-502`; write sites of `_openIds`: push `Party.sol:407` (after the guard), swap-pop `Party.sol:500`.

**If violated** — One holder could flood the proposal list.

---

#### I-12

`Bound` · On-chain: **No**

> The number of current-epoch proposals the burn scans is bounded.

**Derivation** — guard-lift: the only limit on proposal creation is the per-proposer open cap `Party.sol:393`; sole write site of `_proposals` is `push` `Party.sol:402` with no total or per-epoch cap. `_passedUnexecuted` `Party.sol:356-364` walks back from the newest proposal until the first older epoch; closed proposals of the current epoch accumulate while no price executes (1-hour windows allowed, `Party.sol:639`).

**If violated** — Burn gas grows with proposal history of the FULL phase, on top of the ~5M-gas burn and the unknown real `make`.

---

#### I-13

`StateMachine` · On-chain: **Yes**

> `assembled` goes false → true exactly once; `burnOrderHash`, `statementId`, `assembledAt` are written only then.

**Derivation** — edge: `status() == FULL` @`Party.sol:287` → `assembled = true` @`Party.sol:322`; `burnOrderHash` @`Party.sol:324`, `statementId` @`Party.sol:345`. No write resets `assembled`.

**If violated** — A second burn or a reverted status.

---

#### I-14

`StateMachine` · On-chain: **Yes**

> `sold` goes false → true exactly once; `perCard` is fixed at that moment.

**Derivation** — edge: `status() == ASSEMBLED && ask != 0` @`Party.sol:519` → `sold = true` @`Party.sol:529`, `perCard = share` @`Party.sol:530`. No other writes.

**If violated** — Double sale or a moving share.

---

#### I-15

`StateMachine` · On-chain: **Yes**

> A proposal is executed at most once, by `execute` or by being applied at the burn.

**Derivation** — edge: `if (p.executed) revert` @`Party.sol:443` → `p.executed = true` @`Party.sol:457`; burn scan skips `q.executed` @`Party.sol:359` → `q.executed = true` @`Party.sol:306`.

**If violated** — A price could be applied twice / resurrected.

---

#### I-16

`StateMachine` · On-chain: **Yes**

> `priceEpoch` strictly increases; a proposal is usable (execute, burn-apply, countBlocked) only in its own epoch.

**Derivation** — edge: `++priceEpoch` @`Party.sol:329` (burn) and @`Party.sol:458` (execute); checks `Party.sol:358` (scan break), `Party.sol:446`, `Party.sol:484`.

**If violated** — Superseded proposals could execute after a newer decision.

---

#### I-17

`StateMachine` · On-chain: **Yes**

> `blockedPriceProposals` is a cyclic counter: incremented by `countBlocked`, reset to 0 when a price executes or the burn applies a passed LIST; not reset when the burn applies the pending/default price.

**Derivation** — edge: `++blockedPriceProposals` @`Party.sol:486` (guarded by G-46); resets @`Party.sol:460` (execute) and @`Party.sol:308` (burn, only in the `voted` branch). No reset in the `else` branch `Party.sol:313-318`.

**If violated** — Deadlock mode entered/exited contrary to the documented rule.

---

#### I-18

`Temporal` · On-chain: **Yes**

> `deadline` never decreases; filling slot 80 leaves at least `FILL_GRACE` (2 days) to burn.

**Derivation** — temporal: write sites `deadline = createdAt + durationDays` @`Party.sol:185`; `if (deadline < grace) deadline = uint64(grace)` @`Party.sol:240`.

**If violated** — A party could expire in the block it filled.

---

#### I-19

`Temporal` · On-chain: **Yes**

> A proposal takes effect only in `[endsAt, endsAt + 7 days]`, both via `execute` and via the burn scan.

**Derivation** — temporal: `if (block.timestamp < p.endsAt)` / `> endsAt + _t(EXECUTE_WINDOW)` @`Party.sol:444-445`; identical filter in the scan @`Party.sol:359`.

**If violated** — Open or lapsed proposals could set prices.

---

#### I-20

`Temporal` · On-chain: **Yes**

> Every proposal's snapshot block is ≥ `fullBlock`, so all 80 cards carry weight.

**Derivation** — temporal: `if (block.number <= fullBlock) revert Bad("just filled")` @`Party.sol:391`; `snapshot: uint48(block.number - 1)` @`Party.sol:403`; `fullBlock` written once @`Party.sol:238` (Pashov L4).

**If violated** — Last depositors' cards would count zero on early proposals.

---

#### I-21

`Temporal` · On-chain: **Yes**

> Manual preset: only the host may burn until `fullAt + MANUAL_GRACE`; afterwards any card holder, Time order only.

**Derivation** — temporal: `if (p == Manual && block.timestamp <= fullAt + _t(MANUAL_GRACE))` @`Party.sol:289-290`; else branch forces `p = Time` @`Party.sol:292`.

**If violated** — A host could stall the burn or others could impose a Manual order.

---

#### I-22

`Temporal` · On-chain: **Yes**

> The 30-day deadlock clock runs from `lastPriceExecutedAt`, else `assembledAt`, else `fullAt`; a price executed while FULL keeps anchoring the clock after a burn that applied the pending/default price.

**Derivation** — temporal: `since = lastPriceExecutedAt != 0 ? … : (assembledAt != 0 ? … : fullAt …)` and `block.timestamp > since + _t(DEADLOCK_TIME)` @`Party.sol:492-493`; `lastPriceExecutedAt` written @`Party.sol:307,459` only.

**If violated** — Deadlock (54, NO ignored) reached earlier or later than SPEC §4 ("30 days since FULL/assembly") (per spec).

---

#### I-23

`Bound` · On-chain: **No**

> Time preset order == payment-time ascending (ties by id) == ascending id.

**Derivation** — NatSpec: `CreditKeys.sol:11-12` — *"Time: the sealed collection's payment times never decrease with id (verified over all 122,154 Credits, test/keytable), so payment-time order with id tie-break is exactly ascending id."* Structural scan: `verifyOrder` checks only `order[i] > order[i-1]` for Time @`CreditKeys.sol:76-78`; no payment time is read on-chain.

**If violated** — Time order (the default preset and the Manual fallback) would differ from its documented meaning.

---

#### I-24

`Bound` · On-chain: **Yes**

> The art contract is never called at a burn.

**Derivation** — NatSpec: `CreditKeys.sol:10` — *"the art contract is never called at a burn"*. Structural scan: no `ICreditArt`, `describe`, `art()`, `seedOf` or `timestampOf` call in `src/*.sol` (grep); trait presets call only `ICreditTraits.keys` @`CreditKeys.sol:80`.

**If violated** — Burn gas and liveness would depend on the art contract again.

---

#### I-25

`Bound` · On-chain: **Yes**

> The CreditTraits table is immutable: no owner, admin or upgrade; `tableHash` pins the chunk code.

**Derivation** — NatSpec: `CreditTraits.sol:14-15` — *"`tableHash` pins the exact chunk code; the deploy script refuses a table that differs from the committed one. No owner, no admin, no upgrade path."* Structural: all state is `immutable` (`CreditTraits.sol:20-37`); `tableHash = keccak256(abi.encodePacked(codehashes))` @`CreditTraits.sol:50`. The comparison against the committed table happens in `script/DeployMainnet.s.sol:34`, not on-chain.

**If violated** — Sort keys could change after parties are created.

---

#### I-26

`Bound` · On-chain: **Yes**

> `minAskWei` never bounds a Fixed price.

**Derivation** — NatSpec: `Party.sol:79-80` — *"It never bounds a Fixed price: 41 (60 below the floor) can still vote any fixed price."* Structural: `_resolve` returns `uint256(p.value)` for Fixed @`Party.sol:610`; `_judgePrice` @`Party.sol:371,373` clamps only floor-relative.

**If violated** — n/a (documented design; listed so auditors do not treat it as a bug).

---

#### I-27

`Conservation` · On-chain: **Yes**

> For each party, `Σ_account heldNow(party, account)` equals the number of that party's live cards.

**Derivation** — Δ-pair: `CreditCards._update` `CreditCards.sol:76-77` (`_held[party][from] −1`) ↔ `CreditCards.sol:80-81` (`_held[party][to] +1`), mint (`from == 0`) and burn (`to == 0`) apply one side.

**If violated** — Vote weights and `heldNow` gates diverge from ownership.

---

#### I-28

`Bound` · On-chain: **Yes**

> A card's party is fixed at mint.

**Derivation** — guard-lift: sole write site `partyOf[id] = msg.sender` @`CreditCards.sol:51` inside `mint` (G-80).

**If violated** — A card could vote/claim in another party.

---

#### I-29

`StateMachine` · On-chain: **Yes**

> Card ids are unique and strictly increasing (`nextId` starts at 1, never reused).

**Derivation** — edge: `id = nextId++` @`CreditCards.sol:50`; no other write.

**If violated** — `creditOfCard` / `partyOf` collisions.

---

#### I-30

`Conservation` · On-chain: **Yes**

> StatementMarket: `address(this).balance ≥ Σ owed[·]` (equality absent forced ETH).

**Derivation** — Δ-pair: `buy` `StatementMarket.sol:118,121-122,124` (fee and any failed seller push retained as `owed`, rest forwarded/refunded) ↔ `withdraw` `StatementMarket.sol:133-134`; `receive` reverts `StatementMarket.sol:144-146`.

**If violated** — Fee recipient or sellers cannot withdraw.

---

#### I-31

`Temporal` · On-chain: **Yes**

> A listing is buyable only while `now < expiresAt ≤ listedAt + 180 days`.

**Derivation** — temporal: `duration` bound @`StatementMarket.sol:67`; `exp = block.timestamp + duration` @`StatementMarket.sol:75`; `block.timestamp >= l.expiresAt` → not live @`StatementMarket.sol:102`.

**If violated** — Old listings could revive indefinitely.

---

#### I-32

`StateMachine` · On-chain: **No**

> A listing void because the seller no longer owns the token stays void.

**Derivation** — NatSpec: `StatementMarket.sol:15-16` — *"a listing is void as soon as the seller no longer owns the token"*, contradicted by `StatementMarket.sol:17-21` and `isLive` @`StatementMarket.sol:100-104` (liveness recomputed from current ownership; revives on re-acquire within expiry unless `cancelAll`).

**If violated** — A re-acquired Statement is buyable at the old price (documented, bounded by I-31 and I-33).

---

#### I-33

`StateMachine` · On-chain: **Yes**

> `sellerNonce` only increases; `cancelAll` permanently voids every earlier listing of that seller.

**Derivation** — edge: `++sellerNonce[msg.sender]` @`StatementMarket.sol:82`; listing stores the nonce @`StatementMarket.sol:76`; `l.nonce != sellerNonce[l.seller]` → not live @`StatementMarket.sol:102`.

**If violated** — Cancelled listings could come back.

---

#### I-34

`Conservation` · On-chain: **Yes**

> For every live card of a party before the burn, `cardOfCredit[creditOfCard[c]] == c`.

**Derivation** — Δ-pair: `onDeposit` `Party.sol:230-231` ↔ `_redeem` `Party.sol:260-261`. `claim`/`claimFor` delete `creditOfCard` only (`Party.sol:549,567`); the card is burned, so stale `cardOfCredit` entries belong to dead cards.

**If violated** — `verifyOrder`'s "deposited" check (G-70) and redemption routing go wrong.

---

**Categories:**
- **Conservation**: equal-and-opposite deltas in one function body.
- **Bound**: guard lifted to a global property across every write site (On-chain=No if any write site lacks it).
- **Ratio**: storage defined as a formula of other storage.
- **StateMachine**: discrete transitions with no reverse.
- **Temporal**: depends on `block.timestamp` / `block.number` and a stored deadline.

---

## 3. Inferred Invariants (Cross-Contract)

Trust assumptions that span contract boundaries. Each block cites both caller-side and callee-side code.

---

#### X-1

On-chain: **Yes**

> For any proposal, `yes + no ≤ 80`: snapshot weights sum to at most the party's live cards.

**Caller side** — `Party.sol:421,426-427` — `w = heldAt(party, voter, snapshot)`, cached per voter; a changed vote subtracts the same `w`.

**Callee side** — `CreditCards.sol:48-53` (mint only by a registered party), `CreditCards.sol:56-59` (burn only by the card's party), `CreditCards.sol:71-83` (±1 per transfer); Party mints only in `onDeposit`, bounded by I-5.

**If violated** — Thresholds (41/54/60) could be reached with phantom weight.

---

#### X-2

On-chain: **Yes**

> `Party.cardsOutstanding` equals the number of live CreditCards with `partyOf == party`.

**Caller side** — `Party.sol:233,263,550,568` — each ± paired with `cards.mint` / `cards.burn` in the same body.

**Callee side** — `CreditCards.sol:48-53`, `CreditCards.sol:56-59` — no other mint/burn path.

**If violated** — Post-sale ETH (I-2) short or stranded.

---

#### X-3

On-chain: **Yes**

> When `onDeposit` runs, every listed Credit was moved from the depositor to this party by the factory.

**Caller side** — `Party.sol:215,228` — factory-only, then `credits.ownerOf(id) == address(this)`.

**Callee side** — `PartyFactory.sol:63-66` — `credits.transferFrom(msg.sender, address(party), ids[i])` then `party.onDeposit(msg.sender, …)`; `PartyFactory.sol:59` restricts to own clones.

**If violated** — Cards minted for Credits the party does not hold, or for someone else's Credits.

---

#### X-4

On-chain: **No**

> A floor reading applies only to the party (and moment) it was issued for.

**Caller side** — `Party.sol:600-606` — accepts any reading ≤ 10 min old, ≥ `lastFloorAt`, signed for the party's `floorMode`; used by the burn scan (`Party.sol:361`), execute (`Party.sol:453`), `_resolve` (`Party.sol:315`), raiseAsk (`Party.sol:509`).

**Callee side** — `PartyFactory.sol:87-89` — digest covers `(floorWei, mode, issuedAt)` only; no party address, no nonce.

**If violated** — The submitter picks among valid readings (per party, per call) that set asks and the 41/60 threshold.

---

#### X-5

On-chain: **No**

> CreditTraits keys reflect each Credit's real traits.

**Caller side** — `CreditKeys.sol:80-81` (called from `Party.sol:295` via `factory.traits()`) — trusts `traits.keys(p, order)` for all six trait presets.

**Callee side** — `CreditTraits.sol:41-57` checks only chunk count and byte sizes; `packedOf` `CreditTraits.sol:75-86` returns whatever bytes were deployed; `PartyFactory.sol:33` checks only `traits_.code.length > 0`. Content correctness is verified off-chain (`scripts/keytable`, `script/DeployMainnet.s.sol:34`).

**If violated** — Sorted presets verify against wrong traits; burns follow the table, not the art.

---

#### X-6

On-chain: **Yes**

> Party's time unit is in `(0, 1 hour]` (identity on mainnet).

**Caller side** — `Party.sol:171-172` — reads `factory.timeUnit()` once, reverts outside the range.

**Callee side** — `PartyFactory.sol:69-71` returns `1 hours`; `TestnetPartyFactory.sol:17-21` returns a unit `≤ 1 hours`, refuses chainid 1.

**If violated** — Rule windows (votes, grace, deadlock) scaled wrongly.

---

#### X-7

On-chain: **Yes**

> CreditKeys' transient marks (Manual check) never touch Party's reentrancy-guard slot.

**Caller side** — `Party.sol:295` — `verifyOrder` runs via DELEGATECALL in Party's context while `nonReentrant` holds its transient slot.

**Callee side** — `CreditKeys.sol:61` (every id deposited, so `< 2^32`) precedes `tload/tstore(id)` `CreditKeys.sol:66-73`; marks are cleared before return.

**If violated** — Reentrancy lock cleared or a false "repeat".

---

#### X-8

On-chain: **Yes**

> The sale fee rate is 1% for every party, forever.

**Caller side** — `Party.sol:524` — `factory.FEE_BPS()` read at sale time.

**Callee side** — `PartyFactory.sol:22` — `uint16 public constant FEE_BPS = 100`; no setter; parties bind to one factory at `initialize` (`Party.sol:168`).

**If violated** — Fee could change after members joined.

---

## 4. Economic Invariants

Higher-order properties derived from combinations of §2 and §3 invariants.

---

#### E-1

On-chain: **Yes**

> Each card holder receives exactly `(price − fee − dust) / 80`; the fee recipient receives `fee + dust`; nothing is stranded.

**Follows from** — `I-1` + `I-2` + `X-2` + `X-8`

**If violated** — Members underpaid or ETH locked in the clone.

---

#### E-2

On-chain: **No**

> A Statement is never sold below the floor unless ≥ 60 of 80 voted for that price.

**Follows from** — `X-4` + `I-10` + `I-16` + `I-19` (below-floor judged against a caller-chosen reading at execution or at the burn; a pending Fixed price judged at FULL-phase execution is not re-judged at the burn, `Party.sol:314-315`)

**If violated** — A 41-card majority sells below a current floor.

---

#### E-3

On-chain: **Yes**

> No floor reading, however low, resolves a floor-relative ask below `minAskWei`.

**Follows from** — `I-6` + `I-26` (M3 clamp `Party.sol:618,623-625` also covers results ≤ 0)

**If violated** — A bad or compromised reading could list for dust.

---

#### E-4

On-chain: **No**

> The price that goes live at the burn is the most recent LIST that passed while FULL.

**Follows from** — `I-12` (scan length unbounded) + `I-19` + `X-4` (the burn caller's reading decides whether a Fixed candidate passes at 41 or needs 60, `Party.sol:361-363`, and the scan falls through to older candidates / pending / default)

**If violated** — Burn caller influences which voted price goes live; very long scans may not fit a block.

---

#### E-5

On-chain: **Yes**

> After the burn the Statement leaves the party only through `buy`, at the live ask, after its wait.

**Follows from** — `I-13` + `I-14` + `I-8` + `I-9` (sole `transferFrom` of the Statement at `Party.sol:534`; the trusted Statement contract itself is outside scope)

**If violated** — The Statement could be moved without a sale.
