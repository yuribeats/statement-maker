# Entry Point Map

> Statement Maker | 28 entry points | 14 permissionless | 12 role-gated | 2 admin-only (CreditCards `Ownable`, no protocol power)

Code reference: `contracts/src/` at `d548e55`. Excluded: views/pure, interfaces, `mocks/MockStatement.sol`, `testnet/KeyProbe.sol` (views only). `CreditKeys.verifyOrder` is a `public` library function reached only by DELEGATECALL from `Party.assemble` (direct calls to a non-view library function revert), so it is listed under the burn, not as an entry point.

---

## Protocol Flow Paths

### Setup (deployer, once)

`CreditKeys` (linked lib) → `CreditTraits(chunks, count)` ◄── table.bin must match `TABLE_KECCAK` (deploy script) → `PartyFactory(credits, statement, fee, signer, collectionOwner, traits)` ◄── deploys `CreditCards` + `Party` implementation → `StatementMarket(statement, fee)`

### Host / depositors

`[setup]` → `Credits.setApprovalForAll(factory)` → `PartyFactory.createParty(params, ids, proofs)` → `CreditCards.registerParty` → `Party.initialize` → `Party.onDeposit` (host's opening deposit)
`[createParty]` → `PartyFactory.deposit(party, ids, proofs)` ◄── status OPEN, eligibility proof, ≥ min(minDeposit, remaining) → … → 80th Credit sets `fullAt`, `fullBlock`, deadline ≥ now + 2 days
                                               ├─→ `Party.redeem(cardIds)`  ◄── OPEN, card holder
                                               └─→ `Party.redeem` / `redeemFor`  ◄── deadline passed without burn (EXPIRED)

### Price governance (card holders)

`[80th deposit]` → [next block] → `Party.propose(price, cancel=false, …)` → `vote()` → [window closes] → `execute(id, floor)`  ◄── ≥ 41 YES, 0 NO (60 below floor, ≥ 54 in deadlock), ≤ 7 days
                                          └─→ `countBlocked(id)`  ◄── ≥ 41 YES stopped by NO → after 3 (or 30 days), new proposals run in deadlock mode

### Burn (arrange + assemble, one call)

`[80th deposit]` → `Party.assemble(order, floor)`  ◄── FULL; Manual: host ≤ fullAt + 1 day, then any holder with Time order; auto presets: any holder
    → `CreditKeys.verifyOrder` → `CreditTraits.keys` (trait presets) → `_passedUnexecuted(floor)` (latest passed LIST applied) → `Statement.make(order)` → verify Statement received + 80 Credits burned

### Sale and payouts

`[burn]` → [buyableAt ≥ burn + 1 h] → `Party.buy(maxPrice)` → `claim(cardIds)` / `claimFor(cardIds)` → `withdraw()`  ◄── owed > 0 (fee recipient, failed pushes)
`[burn]` → `propose(cancel=true)` → `execute` (ask = 0) → `propose(LIST)` → `execute` (new ask, new wait)
`[burn, floor-relative ask]` → `raiseAsk(floor)`  ◄── fresh reading, strictly higher

### Resale (any Statement owner)

`[Statement owned + market approved]` → `StatementMarket.list` / `listFor` → `StatementMarket.buy(tokenId, maxPrice)` → `withdraw()`
                                        ├─→ `cancel(tokenId)`  ◄── seller, or anyone once the seller no longer owns it
                                        └─→ `cancelAll()`  ◄── voids every earlier listing of the caller

---

## Permissionless

### `PartyFactory.createParty()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone (becomes host); must own the opening Credits and have approved the factory |
| Parameters | p (user-controlled: name, description, filters, eligibleRoot, minDeposit, durationDays, voteHours, arrangement, seed, defaultPrice, floorMode, minAskWei, buyDelayHours), ids (user-controlled), proofs (user-controlled) |
| Call chain | `→ Clones.cloneDeterministic(impl, keccak(host, nonce)) → CreditCards.registerParty() → Party.initialize() → Credits.transferFrom(msg.sender, party, id) → Party.onDeposit() → CreditCards.mint()` |
| State modified | `nonces[msg.sender]`, `isParty`, `parties`; CreditCards `isParty`; Party params/host/deadline, `_order`, card maps, `cardsOutstanding` |
| Value flow | Credits: host → new Party |
| Reentrancy guard | no (factory); yes on `Party.onDeposit` |

### `PartyFactory.deposit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Any Credit owner who approved the factory |
| Parameters | party (user-controlled, must be `isParty`), ids (user-controlled), proofs (user-controlled) |
| Call chain | `→ Credits.transferFrom(msg.sender, party, id) → Party.onDeposit(msg.sender, ids, proofs) → CreditCards.mint(from)` |
| State modified | Party `_order`, `cardOfCredit`, `creditOfCard`, `cardsOutstanding`, `fullAt`/`fullBlock`/`deadline` on the 80th; CreditCards `nextId`, `partyOf`, `_held` |
| Value flow | Credits: caller → Party |
| Reentrancy guard | yes (in `onDeposit`) |

### `Party.buy()`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Anyone (buyer) |
| Parameters | maxPrice (user-controlled), msg.value (user-controlled) |
| Call chain | `→ PartyFactory.FEE_BPS() → PartyFactory.feeRecipient() → Statement.transferFrom(party, buyer, statementId) → buyer.call{refund}` |
| State modified | `sold`, `perCard`, `ask`, `owed[feeRecipient]` |
| Value flow | ETH: buyer → Party (price); Statement: Party → buyer; excess ETH refunded |
| Reentrancy guard | yes |

### `StatementMarket.buy()`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Anyone except the seller |
| Parameters | tokenId (user-controlled), maxPrice (user-controlled), msg.value (user-controlled) |
| Call chain | `→ isLive() → Statement.ownerOf/isApprovedForAll/getApproved → Statement.safeTransferFrom(seller, buyer) → seller.call{value, gas: 50_000} → buyer.call{refund}` |
| State modified | `listings[tokenId]` (deleted), `owed[feeRecipient]`, `owed[seller]` on failed push |
| Value flow | ETH: buyer → market → seller (99%) / fee (1%, pull); Statement: seller → buyer |
| Reentrancy guard | yes |

### `Party.claimFor()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Anyone; pays each card's current holder |
| Parameters | cardIds (user-controlled) |
| Call chain | `→ CreditCards.partyOf() → CreditCards.ownerOf() → CreditCards.burn() → holder.call{value: perCard, gas: 50_000}` |
| State modified | `creditOfCard`, `cardsOutstanding`, `owed[holder]` on failed push; CreditCards burn |
| Value flow | ETH: Party → card holders (or credited to `owed`) |
| Reentrancy guard | yes |

### `Party.withdraw()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Any address with `owed > 0` (fee recipient; holders a push could not reach) |
| Parameters | none |
| Call chain | `→ msg.sender.call{value: amt}` |
| State modified | `owed[msg.sender]` |
| Value flow | ETH: Party → caller |
| Reentrancy guard | yes |

### `StatementMarket.withdraw()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Any address with `owed > 0` (fee recipient; sellers whose push failed) |
| Parameters | none |
| Call chain | `→ msg.sender.call{value: amt}` |
| State modified | `owed[msg.sender]` |
| Value flow | ETH: market → caller |
| Reentrancy guard | yes |

### `Party.redeemFor()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Anyone, after expiry; each Credit goes to the card's current holder |
| Parameters | cardIds (user-controlled) |
| Call chain | `→ CreditCards.ownerOf() → _redeem() → _removeFromOrder() → CreditCards.burn() → Credits.transferFrom(party, holder, id)` |
| State modified | `creditOfCard`, `cardOfCredit`, `_order`, `cardsOutstanding` |
| Value flow | Credits: Party → card holders |
| Reentrancy guard | yes |

### `Party.raiseAsk()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone (keeper) |
| Parameters | floor (keeper-provided: floorWei, issuedAt, sig from the floor signer) |
| Call chain | `→ _resolve() → _floor() → PartyFactory.isValidFloor()` |
| State modified | `ask` (strictly higher), `lastFloorAt` |
| Value flow | None |
| Reentrancy guard | no |

### `Party.countBlocked()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone |
| Parameters | id (user-controlled) |
| Call chain | none (storage only) |
| State modified | `blockedCounted[id]`, `blockedPriceProposals` |
| Value flow | None |
| Reentrancy guard | no |

### `StatementMarket.list()` / `listFor()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Current owner of the Statement (ownership, not a role) |
| Parameters | tokenId (user-controlled), price (user-controlled, uint96 > 0), duration (user-controlled, 1 s..180 d; `list` = 30 d) |
| Call chain | `→ Statement.ownerOf() → Statement.isApprovedForAll()/getApproved()` |
| State modified | `listings[tokenId]` |
| Value flow | None |
| Reentrancy guard | no |

### `StatementMarket.cancel()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | The seller; anyone once the seller no longer owns the token (or `ownerOf` reverts) |
| Parameters | tokenId (user-controlled) |
| Call chain | `→ try Statement.ownerOf()` |
| State modified | `listings[tokenId]` (deleted) |
| Value flow | None |
| Reentrancy guard | no |

### `StatementMarket.cancelAll()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone (affects only the caller's listings) |
| Parameters | none |
| Call chain | none |
| State modified | `sellerNonce[msg.sender]` |
| Value flow | None |
| Reentrancy guard | no |

---

## Role-Gated

### Factory (`msg.sender == factory`)

#### `Party.onDeposit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant; internal check `msg.sender == factory` |
| Caller | PartyFactory (from `createParty` / `deposit`) |
| Parameters | from (protocol-derived: factory's caller), ids (user-controlled), proofs (user-controlled) |
| Call chain | `→ MerkleProof.verifyCalldata() → Credits.ownerOf() → CreditCards.mint(from)` |
| State modified | `_order`, `cardOfCredit`, `creditOfCard`, `cardsOutstanding`, `fullAt`, `fullBlock`, `deadline` |
| Value flow | None (Credits already moved by the factory) |
| Reentrancy guard | yes |

#### `Party.initialize()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `initializer` (implementation locked by `_disableInitializers`) |
| Caller | PartyFactory, atomically inside `createParty` |
| Parameters | host_ (protocol-derived: createParty caller), p (user-controlled) |
| Call chain | `→ PartyFactory.credits()/cards()/timeUnit()` |
| State modified | `factory`, `credits`, `cards`, `timeUnit`, `host`, `_params`, `createdAt`, `deadline` |
| Value flow | None |
| Reentrancy guard | no |

#### `CreditCards.registerParty()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; `msg.sender == factory` |
| Caller | PartyFactory |
| Parameters | party (protocol-derived) |
| Call chain | none |
| State modified | `isParty[party]` |
| Value flow | None |
| Reentrancy guard | no |

### Registered party (`isParty[msg.sender]` / `partyOf[id] == msg.sender`)

#### `CreditCards.mint()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; `isParty[msg.sender]` |
| Caller | A registered Party (from `onDeposit`) |
| Parameters | to (protocol-derived: depositor) |
| Call chain | `→ ERC721._mint() → _update()` (no receiver callback) |
| State modified | `nextId`, `partyOf`, ERC-721 balances, `_held[party][to]` |
| Value flow | Card: → depositor |
| Reentrancy guard | no |

#### `CreditCards.burn()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; `partyOf[id] == msg.sender` |
| Caller | The card's Party (from `_redeem`, `claim`, `claimFor`) |
| Parameters | id (protocol-derived) |
| Call chain | `→ ERC721._burn() → _update()` |
| State modified | ERC-721 ownership, `_held[party][holder]` |
| Value flow | Card destroyed |
| Reentrancy guard | no |

### Card holder (`heldNow > 0`, holder of a card, or weight at snapshot)

#### `Party.assemble()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Manual preset: `host` until `fullAt + MANUAL_GRACE`; otherwise any current card holder (Manual falls back to Time) |
| Parameters | order (user-controlled; must equal the preset's order), floor (keeper-provided; required if the price is floor-relative or a passed Fixed candidate needs judging) |
| Call chain | `→ CreditKeys.verifyOrder() [delegatecall] → CreditTraits.keys() (trait presets) → _passedUnexecuted() → _judgePrice()/_floor() → PartyFactory.isValidFloor() → Credits.setApprovalForAll(statement, true) → Statement.make(order) → Credits.setApprovalForAll(statement, false) → Statement.ownerOf(sid) → Credits.ownerOf(id) ×80 (must revert 0x7e273289)` |
| State modified | `assembled`, `assembledAt`, `burnOrderHash`, `statementId`, `ask`, `askSpec`, `askLiveAt`, `buyableAt`, `priceEpoch`, `lastFloorAt`; applied candidate: `executed`, `lastPriceExecutedAt`, `blockedPriceProposals` |
| Value flow | 80 Credits burned by Statement; Statement minted → Party |
| Reentrancy guard | yes |

#### `Party.propose()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; `heldNow(party, msg.sender) > 0` |
| Caller | Current card holder |
| Parameters | price (user-controlled), cancel (user-controlled), hours_ (user-controlled; 0 = default; cancels 24 h), buyDelayHours (user-controlled) |
| Call chain | `→ CreditCards.heldNow() → _refreshOpen() → _deadlocked() → _vote() → CreditCards.heldAt()` |
| State modified | `_proposals`, `_openIds`, `weightOf`, `voteOf` |
| Value flow | None |
| Reentrancy guard | no |

#### `Party.vote()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; weight at the proposal's snapshot > 0 |
| Caller | Holder at `snapshot` block |
| Parameters | id (user-controlled), support (user-controlled) |
| Call chain | `→ CreditCards.heldAt(party, voter, snapshot)` |
| State modified | `Proposal.yes/no`, `weightOf`, `voteOf` |
| Value flow | None |
| Reentrancy guard | no |

#### `Party.execute()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant; `heldNow > 0` |
| Caller | Current card holder |
| Parameters | id (user-controlled), floor (keeper-provided; optional for Fixed, then judged below floor) |
| Call chain | `→ CreditCards.heldNow() → _judgePrice() → _floor() → PartyFactory.isValidFloor() → needFor()` |
| State modified | `executed`, `priceEpoch`, `lastPriceExecutedAt`, `blockedPriceProposals`, `lastFloorAt`; CANCEL: `ask`, `askLiveAt`; LIST in FULL: `pendingPrice`, `_pendingBuyDelay`, `hasPendingPrice`; LIST in ASSEMBLED: `ask`, `askSpec`, `askLiveAt`, `buyableAt` |
| Value flow | None |
| Reentrancy guard | yes |

#### `Party.redeem()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant; holder check in `_redeem` |
| Caller | Holder of each card (OPEN or EXPIRED) |
| Parameters | cardIds (user-controlled) |
| Call chain | `→ _redeem() → CreditCards.partyOf()/ownerOf() → _removeFromOrder() → CreditCards.burn() → Credits.transferFrom(party, holder, id)` |
| State modified | `creditOfCard`, `cardOfCredit`, `_order`, `cardsOutstanding` |
| Value flow | Credits: Party → caller |
| Reentrancy guard | yes |

#### `Party.claim()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant; holder check per card |
| Caller | Holder of each card (SOLD) |
| Parameters | cardIds (user-controlled) |
| Call chain | `→ CreditCards.partyOf()/ownerOf() → CreditCards.burn() → msg.sender.call{value: total}` |
| State modified | `creditOfCard`, `cardsOutstanding` |
| Value flow | ETH: Party → caller (`perCard` × cards) |
| Reentrancy guard | yes |

### Host

#### `Party.transferHost()`

| Aspect | Detail |
|--------|--------|
| Visibility | external; `msg.sender == host` |
| Caller | Current host |
| Parameters | to (user-controlled, non-zero) |
| Call chain | none |
| State modified | `host` |
| Value flow | None |
| Reentrancy guard | no |

---

## Admin-Only

No protocol admin exists: PartyFactory, Party, CreditTraits and StatementMarket have no owner, setter, pause or upgrade path. The only owner is `CreditCards.owner()` (OZ `Ownable`), which no protocol function reads.

| Contract | Function | Parameters | State Modified |
|----------|----------|------------|----------------|
| CreditCards | `transferOwnership()` (inherited OZ) | newOwner | `_owner` (marketplace collection-page editing only) |
| CreditCards | `renounceOwnership()` (inherited OZ) | none | `_owner = 0` |

Standard ERC-721 `transferFrom` / `safeTransferFrom` / `approve` / `setApprovalForAll` on CreditCards are open to holders/operators; each transfer moves one unit of checkpointed vote weight (`CreditCards._update`).
