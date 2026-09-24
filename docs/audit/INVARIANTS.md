# Statement Maker: invariants

Derived from SPEC.md v0.8 and `contracts/src/` at `5040009`. Each invariant lists where the code enforces it and which tests cover it.

Test status when written (2026-09-24 UTC). Other workstreams are adding tests concurrently, so re-check before the engagement.
- **Present:** `test/Lifecycle.t.sol` (mainnet fork), `test/LocalSmoke.t.sol`, `test/unit/{Factory,Deposit,Redeem,Assemble,Floor}.t.sol`, `test/diff/{PresetsDiff,TraitsDiff}.t.sol`, `test/halmos/CreditKeys.halmos.t.sol`, and `test/invariant/{Handler,HostileActor}.sol` (handlers only, no invariant suite yet).
- **Planned:** `test/invariant/*` stateful suites, `test/unit/` for Governance/Buy/Claim/Cards, and `test/halmos/` for Party accounting.
- "GAP" marks an invariant with no test yet.

## A. Custody and conservation of Credits

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-1 | In OPEN/FULL/EXPIRED, every id in `_order` is owned by the party, and `cardOfCredit[id] ≠ 0` iff `id ∈ _order`. | `deposit` L201-206 (transfer, then `ownerOf` check); `_redeem` L228-234 | unit/Deposit `test_deposit_mintsCardsAndRecords`, unit/Redeem `test_redeem_compactsDepositOrder`; planned invariant suite |
| I-2 | `_order.length ≤ 80`, and `_order` has no duplicates. | `deposit` L190-196 (remaining bound, `cardOfCredit` duplicate check) | unit/Deposit `test_over80_rejected`, `test_duplicateInOneCall`, `test_alreadyInParty` |
| I-3 | Before assembly, the live cards of the party and the Credits in `_order` are in bijection: `creditOfCard[cardOfCredit[id]] == id`, and `cardsOutstanding == _order.length`. | `deposit`, `_redeem` | unit/Deposit, unit/Redeem; planned invariant |
| I-4 | Credits are never burned before assembly. The only path that grants the Statement contract approval is `assemble`, and approval is revoked in the same call. | `assemble` L279-283; no other `setApprovalForAll` or `burn` call exists | unit/Assemble `test_effects`; GAP: an assertion that `isApprovedForAll(party, statement) == false` after every call |
| I-5 | Redemption is possible only in OPEN or EXPIRED, only by or for the current card holder, and burns the card. | `_redeem` L225-233, `redeemFor` L220-221 | unit/Redeem `test_redeem_lockedWhenFull`, `test_redeem_lockedWhenAssembled`, `test_redeem_allowedWhenExpired_fromFull`, `test_redeem_followsTheCard`, `test_redeemFor_*` |
| I-6 | After EXPIRED, every deposited Credit can be returned to its card holder, and nobody can block it (push by anyone). | `redeemFor` | unit/Redeem `test_redeemFor_paysCurrentHolder_evenContract` |
| I-7 | Deposits pull only from the factory's `msg.sender`. Users approve only the factory; the factory moves a Credit only from its own caller and only into one of its parties, and a party records a deposit only when called by the factory and only for Credits it holds. A stray Credit sent straight to a party can never be recorded. | `PartyFactory.deposit`/`createParty` (`transferFrom(msg.sender, party, id)`), `Party.onDeposit` (factory only, `ownerOf == party`) | unit/Deposit `test_notOwner`, `test_notApproved`; unit/Fixes `test_onDeposit_factoryOnly_strayCannotBeClaimed`, `test_factoryDeposit_rejectsUnknownParty`, `test_opening_requiresApprovalOfFactory` |
| I-8 | After assembly, none of the 80 deposited ids exists (burned), `burnOrderHash == keccak256(order)`, and the party owns `statementId`. | `assemble` post-burn check | Lifecycle, unit/Assemble, unit/Findings3 `test_assemble_statementKeepsCredits_rejected`, invariant `PartyInvariants` |

## B. Status machine

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-9 | `status()` is monotone along OPEN→FULL→ASSEMBLED→SOLD and OPEN/FULL→EXPIRED. The only backward edge is FULL→OPEN, which is impossible because redemption is locked in FULL. EXPIRED, SOLD, and ASSEMBLED-without-a-buyer have no exit to OPEN/FULL. | `status()` L172-177, guards in every mutator | unit/Assemble `test_twice`, `test_afterDeadline`, unit/Deposit `test_afterAssembled_rejected`; planned invariant |
| I-10 | `assembled` implies FULL was reached before the deadline (`fullAt ≠ 0`, `fullAt ≤ deadline`). | `assemble` requires FULL | unit/Assemble `test_notFull`, `test_afterDeadline` |
| I-11 | `sold` implies `assembled`, and `sold` is set at most once. | `buy` requires ASSEMBLED | GAP (planned unit/Buy) |

## C. Cards and voting weight

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-12 | For each party P: Σ over accounts of `heldNow(P, a)` equals the number of live cards with `partyOf == P`, which is ≤ 80. | `CreditCards._update` L65-77 | planned invariant (`test/invariant/Handler.sol` exists) |
| I-13 | `heldAt(P, a, b)` for `b < block.number` never changes after block `b`. Snapshots are immutable. | OZ `Checkpoints.Trace208` push-only; `heldAt` rejects `b ≥ block.number` | GAP |
| I-14 | Only the factory registers parties. Only a registered party mints. Only the card's own party burns it. | `registerParty` L37-40, `mint` L42-47, `burn` L50-53 | unit/Factory `test_implementation_notRegisteredParty`; GAP: direct `mint`/`burn` from a non-party |
| I-15 | A card of party P can never redeem, claim, or vote in party Q. | `_redeem`/`claim` check `partyOf`; weights are keyed by party | unit/Redeem `test_redeem_cardOfAnotherParty`, `test_redeemFor_foreignCardRejected` |
| I-16 | For any proposal, `yes + no ≤` total weight at its snapshot (≤ 80). Each address counts once with its snapshot weight, and changing a vote moves weight rather than adding it. | `_vote` L371-380 | GAP (planned governance unit and invariant) |

## D. Governance

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-17 | A proposal executes at most once, only after `endsAt`, only within 7 days after `endsAt`, and only if its epoch equals `priceEpoch`. | `execute` L395-398 | GAP |
| I-18 | Pass rule. Non-deadlock proposals need `yes ≥ 41` and `no == 0`. LISTs below the attested floor need `yes ≥ 60`. Deadlock proposals need `yes ≥ max(need, 54)`, and NO is ignored. | `needFor` L385-390, `execute` L408-409 | GAP |
| I-19 | Every price decision (execute or assemble) increments `priceEpoch`, so at most one proposal from any epoch executes. | L275, L412 | GAP |
| I-20 | Vote weight equals card balance at `block.number − 1` at creation. Cards acquired in the creation block or later carry no weight on that proposal. | `propose` L354, `_vote` L373 | GAP |
| I-21 | No proposal can do anything except set `ask`/`pendingPrice` or clear `ask`. There are no arbitrary calls. | closed set in `execute` L414-425 | by inspection |
| I-22 | Per party, `_proposals.length ≤ 256`, and each address has ≤ 3 proposals open at once. | `propose` L345-347 | GAP. **See THREAT_MODEL R-1: the cap can be exhausted.** |

## E. Pricing and sale

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-23 | The Statement leaves the party only through `buy`, only to `msg.sender`, and only at the current `ask`. | `buy` L489; no other Statement transfer call exists | Lifecycle full cycle; GAP: an exhaustive negative test |
| I-24 | `buy` is impossible earlier than 24 h after the ask most recently went live (by assemble or by an executed LIST). `raiseAsk` does not reset the timer. | `buy` L468 | Lifecycle (`"not open yet"`) |
| I-25 | The ask never decreases except through an executed LIST (new vote) or CANCEL. `raiseAsk` only raises. | `raiseAsk` L458 | GAP |
| I-26 | The buyer never pays more than `min(msg.value, maxPrice)`. The excess is refunded in the same transaction. | `buy` L470, L490-493 | Lifecycle (refund asserted) |
| I-27 | Conservation per sale: `fee + dust + 80 × perCard == price`, `fee == 1% × price`, `dust < 80`; no royalty is paid (a declared ERC-2981 royalty is ignored). | `buy` / `_sell` | Lifecycle; unit/Sale `test_split_declaredRoyaltyIgnored`, `test_split_noRoyalty_withDust`; unit/Fixes `test_royalty_wellFormedAnswerNeverPaid`; invariant Handler I5 (declared 0..20%, must be 0 paid) |
| I-28 | Solvency: `address(party).balance ≥ Σ owed[·] + perCard × (live cards of the party)` at all times after SOLD. Before SOLD, the party's accounted ETH is 0. | `buy`, `claim`, `withdraw` | Lifecycle (`balance == 0` after all claims); planned invariant |
| I-29 | Each card claims at most once (it is burned on claim). Only the holder claims. | `claim` L503-506 | Lifecycle; GAP: double-claim and foreign-card negative tests |
| I-30 | The fee rate is fixed for every party of a factory (`FEE_BPS` is constant; `feeRecipient` is immutable). | PartyFactory L19-21 | unit/Factory `test_ctor_wiring` |
| I-31 | Direct ETH transfers revert (`receive`). Unsolicited ERC-721 safe transfers are rejected, except the Statement mint during `assemble`. | L333-336, L561-563 | unit/Assemble `test_onERC721Received_*` |

## F. Arrangement

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-32 | The burn order is a permutation of exactly the 80 deposited ids. | `_checkPermutation` L294-306 | unit/Assemble `test_wrongLength`, `test_repeats`, `test_notDeposited`, `test_manual_stillChecksPermutation` |
| I-33 | For an auto preset, exactly one order is accepted: strictly ascending ids (Number, Time), strictly ascending `CreditTraits.keys` (trait presets), the stored order (Deposit), or `shuffle(_order, seed)` (Random); always a permutation of the deposits. | `CreditKeys.verifyOrder` | unit/Assemble, unit/ManualGrace, unit/Fixes `test_verifyOrder_sameRevertDataAsParty`, unit/PermutationFuzz (Manual path vs an independent permutation definition), fork PresetsFork |
| I-34 | On-chain preset order equals the site's preset order (`server.mjs PRESETS`) and the original describe()-based order. | committed key table | diff/PresetsDiff (500 random + adversarial sets per preset: site == table == reference), keytable/KeyTable (all ids with verify.sh; 2,000 sampled + 320 house ids on a fork) |
| I-35 | Every Credit in the sealed supply has a key under every trait preset. | CreditTraits covers ids 1..122,154; every entry decodes to valid ranks | keytable/KeyTable `test_full_tableEqualsReferenceKeys` (all ids × presets, with verify.sh) |
| I-36 | Manual order: only `host` can assemble, and only until `fullAt + MANUAL_GRACE` (1 day, time-unit scaled); after that any current card holder, with the Time order. Auto: only a current card holder. | `assemble` | unit/ManualGrace (all), unit/Assemble `test_manual_hostOnly_anyPermutation`, `test_nonCardHolder_autoPreset`; invariant Handler `assemble` model |

## G. Floor oracle

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-37 | A floor value is used only if signed by `floorSigner` over `(floorWei, party.floorMode, issuedAt)` in this factory's domain and chain, `0 ≤ now − issuedAt ≤ 1h`, and `floorWei > 0`. | `_floor` L537-542, `isValidFloor` | unit/Floor (all 13 tests) |
| I-38 | Fixed prices never depend on the floor at assembly. (Execution of a Fixed LIST still requires a valid floor; see THREAT_MODEL R-5.) | `_resolve` L544-547 | unit/Assemble `test_fixedDefault_ignoresFloorArg` |
| I-39 | A resolved price is always > 0. | `_resolveWith` L553; `_checkPrice` for Fixed | unit/Assemble `test_floorDelta_nonPositiveRejected` |

## H. Initialization

| # | Invariant | Enforced | Coverage |
|---|---|---|---|
| I-40 | The implementation and every clone can be initialized exactly once, by the factory, within `createParty`, which also registers the clone. | `_disableInitializers`, `initializer`, `createParty` L38-44 | unit/Factory `test_clone_cannotReinitialize`, `test_implementation_cannotInitialize`, `test_create_ok_registersAndRecords` |
| I-41 | Params stay within the bounds in ARCHITECTURE.md §3 and never change after initialization. | `initialize` L150-156; no setters | unit/Factory `test_create_*` |
| I-42 | The burn does bounded work in the number of proposals: at most `BURN_CANDIDATES` (8) candidate judgements plus the executed-while-FULL price, whatever the proposal count. | `_burnPrice`, `_vote` candidate list | unit/ReAudit `test_M1_spam1650_burnStillUnderCap`, `test_M1_spam5000_burnGasUnchanged`, `test_M1_candidatesBounded` |
| I-43 | A voted price goes live at the burn only if it passes at the burn's own floor reading with its final tally (below floor: 60; deadlock: 54; zero NO unless deadlock). | `_burnPrice`/`_passesHere` | unit/ReAudit `test_M2_*`, unit/Findings3 `test_H2_*`, invariant Handler `assemble` model |
