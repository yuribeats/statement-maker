# Rolling Pool — Brief

Status: design only. Depends on Jack Butcher's proposed BALANCE (x.com/jackbutcher/status/2107122204882149853, 2026-10-05), which is not deployed and not final. Nothing goes to mainnet until his contracts are public and the user says so.

## Problem

15,350 of 15,597 Credits wallets (snapshot 2026-09-27) hold fewer than 80 Credits. They cannot make a Statement alone, so under Balance they cannot reach Balance alone. Price-vote parties solve this only by selling a whole Statement to one buyer.

## What it is

A pool anyone can deposit into, in any amount, down to one Credit. Every 80 Credits become a Statement, the Statement is surrendered for Balance, and each depositor receives Balance equal to the ratings of the Credits they put in. Then the next pool opens.

No host, no price votes, no buyer needed.

## Two flows

The deposit screen offers both. Same Credits approval (the PartyFactory), same Credit Card receipt (one ERC-721 per deposited Credit; everything follows the card).

| | A. Deposit to an existing pool (current) | B. Deposit to a rolling pool (new) |
|---|---|---|
| Who opens it | A host, with params and filters | Nobody; the next pool is always open |
| Which Credits | Must pass the party's filters | Any Credit |
| Arrangement | Host's preset or Manual | Fixed default preset |
| Outcome | Statement is sold for ETH | Statement is surrendered for Balance |
| Price | Voted (41/80, zero NO; 60 below floor) | None |
| Payout | 80 equal shares of sale ETH, minus 1% | Balance = your Credits' ratings, minus 1% |
| Timing | Waits for a vote and a buyer | Immediate once the pool fills and burns |
| Leaving early | Redeem card while OPEN | Withdraw card while unfilled |
| Spec | SPEC.md §2–4b | This brief |

### Flow A — existing pool (unchanged)

1. Pick a party → deposit Credits that pass its filters → receive Credit Cards.
2. Party fills → host's arrangement → burn → Statement in the vault.
3. Members vote a price → buyer pays on our site → card holders claim 1/80 of net ETH each.

### Flow B — rolling pool

1. Deposit. A member deposits N Credits into the open pool (first come, first served by slot) and receives one Credit Card per Credit. The card records the Credit's rating; its holder gets that Balance.
2. Fill. At 80 Credits the pool closes; a new one opens immediately. Overflow from a deposit goes into the new pool.
3. Burn. Anyone can trigger the burn of a full pool (keeper or member). Arrangement = fixed default preset; layout does not change the rating and the Statement is locked next.
4. Surrender. The pool surrenders the Statement for Balance (= the Statement's rating).
5. Payout. Each card holder is credited Balance = sum of their Credits' ratings, minus the 1% fee. Members claim (pull), so each pays their own gas when they choose.
6. Artwork. Per Jack (DM 2026-10-05): any address can claim a Balance NFT, and a contract can call the claim. The artwork is separate from receiving Balance. The pool's claim step can mint each depositor's artwork in the same transaction (skip if they already have one). The pool itself does not claim one.

## Rules (Flow B)

- Payout is by rating, not equal shares. Statement rating = sum of its Credits' ratings, so the split is exact.
- Fee: 1%, taken in Balance at surrender.
- Withdraw: a depositor may pull their Credits back any time before the pool fills. Once full, it is irreversible.
- One contract per pool (existing PartyFactory pattern), so each locked Statement sits in a contract that lists its depositors on-chain.
- Unclaimed Balance stays in the pool contract and takes on the pool's blended color.

## Colors (as Jack's diagram implies, verified against his numbers)

Each wallet stores one CMYK mix. Receiving blends by amount; sending leaves the sender's mix unchanged. A member claiming from the pool receives the Statement's blended mix, not the colors of the Credits they deposited.

## Cost (estimates at 1.07 gwei, ETH $2,701, 2026-10-05)

- Burn of 80 Credits: up to ~14.6M gas (measured, open + deposit 80).
- Surrender: unknown until Jack's contract exists.
- Claim per member: ~55k gas for Balance (~$0.16); artwork claim extra, cost unknown until his contract exists.
- Push-paying all 80 in one tx: ~9.6M gas (~$28); rejected in favour of pull claims.

## Open questions for Jack

1. Can a contract call surrender?
2. Where does the locked Statement live: the surrendering wallet or the Balance contract?
3. ~~Does a contract get a soulbound artwork?~~ Answered: the artwork is claimed, not automatic; any address can claim, contracts can call it. Still open: can the claim mint to an address other than the caller?
4. Is each Credit's rating readable on-chain (needed to split by rating)? The post says ratings are fixed; confirm.
5. He said he holds 1.25% of eventual Balance supply. His 378 Credits (2026-09-26) = 164,354 of a 53,716,910 maximum = 0.31%. 1.25% = exactly 1/80. Is there an artist share minted on every surrender? If so, depositors net ~97.8% of rating after our 1%.
6. Proposal: `surrenderTo(recipients, amounts)` paying depositors directly, each tinted with their own Credits' colors and recorded on the locked Statement. Preserves provenance; removes the pool as a middleman for Balance and the artwork.

## Risks

- Balance price is unknown. If it trades low, depositing can be worth less than selling Credits outright. The pool page shows both numbers before deposit.
- A pool can sit unfilled. Depositors can withdraw; no time lock.
- Audit findings T-1..T-6 on the existing contracts must be fixed first.

## Build order

1. Mock Balance contract on Sepolia matching the proposal (rating → ERC-20, per-wallet CMYK mix, soulbound artwork).
2. RollingPool contract + factory + tests (fill, overflow, withdraw, burn, surrender, claim, rating split, fee).
3. Pool page: live fill bar, your slots and ratings, expected Balance, Balance vs sell comparison, claim.
4. Swap mock for Jack's contract when public; re-test on a mainnet fork.
