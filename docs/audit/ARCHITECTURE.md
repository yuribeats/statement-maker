# Statement Maker: architecture

Code reference: `contracts/src/` at commit `5040009` (unchanged at `44d09c8`). Line numbers refer to that commit.

## 1. Purpose

Jack Butcher's Credits (122,154 sealed ERC-721s) can be burned 80 at a time into one Statement. Most holders own one Credit. Statement Maker lets strangers pool Credits into a **party**. The party burns 80 into one Statement, sells it only at a price its members voted for (or the host's default), and splits the proceeds 1/80 per Credit.

## 2. Contracts and roles

| Contract | Deployed as | Role |
|---|---|---|
| `PartyFactory` | Once | Deploys one `Party` EIP-1167 clone per party. In its constructor it deploys the shared `CreditCards` collection and the `Party` implementation. It holds the immutable addresses (Credits, Statement, fee recipient, floor signer, CreditTraits) and the constant `FEE_BPS = 100` (1%). It verifies floor signatures (EIP-712). It has **no owner, admin, pause, or upgrade path.** |
| `Party` | One clone per party | Custodies deposited Credits and later the Statement. Mints and burns cards through `CreditCards`. Runs price governance, the sale, and payouts. Holds all ETH from the sale until claimed. |
| `CreditCards` | Once (created by the factory) | One ERC-721 for every party. Each card is tied to one party (`partyOf`) at mint. Only a registered party can mint, and only the card's own party can burn it. It keeps `Checkpoints.Trace208` balances per `(party, account)` for snapshot voting, and renders on-chain metadata through `Party.cardView`. |
| `CreditKeys` | Linked library | `verifyOrder` (the burn-order check), trait-key formulas and rarity table, seeded Fisher–Yates shuffle. Never calls the art contract. |
| `CreditTraits` | Once (15 SSTORE2 data contracts + 1) | Sealed table of every Credit's sort traits (3 bytes per id: marks, plate mask, eights, print rank, weight rank), committed once from `data/keytable/table.bin`. `keys(preset, ids)` returns the sort keys Party verifies. No owner or admin. `tableHash` pins the chunk code. |
| Credits (external) | Live mainnet | The deposited asset. See SCOPE.md §5.2. |
| Statement (external) | Unpublished | Burns the 80 Credits and mints the Statement. See SCOPE.md §5.3. |

## 3. Party parameters (fixed at creation, no setters)

`Party.Params` (Party.sol lines 62-74), validated in `initialize` (lines 146-161):

| Field | Constraint | Effect |
|---|---|---|
| `name` | 1-60 bytes | Display. Cleaned to `[A-Za-z0-9 .,-]`, at most 40 characters, in card SVG. |
| `description` | ≤ 1000 bytes | Display |
| `filters` | unbounded string | Human-readable only. Not enforced. |
| `eligibleRoot` | any; 0 = any Credit | Merkle root of eligible Credit ids. Leaf is `keccak256(bytes.concat(keccak256(abi.encode(id))))`. |
| `minDeposit` | 1..80 | Fewest Credits per `deposit` call, except that the last slots can be filled with exactly the remainder. |
| `durationDays` | 1..60 | `deadline = createdAt + durationDays days`. The party must be assembled by the deadline or it expires. |
| `voteHours` | 1/24/48/72/168 | Default voting window (a proposal may pick any of these; CANCEL always runs 24 h) |
| `arrangement` | `CreditKeys.Preset` | Deposit, Number, Time, Rarity, Colors, Print, Weight, Eights, Ink, Random, Manual |
| `seed` | any | Random preset seed (public) |
| `defaultPrice` | `PriceSpec` | Goes live at assembly unless a LIST executed while FULL |
| `floorMode` | Avg24h / Latest | Bound into the floor signature (`mode` field) |
| `minAskWei` | wei | Lowest ask a **floor-relative** price can resolve to (required > 0 if the default is floor-relative). It never bounds a Fixed price: 41 (60 below the floor) can vote any fixed price. |
| `buyDelayHours` | 0..72 | Default buy wait. At least 1 for a floor-relative default (also enforced on every floor-relative LIST), so a stale-low reading can be raised with `raiseAsk` before buying opens. |

The first host is `msg.sender` of `PartyFactory.createParty`. Anyone can create a party; no Credit ownership is required. The host can call `transferHost(to)`. There is exactly one host. The host cannot edit params, close the party early, or veto anything.

## 4. State machine

`Party.status()` (lines 172-177) is derived from storage and time. No transition is ever stored as an enum.

```
sold                              -> SOLD
else assembled                    -> ASSEMBLED
else block.timestamp > deadline   -> EXPIRED
else _order.length == 80          -> FULL
else                              -> OPEN
```

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | OPEN | `PartyFactory.createParty(params)` → clone, `CreditCards.registerParty`, `initialize` | Anyone (becomes host) |
| OPEN | OPEN | `factory.deposit(party, ids, proofs)` below 80; `redeem(cardIds)` | Depositor: the Credit owner themselves (approves the factory, never the party). Redeem: the current card holder. |
| OPEN | FULL | `factory.deposit` that brings `_order.length` to 80 (sets `fullAt`) | Any Credit owner |
| OPEN | EXPIRED | Time: `block.timestamp > deadline` | Nobody. Passive. |
| FULL | ASSEMBLED | `assemble(order, floor)`: permutation and preset check, price resolved, `Statement.make`, burn verified | Manual preset: host only for 1 day after FULL, then any card holder with the Time order. Other presets: anyone holding ≥ 1 of this party's cards now. |
| FULL | EXPIRED | Time: `block.timestamp > deadline` before assembly | Passive |
| ASSEMBLED | SOLD | `buy(maxPrice)` with `ask > 0`, `now ≥ askLiveAt + 24h`, `msg.value ≥ ask ≤ maxPrice` | Anyone |
| EXPIRED | (terminal) | `redeem` (holder) / `redeemFor` (anyone, pays the holder) until every Credit is back | Card holders / anyone |
| SOLD | (terminal) | `claim(cardIds)` burns cards and pays `perCard`. `withdraw()` pays fee and dust (and holders a `claimFor` push could not reach). | Card holder / owed address |

Notes:
- FULL cannot go back to OPEN, because redemption is locked in FULL.
- ASSEMBLED never expires. The deadline check comes after the `assembled` check. With no buyer, the Statement stays in the party indefinitely. No rage-quit exists.
- SPEC's LISTED and DISTRIBUTED are not separate states. "Listed" means ASSEMBLED with `ask > 0`. "Distributed" means SOLD.
- Deadline comparison is strict (`>`). At `timestamp == deadline` the party is still OPEN or FULL.

## 5. Money flow of a sale (`buy`, lines 466-495)

```
price = ask (buyer pays msg.value ≥ price; excess refunded by call at the end)
fee     = price × FEE_BPS / 10_000                                   (FEE_BPS = 100 → 1%)
pot     = price − fee
perCard = pot / 80
dust    = pot − perCard × 80                                         (< 80 wei)

owed[feeRecipient]    += fee + dust        (pull, withdraw())
each of the 80 cards  -> perCard           (pull, claim(), card burned)
Statement: party -> buyer via transferFrom (no receiver callback)
```

Conservation: `fee + dust + 80 × perCard == price`. No creator royalty is paid; `royaltyInfo` is never called and `Sold.royalty` is always 0. Party ETH balance after the sale equals `price`, which is paid out entirely through `withdraw` and `claim`. The SPEC example is 3 ETH: 0.03 fee, 2.97 pot, 0.037125 per card.

`receive()` reverts, so the only ETH that enters is `buy`'s `msg.value` (plus forced ETH, which no accounting reads).

Royalty: none. The contracts pay no creator royalty (removed; the SPEC says the same).

## 6. Price governance

Only prices are governed. Two proposal kinds: **LIST** (`cancel = false`, a `PriceSpec`) and **CANCEL_LISTING** (`cancel = true`). No arbitrary calls.

### 6.1 Price specs
- `Fixed`: `value` wei, `0 < value ≤ 1e24`.
- `FloorPct`: `floor × (10_000 + value) / 10_000`, with `-10_000 < value ≤ 1_000_000` (basis points).
- `FloorDelta`: `floor + value` wei, `|value| ≤ 1e24`. A result ≤ 0 resolves to 0 and is then clamped up to `minAskWei` (Pashov M3; it used to revert and could block assembly).

### 6.2 Lifecycle of a proposal
| Step | Rule | Code |
|---|---|---|
| propose | LIST allowed in FULL or ASSEMBLED, from the block after the one that filled slot 80 (`fullBlock`; Pashov L4: the snapshot is block − 1). CANCEL allowed only in ASSEMBLED with `ask > 0`. Caller must hold ≥ 1 card now. Lifetime cap `MAX_PROPOSALS = 256` per party. At most `MAX_OPEN_PER_PROPOSER = 3` open proposals per address. Window 1/24/48/72/168 h (0 = party default; CANCEL always 24 h). The proposer's YES is cast automatically. | 340-362 |
| snapshot | `snapshot = block.number − 1`. Weight = the caller's card count for this party at the end of that block (`CreditCards.heldAt`). Resists flash loans and buy-vote-sell. | 354, 368-382 |
| vote | Allowed while `now < endsAt`. Weight is cached on first vote. The vote can be changed (yes↔no). No check for epoch, executed, or status. | 364-382 |
| execute | `now ≥ endsAt` and `now ≤ endsAt + 7 days` (else lapsed), `epoch == priceEpoch` (else superseded), caller holds ≥ 1 card now, and status valid for the kind. LIST requires a valid floor attestation even for `Fixed` prices. | 392-427 |
| pass rule | `need = 41`. `need = 60` for a LIST whose resolved price is below the attested floor at **execution**. Proposals created under deadlock need `max(need, 54)`. Passes iff `yes ≥ need` and (`no == 0` or created-under-deadlock). | 385-390, 409 |
| effect | CANCEL: `ask = 0`. LIST in FULL: stored as `pendingPrice`, applied at assembly. LIST in ASSEMBLED: `ask = resolved price`, `askLiveAt = now` (restarts the 24 h buy delay). Every execution bumps `priceEpoch`, which supersedes **all** other open proposals of both kinds, and sets `lastPriceExecutedAt`. | 411-426 |

### 6.3 Thresholds
| Constant | Value | Meaning |
|---|---|---|
| `PASS` | 41 | Simple majority of 80, with zero NO |
| `PASS_BELOW_FLOOR` | 60 | 75%, for a LIST below the attested floor at execution |
| `PASS_DEADLOCK` | 54 | 2/3, NO ignored, for proposals created while deadlocked. Below floor still needs 60. |

### 6.4 Deadlock escape (`_deadlocked`, lines 437-441)
The party is deadlocked if either:
- `blockedPriceProposals ≥ 3`. Anyone can increment the counter through `countBlocked(id)` for any closed, unexecuted, non-cancel, non-deadlock proposal with `no > 0`. **The counter is global to the party and never resets**, so once it reaches 3 the party is permanently in deadlock mode.
- or `now > since + 30 days`, where `since = lastPriceExecutedAt`, or `fullAt` if no price decision has executed. Assembly does not update `since`.

The deadlock flag is frozen into each proposal at creation.

### 6.5 Epochs
`priceEpoch` increments on every executed proposal and on `assemble`. A proposal can execute only if its epoch still matches, so every proposal made before an assembly or before any other execution is dead.

## 7. Arrangement and assembly (`assemble`, lines 254-292)

Arranging and burning happen in one call. Orders are computed off-chain; the burn does only cheap checks (`CreditKeys.verifyOrder`): no art-contract call, no O(n²) scan. `order` must be a permutation of the 80 deposited ids: Deposit/Random by equality with the stored order; sorted presets by strictly ascending keys (distinct) with every id deposited (`cardOfCredit != 0`); Manual by every id deposited and distinct (transient-storage marks, cleared after).

| Preset | Who may call | On-chain check |
|---|---|---|
| Manual | host until `fullAt + MANUAL_GRACE` (1 day); then any card holder | Host: permutation only, any order. After the grace: exactly the Time order. |
| Deposit | any current card holder | `order == _order` (deposit order after redemptions compacted it) |
| Random | any current card holder | `order == CreditKeys.shuffle(_order, seed)`: keccak Fisher–Yates, `j = keccak256(abi.encodePacked(seed, i−1)) % i` |
| Number, Time | any current card holder | Ids strictly increasing, every id deposited. Time == ascending id: payment times never decrease with id over the sealed collection (verified for all 122,154; `test/keytable`). |
| Colors, Ink, Eights, Print, Weight, Rarity | any current card holder | `CreditTraits.keys` strictly increasing, every id deposited. Every key packs the Credit id into its low 32 bits, so keys are unique and ties break by ascending id. |

Key definitions (`CreditKeys.traitKey` over the CreditTraits entry; identical to the original describe()-based keys, `test/ref/CreditKeysRef.sol`, for all 122,154 Credits):
- Number = Time = id. Colors = `colorRank(mask)`, mask = `(paidAt % 15) + 1` as in `CreditDrawing.platesAt`, stored in the table. Ink = `marks`.
- Eights = `uint32.max − eights` (descending). Print = `5 − printRank` (most misregistered first). Weight = `(weightRank << 16) | marks`.
- Rarity = `uint64.max − Σ(−log2 frequency × 1e9)` over the four traits (descending score). Constants are hard-coded from the sealed supply.
- The table was built from the art contract's `describe()` and checked three ways (scripts/keytable): forge derivation (a) == live-mainnet eth_call derivation (b) for all ids × presets (0 mismatches), table == site trait data (0 mismatches), table keys == (a) for all ids; fork tests re-check 2,000 sampled ids and all 320 house-party ids.

Sequence:
1. Resolve the live price (`_burnPrice`, bounded work): candidates are the current-epoch LISTs that reached 41 YES while FULL, recorded once in `_vote` (`_passedIds[epoch]`); the burn judges at most the latest `BURN_CANDIDATES` = 8 of them and applies the highest-id one that is closed, inside its execute window and passes at THIS burn's floor with its final tally (as `execute` judges: below floor needs 60, deadlock 54, zero NO unless deadlock), marking it executed. Else the LIST executed while FULL (`_pendingId`) if it still passes at this floor (re-audit M-2). Else `defaultPrice`. Floor-relative prices need a valid floor attestation; a Fixed candidate with 41+ YES that could pass above the floor needs one too (`floor needed`). Buying opens after the price's wait, at least 1 hour. Proposal spam cannot inflate the burn: adding a candidate needs 41 YES of snapshot weight (re-audit M-1).
2. Effects: `assembled = true`, `burnOrderHash = keccak256(abi.encodePacked(order))` (the order itself is in the `Assembled` event), `ask`, `askSpec`, `askLiveAt = now`, `++priceEpoch`.
3. `credits.setApprovalForAll(statement, true)`, then `_assembling = true`, then `statement.make(order)`, then `_assembling = false`, then revoke approval.
4. Verify: `statement.ownerOf(sid) == party`, and for each of the 80, `credits.ownerOf(id)` reverts with `ERC721NonexistentToken` (selector `0x7e273289`, the mainnet Credits error for a burned or never-minted id, checked on chain 2026-09-24). A Credit that still has any owner, or any other revert, fails with `not burned`.

Measured cost (mainnet fork, cold, MockStatement): 4.88M–5.14M gas before refunds (the figure the 16,777,216 per-transaction cap applies to), 3.95M–4.16M after refunds, for every preset (test/gas/Cap.t.sol, test/gas/Breakdown.t.sol). Of that, Credits.burn is 1.94M and MockStatement's mint 1.51M; the real Statement contract's `make` is unknown until it ships (PRE_MAINNET.md). Before the key table: 7.38M–12.84M before refunds.

## 8. Floor oracle

- The off-chain server takes OpenSea readings every minute and keeps 25 h of them. It produces either a 24 h average or the latest reading, per `floorMode`. The source is the Statement collection floor once it exists, otherwise 80 × the Credits floor (SPEC §13).
- `floorSigner` (immutable in the factory) signs the EIP-712 message `Floor(uint256 floorWei, uint8 mode, uint64 issuedAt)`. The domain is `name="Statement Maker"`, `version="1"`, plus chainId and the factory address.
- The message contains **no party address**. One signature is valid for every party with the same `floorMode`.
- A party accepts a reading if `issuedAt ≤ now`, `now − issuedAt ≤ 10 minutes` (`FLOOR_MAX_AGE`, real time), `issuedAt ≥ lastFloorAt` (never older than the last reading this party used), the signature recovers to `floorSigner` (`ECDSA.tryRecover`, which rejects malleable signatures), and `floorWei > 0`.
- Uses: resolving floor-relative prices at `assemble` and `execute`, the below-floor 60-vote rule at `execute`, and `raiseAsk`.
- Whoever submits the transaction chooses which valid reading from the last hour to use.
- `raiseAsk(floor)` (anyone, ASSEMBLED, `ask > 0`, floor-relative `askSpec`) sets the ask to `resolve(askSpec, floor)` only if it is strictly higher. It does not reset `askLiveAt`. Buyers are protected against a same-block raise by `buy(maxPrice)`.

Trust: the signer is fully trusted for floor values. See THREAT_MODEL.md §3 for the impact of a compromised or offline signer.

## 9. Differences between SPEC.md v0.8 and the code

| SPEC.md | Code |
|---|---|
| Multiple hosts; hosts edit params while OPEN, set the deadline, close early | One host, `transferHost` only. Params are immutable. No early close. |
| Proposal types NOMINATE_ARRANGER, APPROVE_ARRANGEMENT, ASSEMBLE, DISTRIBUTE, LIST, CANCEL_LISTING | LIST and CANCEL only. Arrangement is a creation-time preset, and assembly is a direct call. |
| Below-floor measured "at creation or execution" | At execution only |
| Deadlock "of a kind"; "30 days since FULL/assembly" | One counter for LIST only, never reset. Clock runs from FULL or the last execution; assembly does not reset it. |
| "Executing supersedes every other pending proposal of the same kind" | Supersedes all proposals of both kinds, and assembly supersedes too |
| "Any party member" can execute / assemble | Must hold ≥ 1 card **now** (`heldNow`). Depositors who moved their cards cannot. |
| Royalty: ERC-2981, then Royalty Registry | No royalty paid (removed) |
| `claimFor(holder)`: push, anyone calls | `claim` by the holder only. The fee recipient withdraws. |
| Rarity from OpenSea OpenRarity | On-chain table from sealed-supply trait frequencies |
| openParty by "any Credit holder" | Anyone |

## 10. Access control by function

"Card holder now" means `cards.heldNow(party, msg.sender) > 0`. "Holder of card c" means `cards.partyOf(c) == party && cards.ownerOf(c) == account`.

### PartyFactory
| Function | Caller | State / conditions |
|---|---|---|
| `constructor(credits, statement, feeRecipient, floorSigner)` | deployer | All four non-zero. Deploys `CreditCards` and the `Party` implementation. |
| `createParty(params)` | anyone | Becomes host. Params validated in `initialize`. |
| `partiesCount`, `parties(i)`, `floorDigest`, `isValidFloor` | anyone (view) | none |

### Party
| Function | Caller | State / conditions | Reentrancy lock |
|---|---|---|---|
| `initialize(host, params)` | factory (the first caller; `initializer`) | Once. The implementation is locked by `_disableInitializers`. | none |
| `PartyFactory.deposit(party, ids, proofs)` | the Credit owner, who has approved the **factory** (`setApprovalForAll(factory)` or per-token `approve(factory)`) | `isParty[party]`. The factory calls `credits.transferFrom(msg.sender, party, id)` for each id, then `party.onDeposit(msg.sender, ids, proofs)`. |
| `onDeposit(from, ids, proofs)` | the factory only | OPEN. Count between min(minDeposit, remaining) and remaining. Merkle proof if a root is set. No duplicate. `credits.ownerOf(id) == party` for each (received). Mints one card per Credit to `from`. The host's opening deposit takes the same path inside `createParty`. |
| `redeem(cardIds)` | holder of each card | OPEN or EXPIRED | yes |
| `redeemFor(cardIds)` | anyone; Credit goes to the current card holder | EXPIRED | yes |
| `assemble(order, floor)` | Manual within 1 day of FULL: `host`. Otherwise: card holder now (Manual falls back to the Time order). | FULL. Valid permutation and preset order. Price resolvable. | yes |
| `onERC721Received` | the Statement contract only | only while `_assembling` | n/a (view) |
| `propose(price, cancel, hours)` | card holder now, with weight at `block.number−1` | LIST: FULL or ASSEMBLED. CANCEL: ASSEMBLED and `ask > 0`. Fewer than 256 total. Fewer than 3 open by caller. | **no** |
| `vote(id, support)` | anyone with weight at the proposal's snapshot | `now < endsAt` | **no** |
| `execute(id, floor)` | card holder now | Window closed, within 7 days, epoch current, status valid, pass rule met | yes |
| `countBlocked(id)` | anyone | Closed, not executed, not cancel, not deadlock, `no > 0`, not yet counted | **no** |
| `raiseAsk(floor)` | anyone | ASSEMBLED, `ask > 0`, floor-relative `askSpec`, new ask strictly higher | **no** |
| `buy(maxPrice)` | anyone | ASSEMBLED, `ask > 0`, `now ≥ askLiveAt + 24h`, `ask ≤ maxPrice`, `msg.value ≥ ask` | yes |
| `claim(cardIds)` | holder of each card | SOLD | yes |
| `withdraw()` | any address with `owed > 0` (fee recipient; holders a `claimFor` push could not pay) | any | yes |
| `transferHost(to)` | `host` | `to ≠ 0`, any state | no |
| `receive()` | always reverts | | |
| views: `status`, `params`, `depositOrder`, `burnOrderHash`, `count`, `proposalCount`, `proposal`, `needFor`, `cardView`, public getters | anyone | | |

### CreditCards
| Function | Caller | Conditions |
|---|---|---|
| `registerParty(party)` | `factory` only | Called once per clone, before `initialize` |
| `mint(to)` | a registered party | Card id = `nextId++` (starts at 1). `partyOf[id] = msg.sender`. `_mint` (no receiver callback). |
| `burn(id)` | `partyOf[id]` only | The party checks the holder before calling |
| `heldAt(party, account, block)` | anyone (view) | `block < block.number` |
| `heldNow(party, account)` | anyone (view) | latest checkpoint |
| `tokenURI(id)` | anyone (view) | Calls `Party.cardView` |
| ERC-721 `transferFrom`/`safeTransferFrom`/`approve`/`setApprovalForAll` | holder / approved | Standard OZ. `_update` moves one unit of checkpointed weight from `from` to `to` for `partyOf[id]`. |
