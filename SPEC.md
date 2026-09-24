# STATEMENT MAKER — spec draft v0.8 (2026-09-23)

Model: PartyDAO (Party Protocol). Facts in RESEARCH.md.

## 1. Objects
- **Party**: one group assembling one Statement. Has hosts, params (§3), 80 slots, a deadline, a page with chat.
  "Sheet" now means only the 8×10 artwork layout.
- **Party token**: one ERC-20 per party, deployed by a factory as a minimal clone. Supply exactly 80 × 10^18 (one whole token per Credit; 18 decimals so fractions trade).
  Freely transferable. Anyone may pair it on Uniswap; the tool links to "create pool" but does not seed liquidity.
  Balance = vote weight in that party = share of any proceeds.
  Votes: OpenZeppelin ERC20Votes (checkpointed) with self-delegation by default, so holders never need a separate "delegate" transaction.
- **Vault**: holds deposited Credits, then the assembled Statement.

## 2. Party lifecycle
| State | Enters when | Allowed |
|---|---|---|
| OPEN | host opens party | deposit (must meet the party's params); withdraw your own Credit. Deposits are recorded, no token yet |
| FULL | 80th deposit | 80 tokens minted, 1 per Credit to each depositor. Withdraw closed. Arrangement phase (§5) |
| ASSEMBLED | vault calls Statement contract with the approved order; Credits burned | governance on the Statement |
| LISTED / SOLD | passed LIST proposal | anyone buys at the ask. No offers, ever |
| DISTRIBUTED | sale settles | token holders redeem tokens for ETH pro rata (tokens burned on redeem) |
| EXPIRED | deadline passes unfilled or unassembled | every depositor withdraws their original Credit; any minted tokens are void |

Tokens are minted at FULL, not at deposit: a token that could be sold while OPEN would detach from the Credit it stands for and break withdrawals.
Credits are never burned before assembly. If the Statement contract rejects contract callers, nothing is lost: parties expire and Credits return.

## 3. Hosts and party params
- The address that opens a party is its first host. Hosts can add or remove hosts (last host cannot leave without naming a replacement).
- Host privileges:
  - Set and edit params while OPEN (see below).
  - Set the deadline; close a party early (triggers EXPIRED, everyone withdraws).
  - Open proposals.
  - Moderate the party chat.
- Params (set by hosts):
  - **Minimum deposit**: fewest Credits one depositor may add. Final slots are exempt: when fewer slots remain than the minimum, the deposit may equal the remainder, so the party can always reach exactly 80.
  - **Target sell price**, one of two modes:
    - Fixed: X ETH.
    - Floor-relative: floor + X, where X is an ETH amount or a percent (host's choice). The floor source is the Statement collection floor; until Statements trade, Credits floor × 80.
    Shown on the party page. Once assembled, it pre-fills the first LIST proposal (members still vote).
  - **Eligibility filters**: Colors (plate combo), Print, Weight, Eights, marks range, rarity rank range, token-number range. Filters combine with AND.
- Filter enforcement: our indexer turns the filters into the list of eligible Credit ids and publishes its Merkle root; deposit requires a membership proof. Anyone can check the list: every trait is recomputable from the chain (CreditArt.describe(seed, paidAt) is public). Rarity rank comes from OpenSea's OpenRarity calculation and is the one input not on-chain.
- Param edits after deposits exist: undecided (options: allowed freely, allowed only if they do not disqualify Credits already deposited, or locked at first deposit).

## 4. Party governance (binding, on-chain) — Party-style
Borrowed from PartyGovernance.sol: propose → vote → passThresholdBps → executionDelay → execute; host veto; rage quit.
Vote weight = ERC20Votes checkpoint at the proposal's creation block (stops buy-vote-sell, which matters now that tokens trade).
**Pass rule:** YES weight > 50% of total supply (more than 40 of 80 tokens) AND NO weight = 0 when voting closes. Any NO vote kills the proposal. Hosts vote with their tokens like everyone else; host privileges are in §3.
Guard options (undecided):
- Dust veto: with 18 decimals, 0.000000000000000001 token can block every proposal. Option: a NO counts only from holders of ≥ 1 whole token at the snapshot.
- Permanent deadlock: one holder can block every sale forever, leaving the Statement stuck in the vault. Option: after N failed proposals or T days, the same proposal can pass by supermajority (e.g. 2/3) despite NO votes; or dissenters may redeem at the listed price.
Proposal types (closed set, no arbitrary calls):
- Pre-assembly: NOMINATE_ARRANGER (address), APPROVE_ARRANGEMENT (80-id array hash), ASSEMBLE
- Post-assembly: LIST (price rule, duration) · CANCEL_LISTING · DISTRIBUTE

## 4b. Selling — our site only, asks only
- The party sells in exactly one place: the vault's `buy()` at the approved price, surfaced on the party page. No OpenSea or other marketplace listings. No offers. No auctions. None of these have a code path in the contracts.
- Reason: offer-taking and marketplace mechanics invite predatory lowballs aimed at thin or inattentive parties.
- Buyer pays the ask in ETH; the Statement transfers in the same transaction; party moves to SOLD.
- Artist royalty: honored on every sale, paid out of the price in the same `buy()` transaction, before members' proceeds.
  - Lookup order: the Statement contract's own ERC-2981 `royaltyInfo(tokenId, price)`; if absent, the Royalty Registry engine on mainnet (0x0385603ab55642cb4Dd5De3aE9e306809991804f, verified live on chain), which also covers Manifold/Rarible-style royalty settings and registry overrides.
  - Read at sale time, not at assembly, so a later change by the artist is followed.
  - Hard cap on the total paid (e.g. 25%) so a faulty or hostile royalty lookup cannot drain the sale.
  - Credits itself has none: no ERC-2981 (supportsInterface false) and the engine returns no recipients.
- Platform fee: 1% of the sale price, paid in the same `buy()` transaction to the fee recipient address.
  - Rate is fixed per party when the party is created; it can never rise for an existing party.
- Split of each sale: price → artist royalty (per lookup) → 1% platform fee → remainder to token holders pro rata.
  Example at 3 ETH with a 5% royalty: 0.15 artist, 0.03 platform, 2.82 to holders (0.03525 per token).
- Floor-relative asks:
  - Floor data is read off-chain (marketplace APIs, since other Statements will trade there) and averaged over 24 h. This is a data input only; we list nothing there.
  - A keeper updates the on-chain ask as the floor rises. The contract accepts only increases: the ask never goes down. Lowering the price requires a new LIST vote.
- Manual prices: any member may propose a LIST at any price, including below the floor (fixed ETH, or floor minus ETH/percent). The floor is shown as context, never enforced. Only the pass rule decides.
- A LIST can be proposed while FULL; it takes effect when the Statement is assembled.
  - The LIST proposal carries an absolute minimum in ETH as the starting ask.
  - Keeper risk: a faulty keeper could only raise the price (blocking sales, never underselling). Members can CANCEL_LISTING and re-list by vote.

## 4c. Callers and gas
Every state change is a transaction: someone calls it and pays gas. Rule: once a step is allowed, ANY party member (depositor or token holder) can call it. No host, arranger, or Statement Maker key is required to move a party forward, so no single absent person can stall it.

| Function | Who may call | When | Gas (measured on a mainnet fork 2026-09-23 unless marked) |
|---|---|---|---|
| openParty(params) | any Credit holder (becomes host) | any time | est. ~250k (clone ERC-20 + vault) |
| deposit(ids) | the Credits' owner | OPEN | ~126k per Credit (1 transfer measured: 125,815) |
| withdraw(ids) | the depositor | OPEN or EXPIRED | ~ same as deposit |
| propose(type, args) | any member | per state | est. ~80–150k |
| vote(id, yes) | any member | voting window open | est. ~50–70k |
| execute(id) | **any member** | voting window closed, YES > 40, NO = 0 | est. ~60–100k (LIST, NOMINATE) |
| submitArrangement(order) | the arranger (host by default) | FULL | est. ~2M (stores 80 ids) |
| assemble() | **any member** | arrangement approved + Statement contract open | burn of 80 measured: 2,576,314, plus the Statement contract's own mint (unknown until it ships) |
| raiseAsk(floorAttestation) | **any member** | LISTED, floor-relative ask | est. ~60k |
| buy() | anyone (buyer) | LISTED | est. ~150–250k (royalty lookup + fee + transfer) |
| claimFor(holder) | **anyone**, pays out to the holder | SOLD | est. ~60k per holder |
| returnCredits(depositor) | **any member**, returns to the depositor | EXPIRED | ~126k per Credit |

Cost at 0.077 gwei and ETH $2,688: one transfer ≈ $0.03; burn of 80 ≈ $0.53. At a 10 gwei spike: ≈ $3.40 and ≈ $69.

Design consequences:
- Payouts and refunds are push-to-owner and callable by anyone, so a member who never returns still gets their ETH or Credits.
- Voting window: fixed (default 48 h). A proposal can only be executed after the window closes, because a single NO anywhere in the window kills it.
- Floor data is off-chain. raiseAsk takes a floor value signed by the Statement Maker price key; the contract checks the signature and that the new ask is higher. Any member can submit it. Trust point: the key can only ever raise an ask, never lower one or move funds.
- Arranger stall: if the arranger does not submit within N days of the party filling, members can elect another by vote.
- Undecided: reimburse the assemble() caller's gas from sale proceeds (largest single cost), or let the caller absorb it.

## 5. Arrangement (the 8×10 order)
Burn returns seeds in call order and the preview renders an ordered sheet. Order is likely part of the work (unverified until Statement contract ships).
Flow:
1. The first host is the arranger by default. Members may replace them with a NOMINATE_ARRANGER vote; the elected arranger then takes over.
2. Arranger drags Credits in the 8×10 editor or starts from an auto-order preset, then submits.
3. Group votes APPROVE_ARRANGEMENT. The approved 80-id array is stored in the vault; ASSEMBLE can only use that array.
Auto-order presets:
- Token number (ascending / descending)
- Payment time (timestampOf)
- Rarity (OpenRarity rank from OpenSea, which already computes it for this collection)
- Trait sort: Colors, Print, Weight, Eights, marks (ink density)
- Gradient: by marks, light → dark
- Random with a published seed (reproducible)

## 6. Party pages
One page per party: 8×10 frame, member list with token balances, chat, open proposals and vote tallies, arrangement editor, activity log (deposits, votes, sales).
- Chat: off-chain, hosted on the VPS (SQLite). Sign-In with Ethereum. Post rights: depositors while OPEN, token holders after FULL. Reading: public or members-only (decision).
- Votes are on-chain (§4); the page shows them and submits them.

## 7. Collection-wide votes (signaling, off-chain)
- Electorate: every Credit, burned or not. Power = Credits held + party tokens held across all parties (1 burned Credit = 1 token = 1 vote).
- Credits contract has no vote checkpoints → power computed by our indexer at a fixed block; snapshot published as a Merkle root so anyone can verify.
- Tokens sitting in a Uniswap pool count for no one (the pool contract cannot sign).
- Signed messages, zero gas.
- Binding scope: only pool-level settings (default thresholds, theme calendar). The 1% fee is not subject to these votes. Nothing binds Jack's contracts.

## 8. UI — match jack.art/credits (copy in research/jack-credits-style.css)
- White #fff, ink #111, muted #929292/#999, hairlines 1px #e3e3e3 / #e8e8e8. No other color; the art supplies CMYK.
- One type size: 11px/1.65 SF Mono → Menlo, all uppercase; bold 700 for headings only.
- Header 30px 40px, nav gap 28px; main max-width 1440px; two-column works grid, 64px gap.
- Statement frame: aspect 4:5, 8% padding, 8 cols × 10 rows. Filled slots render the Credit SVG, empty slots are hairline cells.
- Credit detail = 2×2 metadata overlay (Colors / Print / Weight / Eights), toggled like #metadata-toggle.
- Text buttons only (underline when pressed), no fills, no rounded corners.

## 9. Open decisions
- Pass rule guards: dust-veto minimum, deadlock escape (§4).
- Param edits after deposits exist (§3).
- Chat readable by public or members only.
- Fork Party Protocol governance or build on OZ Governor/ERC20Votes.

## 10. Unknowns
- Statement contract ABI/rules (single-owner? contract callers? order semantics?). Ships ~2026-10-01.
- Whether Party Protocol's mainnet factory is still maintained (repo last commit 2024-12-20).
