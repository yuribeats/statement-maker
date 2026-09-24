# STATEMENT MAKER — spec draft v0.8 (2026-09-23)

Model: PartyDAO (Party Protocol). Facts in RESEARCH.md.

## 1. Objects
- **Party**: one group assembling one Statement. Has hosts, params (§3), 80 slots, a deadline, a page with chat.
  "Sheet" now means only the 8×10 artwork layout.
- **Credit Card**: an ERC-721, one per deposited Credit, minted to the depositor at deposit. One collection for all parties (tokenId = global card number; the card records its party and its Credit).
  EVERYTHING FOLLOWS THE CARD: whoever holds it has the vote, the right to redeem its Credit (while OPEN, or after EXPIRED), and 1/80 of any sale. The depositor has no residual rights once the card moves.
  Image: on-chain SVG — the Credit's art, party name, card number, Credit #, its row/column in the 8×10, 1-of-80 share, and live status (filled count, arranging, Statement N, claimable ETH, redeemed).
  Freely transferable; trades on NFT marketplaces (ERC-721s do not pool on Uniswap).
- **Vault**: holds deposited Credits, then the assembled Statement.

## 2. Party lifecycle
| State | Enters when | Allowed |
|---|---|---|
| OPEN | host opens party | deposit (must meet the party's params) → one Credit Card per Credit; a card's holder may redeem it for its Credit (card burned) |
| FULL | 80th deposit | redemption closed. Arrangement phase (§5) |
| ASSEMBLED | vault calls Statement contract with the approved order; Credits burned (the vault checks every one of the 80 no longer exists: `Credits.ownerOf` must revert with `ERC721NonexistentToken`, so a Statement contract that keeps or moves the Credits is refused) | governance on the Statement |
| LISTED / SOLD | passed LIST proposal | anyone buys at the ask. No offers, ever |
| DISTRIBUTED | sale settles | each card's holder claims 1/80 of net proceeds (card burned on claim) |
| EXPIRED | deadline passes unfilled or unassembled | each Credit goes to whoever holds its card (any member can push all) |

Credits are never burned before assembly. If the Statement contract rejects contract callers, nothing is lost: parties expire and Credits return.

Approvals: a user approves exactly one contract, the PartyFactory (`Credits.setApprovalForAll(factory, true)`, once), never a party or a predicted party address. The factory moves Credits only from its own caller into one of its own parties (`isParty`), and the party records the deposit (`onDeposit`, callable only by the factory) after checking it received each Credit. Opening: `factory.createParty(params, ids, proofs)`. Later deposits: `factory.deposit(party, ids, proofs)`.

## 3. Hosts and party params
- The address that opens a party is its host (exactly one; `transferHost` hands it on). On-chain host powers are only those listed below under "Host powers"; there is no early close, no param editing after creation, and no host veto. Off-chain the host may moderate the party chat.
- Params (set by hosts):
  - **Minimum deposit**: fewest Credits one depositor may add. Final slots are exempt: when fewer slots remain than the minimum, the deposit may equal the remainder, so the party can always reach exactly 80.
  - **Target sell price**, one of two modes:
    - Fixed: X ETH.
    - Floor-relative: floor + X, where X is an ETH amount or a percent (host's choice). The floor source is the Statement collection floor; until Statements trade, Credits floor × 80.
    Shown on the party page. Once assembled, it pre-fills the first LIST proposal (members still vote).
  - **Eligibility filters**: Colors (plate combo), Print, Weight, Eights, marks range, rarity rank range, token-number range. Filters combine with AND.
- Filter enforcement: our indexer turns the filters into the list of eligible Credit ids and publishes its Merkle root; deposit requires a membership proof. Anyone can check the list: every trait is recomputable from the chain (CreditArt.describe(seed, paidAt) is public). Rarity rank comes from OpenSea's OpenRarity calculation and is the one input not on-chain.
- Param edits after deposits exist: undecided (options: allowed freely, allowed only if they do not disqualify Credits already deposited, or locked at first deposit).

- Every setting is a DEFAULT that runs automatically; depositing accepts the defaults; card holders can change any of them by vote.
  - Name (≤ 60) and description (≤ 1,000), plain text.
  - Arrangement: one auto-order preset (Time = payment time, the DEFAULT; Deposit order, Number, Rarity, Colors, Print, Weight, Eights, Ink, Random with a published seed) or Manual (rare; the host states the ordering metric in the description).
  - Default price: goes live at assembly unless card holders already voted a price.
  - Default voting window.
- Arranging: the host is the ONLY arranger. Arrangement is a party setting: an auto-order preset, or Manual (host orders by hand; flagged cyan in the UI). No arranger or arrangement votes.
- Arranging and burning are ONE step: auto-order → once FULL any card holder burns and the preset is applied at that moment; Manual → only the host burns, sending the hand-made order in the same call, within 1 day of the party filling (`MANUAL_GRACE`, scaled by the time unit). After that the host has no say: any card holder may burn with the Time order, so a host cannot stall. UI asks for a second confirmation.
- Host powers, complete list: the params at creation, the Manual order and burn inside that 1-day window, `transferHost`. Nothing else.
- Buying opens after the price's buy wait: voted with each price (0..72 h; at least 1 h for a floor-relative price), host default at creation (the site defaults to 1 h).

## 4. Party governance (binding, on-chain) — Party-style
Borrowed from PartyGovernance.sol: propose → vote → close → execute. No host veto, no rage quit (Statements cannot be split back into Credits).
Time limits: each proposal has a voting window of 1 h, 24 h, 48 h, 72 h or 7 days, chosen by the proposer (party default set by hosts, 48 h). CANCEL_LISTING always runs 24 h. The snapshot stays the block before creation, and the 7-day execution lapse, deadlock clock and buy waits are unchanged by a short window; a floor-relative price still needs a buy wait of at least 1 h. A passed proposal must be executed within 7 days of closing or it lapses.
Vote weight = ERC721Votes checkpoint at creation block − 1 (stops buy-vote-sell and flash loans; Party uses the same offset).
**Pass rule:** 1 card = 1 vote, weight = cards held at proposal creation (snapshot). Passes with YES ≥ 41 of 80 AND zero NO.
- Below floor: a LIST priced below the floor at execution needs YES ≥ 60 (75%), still zero NO.
- Deadlock escape: after 3 NO-blocked proposals of a kind, or 30 days since FULL/assembly without one executing, a new proposal of that kind passes with YES ≥ 54 (2/3) and NO is ignored. Below-floor prices still need 60.
- Dust veto: impossible — cards are whole (ERC-721).
- Executing a proposal supersedes every other pending proposal of the same kind.
Proposal types (closed set, no arbitrary calls):
- Pre-assembly: NOMINATE_ARRANGER (address), APPROVE_ARRANGEMENT (80-id array hash), ASSEMBLE
- Post-assembly: LIST (price rule, duration) · CANCEL_LISTING · DISTRIBUTE

## 4b. Selling — our site only, asks only
- Hosted parties sell in exactly one place: the vault's `buy()` at the approved price, surfaced on the party page. No OpenSea or other marketplace listings, no offers, no auctions: none of these have a code path in the Party contract. House parties: English auction per §4d (design, not implemented).
- Reason: offer-taking and marketplace mechanics invite predatory lowballs aimed at thin or inattentive parties.
- Buyer pays the ask in ETH; the Statement transfers in the same transaction; party moves to SOLD.
- No creator royalty: the contracts pay none (Party and StatementMarket never call `royaltyInfo`; a royalty the Statement contract may declare under ERC-2981 is ignored). The `Sold` events keep their `royalty` field for indexers; it is always 0.
- Platform fee: 1% of the sale price, paid in the same `buy()` transaction to the fee recipient address.
  - Rate is fixed per party when the party is created; it can never rise for an existing party.
- Split of each sale: price → 1% platform fee (+ rounding dust) → remainder to Credit Card holders in 80 equal shares. StatementMarket resale: 1% fee, the rest to the seller.
  Example at 3 ETH: 0.03 platform, 2.97 to holders (0.037125 per Credit Card).
- Floor-relative asks:
  - Floor data is read off-chain (marketplace APIs, since other Statements will trade there) and averaged over 24 h. This is a data input only; we list nothing there.
  - A keeper updates the on-chain ask as the floor rises. The contract accepts only increases: the ask never goes down. Lowering the price requires a new LIST vote.
  - Signed readings: a reading is accepted for 10 minutes after it is issued (real time), and never one older than the last reading the party used. The caller of assemble/execute/raiseAsk still chooses among the readings of those 10 minutes (residual cherry-pick, bounded by 10 minutes of floor movement).
  - A floor-relative price needs a buy wait of at least 1 hour (default at creation and every LIST). Because a reading is only good for 10 minutes, anyone can raise a stale-low ask with a fresher reading before buying opens.
  - Minimum ask (`minAskWei`): clamps floor-relative prices only. It never bounds a Fixed price: 41 votes (60 below the floor) can still set any fixed price.
- Manual prices: any member may propose a LIST at any price, including below the floor (fixed ETH, or floor minus ETH/percent). The floor is shown as context, never enforced. Only the pass rule decides.
- A LIST can be proposed while FULL; it takes effect when the Statement is assembled.
  - The LIST proposal carries an absolute minimum in ETH as the starting ask.
  - Keeper risk: a faulty keeper could only raise the price (blocking sales, never underselling). Members can CANCEL_LISTING and re-list by vote.

## 4d. House-party auction (design; NOT implemented: the Party edit it needs is awaiting approval)
Applies only to the four house parties (hostless, created at deployment). Hosted parties keep asks only, no auctions.
- Burn: needs a valid signed floor reading (fresh + monotonic rules). Reserve = 100 × the Credits floor at the burn. The Statement goes to the factory's HouseAuction contract, which holds it until settlement.
- No end before the first bid: the auction stays open with no deadline until someone bids at or above the reserve. There is **no fallback** to an ask or to price votes, ever: the Statement leaves only through the auction.
- Timer: 24 h (time-unit scaled on testnet) from the first bid. A bid in the last 5 minutes moves the end to bid time + 5 minutes.
- Bids: first bid ≥ reserve; each later bid ≥ current high bid + 0.1 ETH.
- Outbid refunds: the outbid bidder is refunded immediately in the same transaction (push with a gas stipend). If that push fails, the amount is credited to a pull balance the bidder can withdraw at any time, including while the auction is still live. A failing refund never blocks a new bid.
- Settle: after the end, anyone settles once: the Statement to the winner, the winning bid paid into the party and split exactly like a sale (1% fee, the rest 1/80 per card via claims; no royalty).
- During the auction: no price proposals, no raiseAsk, no buy on the party.
- Accounting invariants: auction balance == current high bid + all pull balances; the Statement is always with the auction, the winner, or (before the burn completes) the party.

## 4c. Callers and gas
Every state change is a transaction: someone calls it and pays gas. Rule: once a step is allowed, ANY party member (depositor or Credit Card holder) can call it. No host, arranger, or Statement Maker key is required to move a party forward, so no single absent person can stall it.

| Function | Who may call | When | Gas (measured on a mainnet fork 2026-09-23 unless marked) |
|---|---|---|---|
| factory.createParty(params, ids, proofs) | any Credit holder (becomes host), after approving the factory once | any time | est. ~250k (vault clone; cards share one ERC-721 collection) + the opening deposit |
| factory.deposit(party, ids, proofs) | the Credits' owner, after approving the factory once | OPEN | ~126k per Credit transfer (measured 125,815) + card mint (est. ~60–90k) |
| redeem(cardIds) | the card holder | OPEN or EXPIRED | ~ same as deposit |
| propose(type, args) | any member | per state | est. ~80–150k |
| vote(id, yes) | any member | voting window open | est. ~50–70k |
| execute(id, floor) | **any member** | voting window closed, YES ≥ 41 (60 below floor, 54 in deadlock), NO = 0 | est. ~60–100k |
| assemble(order, floor) | **any card holder** (Manual: host for 1 day after FULL) | FULL | cold burn of 80, mock Statement: 4.88M–5.14M gas before refunds, 3.95M–4.16M paid (Credits.burn 1.94M of it); the real Statement mint is unknown until it ships |
| raiseAsk(floorAttestation) | **any member** | LISTED, floor-relative ask | est. ~60k |
| buy() | anyone (buyer) | LISTED | est. ~100–200k (fee + transfer) |
| claimFor(holder) | **anyone**, pays out to the holder | SOLD | est. ~60k per holder |
| redeemFor(cardIds) | **anyone**, returns each Credit to its card holder | EXPIRED | ~126k per Credit |

Burn cost (paid gas ~4.0M–4.2M, ETH $2,664): ≈ $46–48 at 4.3 gwei, ≈ $211–222 at 20 gwei (mock Statement mint included).

Design consequences:
- Payouts and refunds are push-to-owner and callable by anyone, so a member who never returns still gets their ETH or Credits.
- Voting window: 1, 24, 48, 72 h or 7 days (default 48 h). A proposal can only be executed after the window closes, because a single NO anywhere in the window kills it.
- Floor data is off-chain. raiseAsk takes a floor value signed by the Statement Maker price key; the contract checks the signature and that the new ask is higher. Any member can submit it. Trust point: the key also sets floor-relative prices at the burn and at execution and the 41/60 below-floor threshold (see THREAT_MODEL R-4); it cannot move funds.
- Arranger stall: a Manual host who has not burned within 1 day of FULL loses the order; any card holder burns in Time order.
- Undecided: reimburse the assemble() caller's gas from sale proceeds (largest single cost), or let the caller absorb it.

## 5. Arrangement (the 8×10 order)
Burn returns seeds in call order and the preview renders an ordered sheet. Order is likely part of the work (unverified until Statement contract ships).
Flow (as implemented; no arranger or arrangement votes):
1. The arrangement is chosen at creation: an auto-order preset (default Time: payment time ascending, token id breaks ties) or Manual.
2. Preset: once FULL, any card holder burns; the contract verifies the order is exactly the preset's.
3. Manual: the host burns with any order of exactly the 80 within 1 day of FULL. After that any card holder burns with the Time order (the host too, only as a card holder).
Auto-order presets (as implemented, all ascending by key, ties by token id):
- Number (token id); Time (payment time; on the sealed collection payment times never decrease with id, so Time == token id order)
- Rarity (score from the sealed supply's trait frequencies, rarest first), Colors, Print (most misregistered first), Weight, Eights (most first), Ink (marks ascending)
- Deposit order; Random with a published seed (reproducible)
Sequencing is computed off-chain. The burn only checks it cheaply: Deposit/Random by equality, Number/Time by strictly ascending ids, trait presets by strictly ascending keys from the sealed CreditTraits table (every Credit's traits committed once at deployment, derived from the art contract's own describe() and verified against the live contract for all 122,154 Credits). The art contract is never called at a burn.
Gas (mainnet fork, cold, mock Statement): a burn is 4.9M–5.1M gas before refunds (3.95M–4.16M paid) for every preset, down from 7.4M–12.8M; 1.94M of it is Credits.burn itself.

## 6. Party pages
One page per party: 8×10 frame, member list with Credit Card balances, chat, open proposals and vote tallies, arrangement editor, activity log (deposits, votes, sales).
- Chat: off-chain, hosted on the VPS (SQLite). Sign-In with Ethereum. Post rights: depositors while OPEN, Credit Card holders after FULL. Reading: public or members-only (decision).
- Votes are on-chain (§4); the page shows them and submits them.

## 7. Collection-wide votes (signaling, off-chain)
- Electorate: every Credit, burned or not. Power = Credits held + Credit Cards held across all parties (1 burned Credit = 1 Credit Card = 1 vote).
- Credits contract has no vote checkpoints → power computed by our indexer at a fixed block; snapshot published as a Merkle root so anyone can verify.
- Credit Cards sitting in a Uniswap pool count for no one (the pool contract cannot sign).
- Signed messages, zero gas.
- Binding scope: only pool-level settings (default thresholds, theme calendar). The 1% fee is not subject to these votes. Nothing binds Jack's contracts.

## 8. UI — match jack.art/credits (reference: the public jack.art/credits stylesheet)
- White #fff, ink #111, muted #929292/#999, hairlines 1px #e3e3e3 / #e8e8e8. No other color; the art supplies CMYK.
- One type size: 11px/1.65 SF Mono → Menlo, all uppercase; bold 700 for headings only.
- Header 30px 40px, nav gap 28px; main max-width 1440px; two-column works grid, 64px gap.
- Statement frame: aspect 4:5, 8% padding, 8 cols × 10 rows. Filled slots render the Credit SVG, empty slots are hairline cells.
- Credit detail = 2×2 metadata overlay (Colors / Print / Weight / Eights), toggled like #metadata-toggle.
- Text buttons only (underline when pressed), no fills, no rounded corners.

## 9. Open decisions
- Param edits after deposits exist (§3).
- Chat readable by public or members only.
- Fork Party Protocol governance or build on OZ Governor/ERC721Votes.

## 10. Unknowns
- Statement contract ABI/rules (single-owner? contract callers? order semantics?). Ships ~2026-10-01.
- Whether Party Protocol's mainnet factory is still maintained (repo last commit 2024-12-20).

## 11. Accounts and ownership (implemented in the prototype)
- Sign-in: EIP-4361 message built by the server; its statement IS the terms acceptance (version-stamped). The wallet signs; the server verifies with viem `verifyMessage` (plain wallets and EIP-1271/6492 smart wallets), single-use nonce, 10-minute expiry. The signed message and signature are stored as the record of acceptance.
- Session: HMAC-signed token (address + expiry) in an HttpOnly, SameSite=Strict cookie (Secure in production), 7 days. Stateless: logout clears the cookie but a copied token stays valid until expiry. Every mutating route acts as the session address; request bodies can no longer name an address.
- Terms acceptances (signed message + signature) are stored in their own table, not in the shared state document; sign-in routes are rate-limited and run without the global write lock.
- Party settings lock once anyone other than the host has deposited.
- POSTs from another origin are refused.
- Simulated wallets exist only in dev builds (`/api/auth/dev`), not registered when NODE_ENV=production.
- Ownership: the server follows Credits Transfer events from the snapshot block (every 30 s) and re-reads `ownerOf` on-chain for each Credit at deposit. The real vault counts only Credits it actually receives.

## 12. Buyers and cards
- Statements gallery is buyer-first: For sale (sortable by price or newest, with buy countdowns), Sold, Not listed, Yours. Buy from the Statement page or the party page.
- Credit Cards are ERC-721s and can be listed and traded on OpenSea or any marketplace. Only the Statement is restricted to sale on Statement Maker.
- Resale (StatementMarket): a Statement's owner lists at a fixed ask; the token stays in their wallet. A listing is buyable only while the seller owns the token, the market is approved, the listing has not expired, and the seller has not called `cancelAll()` since. Listings expire: `list` = 30 days, `listFor` = seller-chosen, 1 second to 180 days. A listing cannot see transfers, so a token that leaves and returns to the seller revives its old listing within that listing's expiry unless the seller called `cancelAll()` or re-listed.

## 13. Floor
- Readings every minute from OpenSea, kept 25 h. Host picks per party: 24-hour average (default) or latest reading.
- Source: the Statement collection's own floor as soon as it exists (set STATEMENT_SLUG); until then 80 × the Credits floor.
- Risk: an early Statement market is thin (one or two listings set the floor). The 24-hour average and the 60/80 below-floor rule limit how much one listing can move a party's price.
