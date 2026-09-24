# Statement Maker: audit packet

For an independent auditor who has not seen this project. Self-contained; every claim cites code or a commit.
Written 2026-09-24 against `main` HEAD `165a33e` (2026-09-24 14:10 -0400). Line numbers are **at `165a33e`** unless
marked "WT" (working tree).

- Repo: https://github.com/yuribeats/statement-maker (public). Live preview: https://statement-maker.vercel.app
- Local checkout: `~/Desktop/Projects/statement-maker-2026-09-23`

> **The tree is moving.** At the time of writing, other agents had uncommitted edits in `contracts/src/`
> (`CreditKeys.sol`, `Party.sol`, `PartyFactory.sol`, `interfaces/IExternal.sol`, `testnet/*`, new
> `CreditTraits.sol`) and new untracked files (`contracts/test/gas/Breakdown.t.sol`, `contracts/x-ray*`,
> `contracts/.solidity-auditor/`). Before starting, ask for a tagged commit and audit that. Run
> `git status --short && git log --oneline -5` to see what has landed since this packet.

> **Older audit docs are partly stale.** `docs/audit/{SCOPE,ARCHITECTURE,INVARIANTS,THREAT_MODEL}.md` were written at
> `5040009` and patched since; `contracts/x-ray/x-ray.md` is at `36be269` (before royalty removal). Where they disagree
> with this packet or the code, the code wins. Known stale points are listed in §6.4.

---

## 1. What it is

Jack Butcher's Credits (122,154 sealed ERC-721s at `0x97630aa70ab14ed9883b41dafccbc11349723043`) can be burned 80 at a
time into one Statement through Jack's Statement contract, which is **not published yet**. Most holders own fewer than
80. Statement Maker pools Credits from strangers into a **party**: each deposited Credit mints one Credit Card
(ERC-721) that carries the vote, the right to redeem the Credit before the burn, and 1/80 of the sale. The party burns
80 into one Statement, sells it, and splits the proceeds (1% fee, the rest in 80 equal shares; no creator royalty).

### 1.1 Deployment status (read this first)

| Item | Status | Evidence |
|---|---|---|
| Website | **Preview.** All party, deposit, vote, burn, auction and sale actions are **off-chain records** in Postgres. Nothing moves Credits or ETH. | `README.md` "Status: preview"; `lib/core.mjs:1391` "Simulated until the Statement contract is public" |
| Mainnet contracts | **None deployed.** `DeployMainnet.s.sol` exists and has never run. | `contracts/script/DeployMainnet.s.sol:9`; `scripts/deploy-mainnet.sh` refuses without `CONFIRM_MAINNET=yes` |
| Sepolia | v1 deployed at `9fcf7f7` (2026-09-24 02:10) with **older rules**. Later contract commits not on Sepolia: `9ef9442`, `7a9766e` (audit-3 source fixes), `47acfeb`, `5e49bf4`, `0fd5a0d`, `7c33264`, `8a98007`, `f06b3c5`. `/sepolia*` now redirects home (`vercel.json` redirects). | `web3/sepolia-addresses.json`; `git log 9fcf7f7..HEAD -- contracts/src` |
| House-party auction, hostless creation, launch lock | **Not implemented in any contract.** Design only, SPEC §4d (`SPEC.md:83-92`). The `Party.sol` edit it needs was denied by the tool's auto-mode and awaits approval. The site simulates it off-chain. | `SPEC.md:83` heading; no auction code under `contracts/src/` |

### 1.2 Two product modes (site)

Mode is decided server-side by `openingUnlocked()` (`lib/core.mjs:655`): true once any house party has
`assembled && sold`. The client mirrors it with `launchPhase() = !stats.partiesUnlocked` (`public/app.js:1284`).

**LAUNCH mode** (current production state)
- Exactly four hostless house parties, the "Minutes", seeded by `seedMinutes()` (`lib/core.mjs:651-676`):

  | Party | Credit ids (eligibility filter) | Minute of purchase (paidAt), 2026-09-21 UTC |
  |---|---|---|
  | `minute-1349` | #21098–#21177 | 13:49 |
  | `minute-1505` | #25998–#26077 | 15:05 |
  | `minute-1528` | #27664–#27743 | 15:28 |
  | `minute-1622` | #32714–#32793 | 16:22 |

  These are the four minutes of the Credits mint in which exactly 80 Credits were bought (by `paidAt`). Params:
  `minDeposit 1`, arrangement `Time`, `floorMode avg24h`, deadline 60 days from seeding, no host
  (`hosts: []`, `lib/core.mjs:669-673`). Purchase (Time) order equals ascending id on the sealed collection; the
  in-flight `CreditKeys` change relies on this and cites a full-supply check in `test/keytable`, **which is not in
  the tree yet** (WT `CreditKeys.sol` header).
- Once FULL, any card holder burns (`lib/core.mjs:1411-1413`). Burning starts an **English auction**
  (`lib/core.mjs:1417-1423`, constants `:533-546`):
  - Reserve = 100 × the **24 h average Credits floor** at the burn (`openingWei`, `:537`; `floorFor(p).credit`).
    No reading → no burn.
  - Steps of 0.1 ETH (`AUCTION_STEP`); first bid ≥ reserve.
  - **No end and no fallback before the first bid** (`auctionDue` returns `Infinity` while `endsAt == null`, `:543`).
    The first bid starts a 24 h timer; a bid in the last 5 minutes moves the end to bid time + 5 minutes
    (`:1486-1489`).
  - Bids must be covered by the bidder's mainnet ETH balance, read before the lock (`:1648-1651`); cap 10,000 ETH
    (`BID_MAX_WEI`, `:535`). Balance is checked, **not escrowed** (preview).
  - Anyone settles after the end (`:1493-1507`): Statement to the high bidder, split like a sale.
  - No price proposals on house parties while FULL or auctioning (`:1311`); no `buy` while an auction is live
    (`:1510`).
- Full-mode pages and APIs 404 in production (`:940`): `wallet`, `users`, `eligible`, `holders`, party list, and any
  non-house party. Starting a party returns 403 (`:1233`). Statement resale listing returns 403 (`:1197`). Deposit
  pre-check refuses non-house parties (`:1586`). **These gates are skipped when `DEV` is true** (`NODE_ENV` not
  `production`).
- Separate launch terms/rules versions (`TERMS_LAUNCH 2026-09-24.L8`, `RULES_LAUNCH 2026-09-24.L9`, `:25`).
- **Unlock:** the site switches to FULL mode when a Minute auction settles with a winner (`:655`).

**FULL mode**
- Anyone holding a Credit starts a hosted party (host = creator). Params, presets (Deposit, Number, Time, Rarity,
  Colors, Print, Weight, Eights, Ink, Random) or Manual (host orders by hand, host states the metric).
- Price governance: 41/80 YES and zero NO; 60 if below the floor; 54 with NO ignored under deadlock.
- Sells only on Statement Maker at the party's ask ("store-only": no offers, auctions, or marketplace listings for a
  party's Statement). Holders of a sold Statement may list it on StatementMarket (1% fee, asks only).

---

## 2. Scope

### 2.1 Contracts (`contracts/src/`, solc 0.8.28, cancun, via-IR, optimizer 200; `contracts/foundry.toml`)

LOC at `165a33e` (total / non-blank non-comment). WT = in-flight working-tree size.

| File | LOC | Purpose | In scope |
|---|---:|---|---|
| `Party.sol` | 604 / 470 | One party (EIP-1167 clone): deposits via factory, redeem, verified burn, price governance, sale, claims | Yes, highest priority |
| `PartyFactory.sol` | 93 / 66 (WT 95) | Deploys clones (CREATE2 salt = host+nonce), routes deposits (only approval users give), EIP-712 floor verification, immutables. No admin. | Yes |
| `CreditCards.sol` | 126 / 99 | Shared ERC-721 for all parties; per-(party, account) `Trace208` checkpoints for snapshot votes; on-chain SVG | Yes |
| `CreditKeys.sol` | 181 / 153 (WT 215) | Linked library: preset order verification, trait keys, rarity table, keccak Fisher–Yates | Yes |
| `CreditTraits.sol` | WT only, 95 | **In flight, uncommitted.** Sealed per-Credit trait table (SSTORE2 chunks, 3 bytes/id) so burns stop calling `CreditArt.describe` | Yes once committed |
| `StatementMarket.sol` | 147 / 102 | Holder resale: fixed-price listings, expiry, `cancelAll` nonce, 1% fee, seller push with pull fallback | Yes |
| `interfaces/IExternal.sol` | 41 / 31 | `ICredits`, `ICreditArt`, assumed `IStatement` (WT adds `ICreditTraits`) | Yes (assumptions) |
| `testnet/TestnetPartyFactory.sol` | 23 | Short clock (`timeUnit`), refuses chainid 1 | Low |
| `testnet/KeyProbe.sol` | 18 | UI helper for keys/shuffle | Low |
| `mocks/MockStatement.sol` | 45 | Stand-in for the unpublished Statement contract | No (read for assumptions) |
| `script/DeployMainnet.s.sol`, `script/DeploySepolia.s.sol` | 38 / 77 | Deploy; mainnet has chain-1 guard and `CREDITS` address check | Review |

Not implemented anywhere: house-party creation, auction contract, launch lock (SPEC §4d).

### 2.2 Site and off-chain services

| Component | Files | Notes |
|---|---|---|
| API core | `lib/core.mjs` (1,674 lines) | All routes, rules engine mirroring Party.sol in BigInt wei, auction simulation, gates |
| Storage | `lib/store.mjs` (105) | Neon Postgres: one JSON `state` row mutated under `SELECT … FOR UPDATE` per POST (`:55-65`); tables `floors`, `nonces`, `owners`, `terms`, `ens`. File store for local dev. |
| Vercel entry | `api/index.mjs`, `vercel.json` | All `/api/*` rewritten to one function with `__path`; crons `/api/cron/floor` and `/api/cron/sync` every minute, `CRON_SECRET` bearer, constant-time compare, fail-closed (`api/index.mjs:5-10`); CSP/HSTS headers; `/sepolia*` redirects home |
| Local server | `server.mjs` | Same core on `127.0.0.1:8088`; floor every 60 s, sync every 30 s |
| Client | `public/app.js`, `public/wallets.js` (EIP-6963 picker), `public/wc.js` (WalletConnect), `public/index.html`, `style.css` | |
| Sign-in / sessions | `lib/core.mjs:182-206, 959-1000` | EIP-4361, terms text is the signed statement; nonce HMAC-bound; single-use nonce table; session = HMAC(address.expiry), HttpOnly SameSite=Strict, 7 days, stateless (no revocation) |
| Floor feed | `lib/core.mjs:243-276` | OpenSea API every minute, 25 h kept; `avg24h` or `latest` (stale after 2 h). Source: Statement collection floor once `STATEMENT_SLUG` is set, else 80 × Credits floor |
| Floor signer (EIP-712) | `lib/core.mjs:1062-1081` | **Sepolia only** (`/api/sepolia/floor`, needs `SEPOLIA_FLOOR_KEY`, chainId 11155111). No mainnet signer service exists yet. |
| Ownership sync | `lib/core.mjs:75-120` | Credits Transfer logs from snapshot block; `ownerOf` re-read at deposit before the lock (`:1639-1646`) and re-checked in the lock (`checkDeposit`, `:800`) |
| ENS | `lib/core.mjs:122-180, 1034-1054` | viem, `ccipRead: false` (`:72`), 6 s limits, only for addresses the site knows (`siteAddrs`) |
| Tooling | `scripts/` (`fetch-chain`, `traits`, `slips`, `evm.mjs`, `diff/*`, deploy scripts) | |

### 2.3 External dependencies and constraints

| Dependency | Facts (verified by the team; SCOPE.md §5.2) |
|---|---|
| Credits `0x97630aa70ab14ed9883b41dafccbc11349723043` | OZ ERC-721 + Ownable, sealed (`isSealed()` true, `sealedAt` 1790181707), supply 122,154 fixed. `burn(address owner_, uint256[] ids) returns (bytes21[] seeds)`: needs sealed, non-empty ids, caller is owner or approved-for-all; duplicates revert; burned id → `ownerOf` reverts `ERC721NonexistentToken` (`0x7e273289`). No ERC-2981. Source copy `research/Credits.sol` = `contracts/test/credits/Credits.sol`. |
| CreditArt `0xFbE816B82547B483C7DFfC5b14C75eC84f8c1985` | `describe(bytes21 seed, uint64 paidAt)` is `pure`; source of every trait |
| Statement contract | **Unpublished** (expected ~2026-10-01). Assumed `make(uint256[] ids) returns (uint256)` burns the caller's 80 in order and mints to the caller; unrestricted `transferFrom`; contract callers allowed (`IExternal.sol:34-41`; SCOPE §5.3 lists 7 assumptions). An adapter and a new factory may be needed. |
| OpenZeppelin 5.4.0 (vendored) | ERC721, Checkpoints, Clones, Initializable, ReentrancyGuardTransient (needs EIP-1153), MerkleProof, EIP712, ECDSA |
| OpenSea API | Floor readings (`OPENSEA_API_KEY`), listings of the Statement collection once known |
| RPC | Mainnet via `ETH_RPC` (default `https://ethereum-rpc.publicnode.com`, 8 s timeout, 1 retry, `lib/core.mjs:69-72`) |
| EIP-7825 | 16,777,216 gas per transaction. Binding for `assemble` (80-Credit burn) and `createParty`+80 deposits. `test/gas/Cap.t.sol` asserts under the cap. |
| EIP-170 | 24,576-byte runtime limit. Party was 23,702 bytes at `36be269` (x-ray); CreditKeys was split into a linked library for this. Re-measure: `forge build --sizes`. |

---

## 3. Trust model and roles

| Role | Can | Cannot | Where |
|---|---|---|---|
| **Host** (creator; one per party) | Set params at creation (immutable): eligibility Merkle root, minDeposit, duration 1–60 d, vote window, preset/seed, default price, floor mode, `minAskWei`, default buy wait 0–72 h. Manual preset: burn with any order within `MANUAL_GRACE` (1 day) of FULL. `transferHost`. | Edit params, close early, veto, move funds, act after the 1-day Manual window except as a card holder | `Party.sol:165-184, 284-293, 544-548` |
| **Card holder** | Redeem (OPEN/EXPIRED), propose/vote/execute prices, burn auto presets (and Manual after grace, Time order), claim 1/80 | Redeem while FULL; vote with cards acquired at/after the snapshot block | `Party.sol:243-265, 337-435, 501-515` |
| **Anyone** | `redeemFor` after expiry (pays holder), `claimFor` after sale (pays holder, 50k stipend, else `owed`), `countBlocked`, `raiseAsk`, `buy`, `withdraw` own `owed` | | `Party.sol:248, 438, 465, 476, 519, 535` |
| **Burner** (assemble caller) | Chooses which valid floor reading of the last 10 minutes resolves a floor-relative ask | Choose the order for auto presets (exactly one order verifies) | `Party.sol:284-326` |
| **Floor signer** (one immutable EOA per factory) | Sign `Floor(floorWei, mode, issuedAt)`; accepted by **every** party with that `floorMode` for 10 min; sets floor-relative asks at burn/execute/raiseAsk and decides 41 vs 60 | Move funds or tokens; push a floor-relative ask below the host's `minAskWei` | `PartyFactory.sol:84-92`, `Party.sol:558-583` |
| **Fee recipient** (immutable) | Pull 1% + dust per party and per market sale | Anything else | `Party.sol:490`, `StatementMarket.sol:118` |
| **Collection owner** (`CreditCards.owner()`) | Edit the OpenSea collection page | Anything on-chain: no function checks `owner()` | `CreditCards.sol:20-22` |
| **Factory** | Register parties, route deposits (`transferFrom(msg.sender, party, id)` only), verify floor sigs | Move Credits from anyone but its caller; no admin/pause/upgrade | `PartyFactory.sol:44-64` |
| **Statement contract** (trusted, immutable in factory) | Operator over the party's Credits during `make` only; gates `buy` via `transferFrom` | Keep Credits (burn is verified) | `Party.sol:310-322` |
| **Site operator** | Runs the preview DB, floor feed, Merkle roots, SIWE sessions (`SESSION_SECRET`), crons; in future the floor key | Nothing on-chain beyond the floor key (not yet deployed) | §2.2 |

---

## 4. Intended rules (authoritative) and where enforced

"C" = contract (`Party.sol` unless named), "S" = site (`lib/core.mjs`). Hosted (FULL-mode) rules first; launch rules in
§4.2. SPEC.md v0.8 is the product spec; where SPEC and code differ, ask the owner (ARCHITECTURE §9 lists old
differences, some now closed).

### 4.1 Hosted parties (contracts + site)

| # | Rule | C | S |
|---|---|---|---|
| R1 | Users approve only the factory. Factory moves only its caller's Credits into its own parties; party records only Credits it received, only when called by the factory. | `PartyFactory.sol:56-64`, `onDeposit:213-240` | `checkDeposit:800` |
| R2 | Deposit count between min(minDeposit, remaining) and remaining; Merkle eligibility; no duplicates; one card per Credit to depositor. | `:216-233` | `checkDeposit` |
| R3 | 80th deposit sets `fullAt`; deadline pushed to ≥ now + 2 days (`FILL_GRACE`). | `:235-239` | `markFull:390` |
| R4 | Redeem only OPEN or EXPIRED, only by/for the current card holder; card burned. | `:243-265` | withdraw/return routes `:1291, 1447` |
| R5 | Auto presets: any current card holder burns; exactly one order verifies. Manual: host only until `fullAt + 1 day`, then any card holder with Time order. | `:284-293`, `CreditKeys.verifyOrder` | `:1390-1413` |
| R6 | Burn verified: Statement received, and all 80 `ownerOf` revert with `0x7e273289`. Statement approval only for the `make` call. | `:310-322` | n/a (simulated) |
| R7 | Only prices are governed (LIST, CANCEL). Weight = cards at `block.number − 1` at creation. Windows 1/24/48/72/168 h; CANCEL 24 h. Max 3 open per proposer. | `:337-380, 596-598` | `:1309-1351`; site adds 12 proposals/member/party/24 h, keeps last 200 closed (`:392, 455`) |
| R8 | Pass: YES ≥ 41 and NO = 0. LIST below the floor at execution: 60. Deadlock (≥ 3 counted blocked LISTs, or > 30 days since last execution/assembly/FULL): proposals created then pass at max(need, 54), NO ignored. Fixed LIST with no reading: treated as below floor (60). | `needFor:383-388`, `execute:390-435`, `_deadlocked:448-452` | `tally:423`, `deadlocked:462` |
| R9 | `countBlocked`: current-epoch, closed, unexecuted, non-deadlock LIST with YES ≥ 41 and NO > 0; counter resets on any execution. | `:438-446, 418` | `canCountBlocked:447` |
| R10 | Execute within 7 days of close; any execution or burn bumps `priceEpoch` and supersedes all others. | `:393-396, 307, 416` | `isSuperseded:442` |
| R11 | Floor reading: signer-signed, ≤ 10 min old (real time), never older than the last used by the party, 0 < floor ≤ 1e30. | `_floor:558-565` | preview uses server floor |
| R12 | Floor-relative prices clamp to ≥ `minAskWei` (required > 0 for any floor-relative default or proposal) and need buy wait ≥ 1 h; Fixed prices are never clamped. | `:176-177, 346-347, 581-583, 592-594` | `delayOk:386`, `minAskWei:494` |
| R13 | Asks only rise via `raiseAsk` (anyone, floor-relative only); `buyableAt` unchanged. | `:465-471` | `:1361` |
| R14 | Sale: `buy(maxPrice)` after `buyableAt`; fee 1% (+ dust < 80 wei) to fee recipient (pull); `perCard = (price − fee)/80`; excess refunded; **no royalty** (`Sold.royalty` = 0). | `:476-498` | `saleSplit:539` |
| R15 | Statement leaves only via `buy` (store-only). No offers/auctions for hosted parties. | no other transfer path in Party | `STORE_ONLY:794` |
| R16 | Claims: holder `claim` (card burned) or anyone `claimFor` (push, 50k gas, else `owed`). | `:501-532` | `:1524-1546` |
| R17 | No direct ETH; unsolicited ERC-721 safe transfers rejected except the Statement mint during `assemble`. | `:328-332, 601-603` | |
| R18 | Resale: seller lists owned, approved Statement; live only while seller owns it, approved, unexpired (`list` 30 d, `listFor` ≤ 180 d), and no `cancelAll` since; 1% fee, seller push 50k with pull fallback. | `StatementMarket.sol:60-128` | `/api/statements/:id` `:1186-1219` (403 in launch mode) |
| R19 | Site: settings lock once anyone else deposits; host can transfer hosting; terms + rules versions required on mutating routes; POSTs from other origins 403. | n/a | `:1547, 1437, 779-786` |

### 4.2 Launch (house parties) — site only today; contract design SPEC §4d

| # | Rule | Site | Contract |
|---|---|---|---|
| L1 | Four hostless parties, fixed id ranges (§1.2), Time order, any card holder burns at 80 | `:651-676, 1411` | **Not implemented** (D-5) |
| L2 | Burn requires a Credits floor reading; reserve = 100 × 24 h avg Credits floor | `:1419-1423, 537` | Not implemented |
| L3 | English auction: first bid ≥ reserve, +0.1 ETH steps, 24 h from first bid, +5 min anti-snipe, no end/fallback before first bid, outbid refunded at once | `:1467-1492, 543` | Not implemented |
| L4 | Settle by anyone after end; split like a sale; no price votes, `raiseAsk` or `buy` during the auction | `:1493-1510, 1311` | Not implemented (D-4, D-6) |
| L5 | Full mode (hosted parties, profiles, resale) locked until a Minute auction settles with a winner; locked routes 404/403 | `:655, 940, 1197, 1233, 1586` | Not implemented (no on-chain launch lock) |

---

## 5. Invariants

Full lists: `docs/audit/INVARIANTS.md` (I-1…I-41, at `5040009`, partly stale) and `contracts/x-ray/invariants.md`
(G-1…G-52 guards, I-1…I-22, X-1…X-4, E-1…E-3, at `36be269`). Summary of what must hold:

| Invariant | Statement | Enforced | Tested |
|---|---|---|---|
| ETH conservation | Before SOLD the party holds 0 accounted ETH. After: `balance == Σ owed + perCard × cardsOutstanding`; `fee + dust + 80·perCard == price`, `dust < 80`. | `buy`, `claim`, `claimFor`, `withdraw` | `test/invariant/PartyInvariants.t.sol:213-216` (I5); unit/Sale; Halmos `Party.halmos.t.sol` split |
| Card ↔ Credit 1:1 | Pre-burn: live cards of P ↔ Credits in `_order` bijectively; party holds exactly `count()` Credits; `cardsOutstanding == _order.length`. | `onDeposit`, `_redeem` | invariant I1 (`:124-152`) |
| Weights | Σ `heldNow(P,·)` = live cards of P ≤ 80; snapshots immutable; `yes + no ≤` snapshot weight. | `CreditCards._update:71-83`, `_vote` | invariant I2, I6 (`:132-194`) |
| Order immutability | Auto preset: exactly one accepted order; burn order is a permutation of the 80. At HEAD stored in `_burnOrder`; WT stores `burnOrderHash` and emits the order. | `CreditKeys.verifyOrder`, `assemble` | unit/Assemble, KeysSpec, Halmos keys/perm/shuffle, diff Presets* |
| Vote snapshot | Weight at `block.number − 1`; cards bought in or after the creation block carry none. | `propose:353`, `_vote:371` | invariant I6; Pashov L4 (§6) is a consequence |
| Custody paths | Credits leave only by redeem/redeemFor or burn; the Statement leaves only by `buy`; ask changes only by vote/raise. | whole contract | Handler `_fail` checks I3/I4/I7 (`Handler.sol:168-184`) |
| No stuck funds | After all claims: party ETH 0; after full `redeemFor` on expiry: party Credits 0. | | invariant I8/I9 (`:218-239`) |
| Status monotone | OPEN→FULL→ASSEMBLED→SOLD; OPEN/FULL→EXPIRED; ASSEMBLED never expires. | `status:195-200` | unit tests |
| Floor | Reading monotone per party; `0 < floor ≤ 1e30`; floor-relative ask ≥ `minAskWei`. | `_floor`, `_clampMin` | unit/Floor, Fixes, Findings3; Halmos resolve |

Auction invariants (design only, SPEC §4d): auction balance == high bid + Σ pull balances; the Statement is always in
the auction, with the winner, or (before burn completes) in the party.

---

## 6. Findings history

Status keys: **FIXED** (commit), **IN PROGRESS** (work started, not landed), **OPEN**, **PENDING DECISION**,
**ACCEPTED** (rationale), **MOOT** (royalties removed in `f06b3c5`).

### 6.1 Contracts

| ID | Source | Finding | Status |
|---|---|---|---|
| T-1 | Static triage (`contracts/audit/static/TRIAGE.md`) | Lifetime `MAX_PROPOSALS = 256` exhausted by one card rotated over fresh addresses → governance frozen forever | FIXED `884add5` (per-proposer open list, `_refreshOpen:454-460`) |
| T-2 | Static | One holder self-NO's 3 proposals → permanent deadlock mode | FIXED `884add5` (YES ≥ 41, current epoch, reset on execute). **Re-raised in a stronger form as Pashov H1.** |
| T-3 | Static | 24 h buy delay == min window → CANCEL can never beat `buy` | Changed `89f4ff3`: buy wait is voted per price (0–72 h). A wait > 24 h lets a cancel land first; a short wait lets the sale win. ACCEPTED by design (`test_cancelRace_shortWait_saleWinsByDesign`, Fixes.t.sol:482). |
| T-4 | Static | Floor key sets low asks; reading cherry-pick; every LIST execution needs the key | FIXED `884add5` (monotone readings, host `minAskWei`, Fixed LIST executes without floor at 60) + `7a9766e` (10-min age) + `5e54449` |
| T-5 | Static | Royalty decode bricks `buy` / silent skip | FIXED `884add5`, then MOOT `f06b3c5` |
| T-6 | Static | No post-assembly exit; stranded shares for contract holders | `claimFor` added `884add5` (FIXED). No exit when unsold: ACCEPTED (SPEC: Statements cannot be split back; THREAT_MODEL R-13) |
| T-7 | Static | Missing events | FIXED `884add5` (`BlockedCounted`, `Withdrawn`, `PendingPriceSet`, `PartyRegistered`) |
| Slither/Aderyn | Static | 21 + 14 groups; 0 + 1 true positives (A-L6 = T-7) | Triage in TRIAGE.md; rest FALSE POSITIVE/ACCEPTED |
| F1–F3 (invariant) | `test/invariant/Findings.t.sol` | Self-NO deadlock; proposal cap; deadlock clock ignored assembly | FIXED `884add5` (clock now from last execution, else assembly, else FULL: `:450`) |
| F1–F4 (unit) | `test/unit/Findings.t.sol` | Same as T-1/T-2, counter reset, short royalty return | FIXED `884add5`; F4 MOOT |
| F2-1 | `test/unit/Findings2.t.sol` | Fixed-default party with `minAskWei = 0` votes a floor-relative LIST → 1-wei ask | FIXED `5e54449` (`propose:346`). Test header still says "FAILS"; stale comment. |
| Mutation | slither-mutate, `contracts/audit/mutation/` | Surviving mutant showed a floor-relative ask could resolve to 1 wei on a bad floor | FIXED `5e54449`. Scores after kills: Party ≥ 92.2% (1378/1495), CreditKeys ≥ 88.9% (536/603), `after-score.txt` |
| Halmos | `test/halmos/Party.halmos.t.sol` | Counterexample: floor ≥ 2^255 wraps negative in `int256` cast | FIXED `9ef9442` (`floorWei ≤ 1e30`, `Party.sol:563`) |
| Audit 3 #1 | external review 3 | Royalty stipend | Changed to 150k, then MOOT `f06b3c5` |
| Audit 3 #2 | external review 3 | Floor cherry-pick (1 h age) | FIXED: source in `7a9766e` (commit message is about the site log, but it carries the Party/StatementMarket changes); tests/docs in `856348d` |
| Audit 3 #3 | external review 3 | Burn check accepted a Statement that kept/moved the Credits | FIXED `7a9766e` (`0x7e273289` check, `Party.sol:317-322`) |
| Audit 3 #4 | external review 3 | StatementMarket stale listing revival | FIXED `7a9766e` (expiry + `cancelAll`), `7c33264` (cancel when `ownerOf` reverts). Residual revival within expiry: ACCEPTED (documented) |
| Royalty | owner decision | Creator royalty (ERC-2981) leg in Party and StatementMarket | Removed `f06b3c5` (cap lowered `8a98007` before). All royalty findings MOOT. |
| **H1** | Pashov solidity-auditor, `contracts/.solidity-auditor/runs/20260924-135350/full-report.md` #1 [90] | `countBlocked` fast path: a coalition's own NO counts and 41 (not the real threshold) qualifies; with 1 h windows, 60 cards can reach deadlock and sell below floor/for the minimum within about 2 h of the burn | **OPEN, fix PENDING USER DECISION.** Proposed fix: drop the "3 blocked proposals" trigger, keep only the 30-day clock. Not in the tree. |
| **H2** | Pashov #2 [85] (THREAT_MODEL R-7) | Assemble supersedes a passed-but-unexecuted FULL-phase price: one card holder burns first, the host default goes live (`priceEpoch++`, `:307`), and with a 0 h wait buys at once | OPEN; fix reported in progress by other agents, **not in the working tree** at `165a33e` + WT |
| **M3** | Pashov #3 [80] | `_resolveWith` reverts on `r ≤ 0` before `_clampMin` (`:576`), so a floor ≤ a negative FloorDelta (or FloorPct rounding to 0) blocks assemble/execute/raiseAsk; `test_minAsk_nonPositiveResolveStillReverts` (Fixes.t.sol:596) documents current behavior | OPEN; fix in progress, not landed |
| **L4** | Pashov #4 [60] | Proposal in the block that fills slot 80 snapshots `block.number − 1`, so the last depositors have no weight (cannot veto) on it | OPEN; fix in progress, not landed |
| P-5 | Pashov #5 [55] | A Fixed price passed while FULL goes live at burn with no new floor check | OPEN; SPEC judges below-floor at execution (`SPEC.md:55`), so likely ACCEPTED; owner to confirm |
| Pashov leads | same report, "Leads" | Gas test covers 5 of 11 presets; deadlock clock/counter survive burn; testnet `timeUnit < 600 s` makes buy wait < floor age; Statement approval covers stray Credits; burner/executor/raiseAsk choose the reading (R-6); Manual host with no cards picks the order; `raiseAsk` unguarded during `make`; `redeemFor` pushes to contract holders; floor sig not party-bound (R-4); StatementMarket buyer callback before seller payment | Unscored leads; OPEN for review |
| Gas | `3953c99`, `test/gas/*` | Cold burn cost on a mainnet fork: Deposit 7.37M, Time 7.61M, Rarity ≈ 12.8M (12.78M), excluding the real Statement `make` | IN PROGRESS: precomputed trait table (`CreditTraits.sol`, WT `CreditKeys` rewrite) to remove 80 `describe` calls. Uncommitted. |

### 6.2 Design review of SPEC §4d (`contracts/.solidity-auditor/design-review-spec-4d.md`)

| ID | Item | Status |
|---|---|---|
| D-1 | Reserve never met → Statement held forever (no end, no fallback, no vote) | **ACCEPTED by owner decision:** the auction simply waits for its first bid; there is no timer, end or fallback before it. |
| D-2 | Signer compromise or burner cherry-pick sets the reserve; key shared by all parties | OPEN (design) |
| D-3 | Settle must not `safeTransferFrom` to the winner | OPEN (design) |
| D-4 | Party cannot receive auction proceeds (`receive` reverts; `sold/perCard` set only in `buy`); EIP-170 headroom | OPEN (design) |
| D-5 | Hostless creation does not fit `createParty` (host = sender, opening deposit required) | OPEN (design) |
| D-6 | Party sale path/governance must be disabled for house parties | OPEN (design) |
| D-7 | Auction reentrancy and accounting invariant under refund push | OPEN (design) |
| D-8 | Anti-snipe extension uncapped | OPEN (design; likely ACCEPTED) |
| D-9 | Royalty leg in "split like a sale" | FIXED in SPEC (§4d settle split says "no royalty", `SPEC.md:90`) |
| D-10 | Burn liveness depends on the signer | OPEN (design; failure mode is expiry, Credits returned) |

### 6.3 Site

| ID | Source | Finding | Status |
|---|---|---|---|
| S-1 | `docs/security/SITE-AUDIT.md` #1 (HIGH) | Terms records bloat the shared state doc (DoS) | FIXED `0b37d4b` (own `terms` table, sig cap, rate limit) |
| S-2 | #2 (MED) | Every POST took the global row lock; RPC under lock | FIXED `0b37d4b` (lock-free read-only POSTs, `:1635`), `1d26cea`/`03db3bb` (ownerOf pre-read outside the lock) |
| S-3 | #3 (MED) | Host changes price terms after others deposit | FIXED `0b37d4b` (settings lock). Minimum buy wait left at owner's 0–72 h design: ACCEPTED |
| S-4 | #4 | Holder buy without `maxPriceEth` | FIXED `0b37d4b` |
| S-5 | #5 | Malformed cookie / `Origin: null` → 500 | FIXED `0b37d4b`; unparseable Origin now 403 `165a33e` |
| S-6 | #6 | `__path` serves public files via the function | FIXED `0b37d4b` |
| S-7 | #7 | Sessions not revocable (stateless 7-day HMAC) | ACCEPTED, documented (SPEC §11) |
| S-8 | #8 | Card routes leak pre-assembly party data | FIXED `0b37d4b` (gated) |
| S-9 | #9 | `DATABASE_URL` present in Preview/Development → dev sign-in could hit prod DB | Mitigated `0b37d4b` (`store.mjs:102` ignores it outside production unless `ALLOW_DEV_DATABASE=1`) |
| S-10 | #10 (INFO) | `?fork=&as=` hook in `public/sepolia.js` | Mitigated: `/sepolia*` redirects home (`vercel.json`, `165a33e`); `/api/dev/*` absent in production |
| S-cron | SITE-AUDIT "checked" | Cron passes when `CRON_SECRET` unset | FIXED `bb16fe4` |
| Earlier | `3b3369b`, `e7156b0` | First code audit of the prototype (bodies, schemas, dev clock, headers, SIWE, origin check) | FIXED in those commits |
| S-23 | Latest 23-item site audit | **The 23-item list is not committed to the repo**; item-by-item mapping cannot be verified from git. Fix commits that cite it or landed after it: `41652cb` (SPEC consistency), `ec925c1` (launch accuracy), `704a42a` (auction bid backing, wei rounding, claimFor/return open), `03db3bb` (deposit RPC failure ≠ burned), `2056afe` (ENS: CCIP-read off, 6 s limits, rate limit, known addresses only), `bed9a2c` (Party.sol parity: cancel 24 h, whole-hour waits, fill grace, Manual fallback, proposal limits), `fa757bf` (auctions in gallery), `3953c99` (gas figures, rules/terms text), `165a33e` (body size on parsed body, Origin 403, floor window/staleness, `/sepolia` redirect, sync never lowers the saved block, 8 s fetch timeouts, gas retry backoff). | IN PROGRESS. No uncommitted site changes at writing (`git status` clean for `lib/`, `public/`). Ask the owner for the list and re-check each item. |

### 6.4 Stale statements in older docs (do not rely on them)

- THREAT_MODEL R-1 (256-proposal cap), R-3 (fixed 24 h `BUY_DELAY`), R-5 (Fixed LIST needs the key), R-14 (no
  `claimFor`), R-12 (11.7M figure, 59.9M block limit framing; the binding limit is the 16.78M per-tx cap), R-21/T-5
  (royalty) are superseded by the fixes above.
- ARCHITECTURE §4/§6 "buy ≥ askLiveAt + 24h", "MAX_PROPOSALS = 256", "counter never resets", "Assembly does not update
  since", §9 "`claim` by holder only" are superseded.
- x-ray `36be269` still shows the royalty `staticcall` in the `buy` flow; removed in `f06b3c5`.
- SCOPE.md §1 freeze commit `5040009` is obsolete.

---

## 7. Known gaps, not built, decisions pending

1. **House-party contracts** (hostless creation, auction, launch lock): not implemented; SPEC §4d design only; D-2…D-8,
   D-10 open. Until built, launch mode exists only in the preview.
2. **D-1** reserve never met: ACCEPTED (auction waits indefinitely for the first bid).
3. **Deadlock trigger change** (H1 fix: remove the 3-blocked-proposals trigger, keep 30 days): PENDING USER DECISION.
4. **H2, M3, L4**: fixes in progress, not landed.
5. **Burn gas vs EIP-7825 cap (16,777,216):** cold fork measurements Deposit 7.37M, Time 7.61M, Rarity ≈ 12.78M, all
   excluding the real Statement `make`, whose cost is **unknown**. Rarity leaves ≈ 4M for `make`. The trait-table
   rework (in flight) is meant to cut sorted presets to near Deposit cost. Re-measure with the real Statement.
6. **Statement contract**: ABI and behavior unknown. Adapter or factory redeploy likely.
7. **Sepolia**: v1 is stale (older rules). Redeploy after the above lands (`scripts/deploy-sepolia.sh`).
8. **Mainnet params** not chosen: `FEE_RECIPIENT`, `FLOOR_SIGNER` (and its key custody/rotation; it is immutable),
   `COLLECTION_OWNER`, `STATEMENT` address, CreditTraits table deployment (WT factory constructor requires it).
9. **Mainnet floor-signing service** does not exist (only `/api/sepolia/floor`).
10. SPEC open decisions (`SPEC.md:154-158`): chat visibility; Party Protocol vs custom governance; gas reimbursement for
    the burner (SPEC §4c).

---

## 8. How to run everything

Prereqs: Foundry (forge 1.7.1 used), Node ≥ 20, `npm ci`, jq. Halmos at `~/.local/bin/halmos`; slither/aderyn for
static; slither-mutate for mutation. Secrets are never in the repo; set them in your shell.

### 8.1 Contracts

```bash
cd contracts
forge build
forge build --sizes                                   # EIP-170 headroom (Party must stay < 24,576 bytes)

# Local suites (no RPC): unit, market, invariants, smoke
forge test --match-path 'test/unit/*' --no-match-contract PresetsForkTest
forge test --match-path 'test/market/*'
forge test --match-path 'test/LocalSmoke.t.sol'
forge test --match-path 'test/invariant/*'            # runs=256 depth=100 (foundry.toml); also Findings regressions

# Mainnet-fork suites (fork block 26044000; need an archive-capable RPC)
export ETH_RPC_URL=<mainnet rpc>
forge test --match-path 'test/Lifecycle.t.sol'
forge test --match-contract PresetsForkTest
forge test --match-path 'test/gas/Cap.t.sol' -vv      # asserts open+deposit and burn < 16,777,216
forge test --match-path test/gas/Breakdown.t.sol --isolate -vv   # cold per-preset burn cost (untracked file)
forge test                                            # everything

# Differential suites (site logic vs contracts) need an unbounded gas limit
forge test --match-path 'test/diff/{PresetsDiff,PresetsE2EDiff,TraitsDiff,DeadlockDiff}.t.sol' \
  --gas-limit 9223372036854775807 -vv
```

Full differential run (site `lib/core.mjs` vs contracts; needs `ALCHEMY_API_KEY`):
```bash
bash scripts/diff/run-all.sh      # corpus checks, 250/2000 preset cases, 3000 rules cases, scenarios, rules-compare
```

Halmos (from `contracts/`; builds into a private dir; first run downloads solvers):
```bash
bash test/halmos/run.sh party     # sale split, pass rule, price resolution (bitwuzla)
bash test/halmos/run.sh keys      # key packing, rank tables
bash test/halmos/run.sh shuffle   # SHUFFLE_MAX=7 default
bash test/halmos/run.sh perm      # PERM_MAX=5 default (6 is ~2 h)
bash test/halmos/run.sh all       # ~20 min on an M4 Max
bash test/halmos/run.sh slow      # 256-bit mul/div proofs that time out on every solver tried
# env: HALMOS, HALMOS_BUILD_DIR, HALMOS_TIMEOUT (default 300s), SHUFFLE_MAX, PERM_MAX
```

Static analysis (outputs in `contracts/audit/static/`; no config files, commands as recorded in TRIAGE.md):
```bash
slither . --filter-paths "lib|test"
slither-check-erc . CreditCards --erc ERC721
slither-check-upgradeability . Party
aderyn .
```

Mutation testing (`contracts/audit/mutation/`; sharded slither-mutate; scripts assume macOS paths and solc 0.8.28 from svm):
```bash
bash audit/mutation/setup-shard.sh <contracts-dir> <shard-dir>          # pristine p/ + mutable m/, FOUNDRY_PROFILE=mut
cd <shard-dir>/m && slither-mutate src/Party.sol \
  --test-cmd "bash <repo>/contracts/audit/mutation/run-one.sh <shard-dir>/m <shard-dir>/p party" \
  --timeout 300 -v --solc-remaps "@openzeppelin/=lib/openzeppelin-contracts/ forge-std/=lib/forge-std/src/" \
  --compile-force-framework solc --solc-args "--optimize --evm-version cancun"
python3 audit/mutation/score.py out.tsv <shard logs...>                  # merge shard logs
bash audit/mutation/recheck.sh <shard-dir> party <survivor diffs...>    # re-test survivors
```
(Full launcher used: `contracts/audit/mutation/raw/launch.sh.txt`.)

Coverage: `forge coverage --ir-minimum` (x-ray: Party 98.7% lines / 97.0% branches at `36be269`; fork suites excluded).

### 8.2 Site

```bash
npm ci
node server.mjs                                  # dev: http://localhost:8088, file store in data/, DEV gates OFF
NODE_ENV=production SESSION_SECRET=$(openssl rand -hex 32) node server.mjs   # realistic: launch 404s on, no dev routes
```
- Dev sign-in (dev only; absent in production): `POST /api/auth/dev` with
  `{"address":"0x…","accept":true,"rules":true}` and `Origin: http://localhost:8088`, `content-type: application/json`.
  Dev also exposes `/api/dev/advance` (clock) and `/api/dev/fork`.
- Production-mode sign-in needs a real EIP-4361 signature: `POST /api/auth/nonce` → sign → `POST /api/auth/verify`.
- Without `DATABASE_URL` (or outside production) the file store is used. Do **not** point at the production DB;
  `ALLOW_DEV_DATABASE=1` overrides the guard and must not be used for testing.
- Probe production with GET and rejected inputs only.

Data regeneration (not needed to audit): `node scripts/fetch-chain.mjs` (`ALCHEMY_API_KEY`), `node scripts/traits.mjs`
(anvil), `node scripts/slips.mjs`.

### 8.3 Environment variables (names only)

| Var | Used by | Purpose |
|---|---|---|
| `ETH_RPC_URL` | forge fork suites, deploy scripts | Mainnet RPC |
| `ALCHEMY_API_KEY` | `scripts/diff/run-all.sh`, `scripts/fetch-chain.mjs` | RPC for diff and snapshot |
| `NODE_ENV` | site | `production` disables dev routes, enables gates, requires `SESSION_SECRET` |
| `SESSION_SECRET` | site | HMAC for sessions and nonces |
| `DATABASE_URL`, `ALLOW_DEV_DATABASE` | `lib/store.mjs:102` | Neon Postgres; guard |
| `CRON_SECRET` | `api/index.mjs` | Cron bearer |
| `ETH_RPC` | `lib/core.mjs:69` | Site mainnet RPC |
| `OPENSEA_API_KEY`, `STATEMENT_SLUG` | floor feed, listings | |
| `WALLETCONNECT_PROJECT_ID` / `REOWN_PROJECT_ID` | WalletConnect | |
| `SEPOLIA_FLOOR_KEY`, `SEPOLIA_FACTORY` | `/api/sepolia/floor` | Sepolia-only signer |
| `PORT` | `server.mjs` | default 8088 |
| `CREDITS`, `STATEMENT`, `FEE_RECIPIENT`, `FLOOR_SIGNER`, `COLLECTION_OWNER`, `CONFIRM_MAINNET`, `ETHERSCAN_API_KEY`, `DEPLOY_SIGNER_ARGS` | mainnet deploy | |
| `SEPOLIA_RPC_URL`, `TEST_HOLDERS`, `PER_HOLDER`, `TIME_UNIT`, `EXISTING_*`, `CREDIT_KEYS` | Sepolia deploy | |

---

## 9. Where to look hardest (ranked)

1. **`Party.sol` governance** (`propose`/`_vote`/`execute`/`countBlocked`/`_deadlocked`, `:337-452`). H1 is open:
   quantify the cheapest path from FULL or ASSEMBLED to NO-ignored mode with 1 h windows and 3 open proposals per
   address; check the 30-day clock alone (the proposed fix). Check epoch/supersede interplay with `assemble` (H2),
   fill-block snapshots (L4), vote changes after window close, and `execute` choosing between "no floor → 60" and a
   supplied reading.
2. **`assemble`** (`:284-326`): who may call (Manual grace boundary `<=`), price resolution before external calls,
   `setApprovalForAll` scope (covers every Credit the party holds, including strays), `_assembling` window,
   `onERC721Received`, burn verification exactness, reentrancy through the Statement into unguarded
   `propose/vote/countBlocked/raiseAsk/transferHost`.
3. **`CreditKeys.verifyOrder` and the new trait table (WT)**: Manual duplicate check via `tstore(id)` in the linked
   library (delegatecall → Party's transient storage; confirm no collision with `ReentrancyGuardTransient`'s slot and
   that marks are cleared on every path); "not deposited" now via `cardOfCredit` (confirm a redeemed-then-re-deposited
   id cannot slip); Time preset replaced by ascending id (depends on `paidAt` being non-decreasing in id over all
   122,154; the proof `test/keytable` is not in the tree); 3-byte packing (marks in 8 bits: confirm max marks ≤ 255;
   eights ≤ 5 in 4 bits); `tableHash` pinning vs the art contract; `keys()` gas for 80 ids.
4. **Floor handling**: signature not party-bound (R-4), 10-minute caller choice, `lastFloorAt` advanced by any
   `raiseAsk` (can make an in-flight `execute` revert), 1e30 bound, `FloorPct` rounding to 0 (M3), clamp only for
   floor-relative prices, testnet `timeUnit` vs real-time `FLOOR_MAX_AGE`.
5. **Sale and payouts** (`buy`/`claim`/`claimFor`/`withdraw`, `:476-542`): conservation, refund to reverting buyer,
   50k stipend griefing, `claimFor` to the party or factory itself, forced ETH.
6. **Factory deposit routing** (`PartyFactory.sol:44-64`, `onDeposit`): approval to factory only, `isParty`, the
   opening deposit path in `createParty`, deterministic clone salt (front-running `predictParty`), per-token
   `approve(factory)` path, gas of 80 deposits under the cap.
7. **`CreditCards` checkpoints** (`:71-83`): self-transfer, same-block multiple transfers, burn, `SafeCast` of block
   number, `heldAt` future lookup.
8. **`StatementMarket`**: listing revival within expiry, `cancelAll` nonce (`uint64` wrap), `cancel` by third parties
   when `ownerOf` reverts, `safeTransferFrom` callback before seller payment, `uint96` price, self-buy check.
9. **Gas cap margins**: every preset and Manual under 16,777,216 with a realistic `make`; redeem of 59 cards in one
   call (6.31M measured in TRIAGE); x-ray lead that `Cap.t.sol` covers presets 0–4 only.
10. **Site auth and gating**: SIWE nonce MAC/expiry/single use, session HMAC, terms/rules version checks per route
    (`termsOkFor`/`rulesOkFor` let house-party actions pass on launch versions), CSRF via Origin, launch 404 gating
    (`:940`) and its `DEV` bypass, `depositGatesOk` pre-read vs in-lock re-check (TOCTOU), `lockFree` route regex.
11. **Auction routes** (`:1467-1507`): reserve from a thin 24 h window (a cold start with one reading sets the
    reserve), balance check not escrow, `now()` vs `endsAt` boundaries, self-outbid refusal, bid list truncation at
    1000, `openingUnlocked` flip on settle.
12. **SSRF/DoS**: ENS forward lookups from user-supplied names (CCIP-read off; confirm no other off-chain resolution),
    RPC timeouts, OpenSea fetch timeouts, per-instance in-memory rate limits (`rateOk`, keyed on the first
    `x-forwarded-for` value), the single `state` row lock (every mutating POST serializes; state document size growth
    from chat, history 1000/party, proposals 200 kept), `/api/sepolia/floor` signing on demand if configured in prod.

---

## 10. Deliverable expected from the auditor

One Markdown report, `docs/audit/REPORT-<firm>-<date>.md`, against a stated commit hash.

**Severity**
| Level | Meaning |
|---|---|
| Critical | Direct loss or permanent lock of Credits, the Statement, or ETH by an unprivileged actor, cheaply |
| High | Loss/lock needing plausible conditions (a coalition, a timing race, a signer fault within its stated trust), or breaking a core rule (veto, pass thresholds, store-only) |
| Medium | Griefing or liveness failure with a recovery path; rule deviation without direct loss; site auth/gating bypass on the preview |
| Low | Edge cases, minor deviation from SPEC, defense in depth |
| Info | Style, gas, documentation |

**Per finding**
- ID, title, severity, confidence (high/medium/low)
- Location: `file:line` at the audited commit
- Description and the rule or invariant it breaks (cite §4/§5 of this packet)
- Preconditions and attacker cost (cards, gas, time)
- Reproduction: a Foundry test that fails on the audited commit (`forge test --match-test …`), or exact HTTP requests
  for site findings (local `NODE_ENV=production` instance, never production writes)
- Recommended fix as a diff, and the test that should pass after it
- Whether it affects the preview only, contracts only, or both

**Also include**
- Status of every OPEN/IN PROGRESS item in §6 (confirm, refute, or re-grade).
- A list of areas reviewed with no findings, and what was not reviewed.
- Any disagreement between SPEC.md, this packet, and the code.
