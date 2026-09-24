# Statement Maker: audit packet

For an independent auditor who has not seen this project. Self-contained; every claim cites code or a commit.
Refreshed 2026-09-24 against `main` HEAD `b1279b3` (2026-09-24 17:24 -0400). **Line numbers are at `b1279b3`.** The
commit that adds this refresh changes only this file, so the pins hold at it too.

- Repo: https://github.com/yuribeats/statement-maker (public). Live preview (launch mode): https://statement-maker.vercel.app
- Public full-launch preview: https://smpreview.204.168.175.190.nip.io (see §1.1: dev mode, not production gating)
- Local checkout: `~/Desktop/Projects/statement-maker-2026-09-23`

> **Tree state.** Tracked files are clean at `b1279b3`. Untracked (not in git, so not in a clone): the auditor runs
> `contracts/.solidity-auditor/` (including the latest re-audit report, §6.1), `contracts/x-ray.md` and
> `contracts/x-ray/` (x-ray at `d548e55`). Ask the owner for these, or for a tagged commit that includes them.
> Run `git status --short && git log --oneline -5` to see what has landed since this packet.

> **Older audit docs.** `docs/audit/{SCOPE,ARCHITECTURE,INVARIANTS,THREAT_MODEL}.md` were written at `5040009` and
> patched since (the re-audit fixes updated ARCHITECTURE §`assemble`, INVARIANTS I-42/I-43, THREAT_MODEL R-7/R-12/R-21
> and SPEC §4). Where they disagree with this packet or the code, the code wins. Remaining stale points: §6.4.

---

## 1. What it is

Jack Butcher's Credits (122,154 sealed ERC-721s at `0x97630aa70ab14ed9883b41dafccbc11349723043`) can be burned 80 at a
time into one Statement through Jack's Statement contract, which is **not published yet** (the Statements drop is
expected about 2026-10-01 to 10-02, per jack.art). Most holders own fewer than 80. Statement Maker pools Credits from
strangers into a **party**: each deposited Credit mints one Credit Card (ERC-721) that carries the vote, the right to
redeem the Credit before the burn, and 1/80 of the sale. The party burns 80 into one Statement, sells it, and splits the
proceeds (1% fee, the rest in 80 equal shares; no creator royalty).

### 1.1 Deployment status (read this first)

| Item | Status | Evidence |
|---|---|---|
| Website | **Preview.** All party, deposit, vote, burn, auction and sale actions are **off-chain records** in Postgres. Nothing moves Credits or ETH. | `README.md` "Status: preview"; `lib/core.mjs:1460` "Simulated until the Statement contract is public" |
| Public full-launch preview | https://smpreview.204.168.175.190.nip.io runs the site in **dev mode** (`NODE_ENV` not `production`): simulated wallets (dev sign-in, no signature), anyone can start a party, launch gating is off. It shows full mode; it does **not** exercise the production code paths for gating (§1.2 "These gates are skipped when `DEV` is true"). Do not use it to test gates. | `lib/core.mjs:16` (`DEV`), `:1000`, `:1065` (dev sign-in) |
| Mainnet contracts | **None deployed.** `DeployMainnet.s.sol` exists and has never run. Checklist: [`docs/audit/PRE_MAINNET.md`](PRE_MAINNET.md). | `contracts/script/DeployMainnet.s.sol`; `scripts/deploy-mainnet.sh` refuses without `CONFIRM_MAINNET=yes` |
| Sepolia | v1 deployed at `9fcf7f7` (2026-09-24 02:10) with **older rules**. Contract commits since, not on Sepolia: `9ef9442`, `7a9766e`, `47acfeb`, `5e49bf4`, `0fd5a0d`, `7c33264`, `8a98007`, `f06b3c5`, `6190a7c`, `8e8efa5`, `f16d5cb`, `627e9cf`, `e23f1e8`. The Sepolia page code (`web3/sepolia.mjs`) targets the current contracts (e.g. Manual after the grace day sends ascending ids, `b1279b3`); v1 has no Manual grace. `/sepolia*` redirects home in production. | `web3/sepolia-addresses.json`; `git log 9fcf7f7..HEAD -- contracts/src`; `vercel.json` redirects |
| House-party auction, hostless creation, launch lock | **Not implemented in any contract.** Design only, SPEC §4d (`SPEC.md:84-94`). The site simulates it off-chain. **It will not fit in `Party`:** Party runtime is 24,304 bytes, 272 bytes under EIP-170 (24,576) at `e23f1e8`. The auction and house-party logic must live in a separate contract (SPEC §4d already names a `HouseAuction` contract that holds the Statement), with at most a very small hook in Party. | `SPEC.md:84-86`; `forge build --sizes`; no auction code under `contracts/src/` |

### 1.2 Two product modes (site)

Mode is decided server-side by `openingUnlocked()` (`lib/core.mjs:710`): true once any house party has
`assembled && sold`. The client mirrors it with `launchPhase() = !stats.partiesUnlocked` (`public/app.js:1295`).

**LAUNCH mode** (current production state)
- Exactly four hostless house parties, the "Minutes", seeded by `seedMinutes()` (`lib/core.mjs:712-731`):

  | Party | Credit ids (eligibility filter) | Minute of purchase (paidAt), 2026-09-21 UTC |
  |---|---|---|
  | `minute-1349` | #21098–#21177 | 13:49 |
  | `minute-1505` | #25998–#26077 | 15:05 |
  | `minute-1528` | #27664–#27743 | 15:28 |
  | `minute-1622` | #32714–#32793 | 16:22 |

  These are the four minutes of the Credits mint in which exactly 80 Credits were bought (by `paidAt`). Params:
  `minDeposit 1`, arrangement `Time`, `floorMode avg24h`, deadline 60 days from seeding, no host (`hosts: []`,
  `lib/core.mjs:726`). Purchase (Time) order equals ascending id on the sealed collection; `CreditKeys` relies on this
  (`6190a7c`), proved over the full supply by `contracts/test/keytable/` and `scripts/keytable/verify.sh`.
- Once FULL, any card holder burns (`lib/core.mjs:1482`). Burning starts an **English auction**
  (`lib/core.mjs:1492-1497`, constants `:584-594`):
  - Reserve = 100 × the **24 h average Credits floor** at the burn (`openingWei`, `:588`; `floorFor(p).credit`).
    No reading → no burn (`:1494`).
  - Steps of 0.1 ETH (`AUCTION_STEP`); first bid ≥ reserve.
  - **No end and no fallback before the first bid** (`auctionDue` returns `Infinity` while `endsAt == null`, `:594`).
    The first bid starts a 24 h timer; a bid in the last 5 minutes moves the end to bid time + 5 minutes (`:1569`).
  - Bids must be covered by the bidder's mainnet ETH balance, read before the lock (`:1727-1731`); cap 10,000 ETH
    (`BID_MAX_WEI`, `:586`). Balance is checked, **not escrowed** (preview).
  - Anyone settles after the end (`:1573-1588`): Statement to the high bidder, split like a sale.
  - No price proposals on house parties while FULL or auctioning (`:1371`); no `buy` while an auction is live (`:1590`).
- Full-mode pages and APIs 404 in production (`:1000`): `wallet`, `users`, `eligible`, `holders`, party list, and any
  non-house party. Starting a party returns 403 (`:1293`). Statement resale listing returns 403 (`:1257`). Deposit
  pre-check refuses non-house parties (`depositGatesOk`, `:1666`). **These gates are skipped when `DEV` is true**
  (`NODE_ENV` not `production`), which is how the public full-launch preview runs.
- Separate launch terms/rules versions (`TERMS_LAUNCH 2026-09-24.L9`, `RULES_LAUNCH 2026-09-24.L10`; full mode
  `TERMS_FULL .8`, `RULES_FULL .9`; `lib/core.mjs:25`, mirrored in `public/app.js:921`).
- **Unlock:** the site switches to FULL mode when a Minute auction settles with a winner (`:710`).

**FULL mode**
- Anyone holding a Credit starts a hosted party (host = creator). Params, presets (Deposit, Number, Time, Rarity,
  Colors, Print, Weight, Eights, Ink, Random) or Manual (host orders by hand, host states the metric).
- Price governance: 41/80 YES and zero NO; 60 if below the floor; 54 with NO ignored under deadlock. Every price voted
  while FULL is judged again at the burn's floor (§4.1 R20).
- Sells only on Statement Maker at the party's ask ("store-only": no offers, auctions, or marketplace listings for a
  party's Statement). Holders of a sold Statement may list it on StatementMarket (1% fee, asks only).

---

## 2. Scope

### 2.1 Contracts (`contracts/src/`, solc 0.8.28, cancun, via-IR, optimizer 200; `contracts/foundry.toml`)

LOC at `b1279b3` (total / non-blank non-comment; comment lines include NatSpec).

| File | LOC | Purpose | In scope |
|---|---|---|---|
| `Party.sol` | 668 / 518 | One party (EIP-1167 clone): deposits via factory, redeem, verified burn with the bounded price choice (`_burnPrice`), price governance, sale, claims. Runtime 24,304 B (272 B under EIP-170). | Yes, highest priority |
| `PartyFactory.sol` | 95 / 68 | Deploys clones (CREATE2 salt = host+nonce), routes deposits (only approval users give), EIP-712 floor verification, immutables incl. the traits table. No admin. | Yes |
| `CreditCards.sol` | 126 / 99 | Shared ERC-721 for all parties; per-(party, account) `Trace208` checkpoints for snapshot votes; on-chain SVG | Yes |
| `CreditKeys.sol` | 215 / 173 | Linked library: preset order verification against the sealed key table, rarity table, keccak Fisher–Yates; Time = ascending id | Yes |
| `CreditTraits.sol` | 101 / 76 | Sealed per-Credit trait table (SSTORE2 chunks, 3 bytes/id), so burns never call `CreditArt.describe` (`6190a7c`) | Yes |
| `StatementMarket.sol` | 147 / 102 | Holder resale: fixed-price listings, expiry, `cancelAll` nonce, 1% fee, seller push with pull fallback | Yes |
| `interfaces/IExternal.sol` | 46 / 34 | `ICredits`, `ICreditArt`, `ICreditTraits`, assumed `IStatement` | Yes (assumptions) |
| `testnet/TestnetPartyFactory.sol` | 23 | Short clock (`timeUnit`), refuses chainid 1 | Low |
| `testnet/KeyProbe.sol` | 25 | UI helper for keys/shuffle | Low |
| `mocks/MockStatement.sol` | 45 | Stand-in for the unpublished Statement contract | No (read for assumptions) |
| `script/DeployMainnet.s.sol`, `script/DeploySepolia.s.sol`, `script/TraitsTable.sol` | 51 / 104 / 37 | Deploy; mainnet has chain-1 guard, `CREDITS` address check and `TABLE_KECCAK` check | Review |

Not implemented anywhere: house-party creation, auction contract, launch lock (SPEC §4d); they need a separate contract
(§1.1).

### 2.2 Site and off-chain services

| Component | Files | Notes |
|---|---|---|
| API core | `lib/core.mjs` (1,754 lines) | All routes, rules engine mirroring Party.sol in BigInt wei (incl. the burn's price choice, `burnPrice:498`), auction simulation, gates |
| Storage | `lib/store.mjs` (105) | Neon Postgres: one JSON `state` row mutated under `SELECT … FOR UPDATE` per POST; tables `floors`, `nonces`, `owners`, `terms`, `ens`. File store for local dev. |
| Vercel entry | `api/index.mjs`, `vercel.json` | All `/api/*` rewritten to one function with `__path`; crons `/api/cron/floor` and `/api/cron/sync` every minute, `CRON_SECRET` bearer, constant-time compare, fail-closed; CSP/HSTS headers; `/sepolia*` redirects home |
| Local server | `server.mjs` | Same core on `127.0.0.1:8088`; floor every 60 s, sync every 30 s |
| Client | `public/app.js`, `public/wallets.js` (EIP-6963 picker), `public/wc.js` (WalletConnect), `public/index.html`, `style.css` | |
| Sepolia page | `web3/sepolia.mjs` → `public/sepolia.js` (`npm run build:web3`) | Deposits at most 40 Credits per transaction (open + 80 in one tx is 14.92M gas, too close to the cap); burn sends a floor reading when one is available |
| Sign-in / sessions | `lib/core.mjs:183-206, 1019-1074` | EIP-4361, terms text is the signed statement; nonce HMAC-bound; single-use nonce table; session = HMAC(address.expiry), HttpOnly SameSite=Strict, 7 days, stateless (no revocation) |
| Floor feed | `lib/core.mjs:239-277` | OpenSea API every minute, 25 h kept; `avg24h` or `latest` (stale after 2 h). Source: Statement collection floor once `STATEMENT_SLUG` is set, else 80 × Credits floor |
| Floor signer (EIP-712) | `lib/core.mjs:1122-1140` | **Sepolia only** (`/api/sepolia/floor`, needs `SEPOLIA_FLOOR_KEY`, chainId 11155111). No mainnet signer service exists yet. |
| Ownership sync | `lib/core.mjs:83-132` | Credits Transfer logs from snapshot block; `ownerOf` re-read at deposit before the lock (`:1716-1725`) and re-checked in the lock (`checkDeposit`, `:859`) |
| ENS | `lib/core.mjs:135-180, 1094-1113` | viem, `ccipRead: false` (`:73`), 6 s limits, only for addresses the site knows (`siteAddrs`, `:168`) |
| Tooling | `scripts/` (`fetch-chain`, `traits`, `slips`, `evm.mjs`, `diff/*`, `keytable/*`, `coverage.sh`, deploy scripts) | |

### 2.3 External dependencies and constraints

| Dependency | Facts (verified by the team; SCOPE.md §5.2) |
|---|---|
| Credits `0x97630aa70ab14ed9883b41dafccbc11349723043` | OZ ERC-721 + Ownable, sealed (`isSealed()` true, `sealedAt` 1790181707), supply 122,154 fixed. `burn(address owner_, uint256[] ids) returns (bytes21[] seeds)`: needs sealed, non-empty ids, caller is owner or approved-for-all; duplicates revert; burned id → `ownerOf` reverts `ERC721NonexistentToken` (`0x7e273289`). No ERC-2981. Source copy `research/Credits.sol` = `contracts/test/credits/Credits.sol`. |
| CreditArt `0xFbE816B82547B483C7DFfC5b14C75eC84f8c1985` | `describe(bytes21 seed, uint64 paidAt)` is `pure`; source of every trait; sealed into `CreditTraits` at deployment |
| Statement contract | **Unpublished** (drop expected ~2026-10-01 to 10-02 per jack.art). Assumed `make(uint256[] ids) returns (uint256)` burns the caller's 80 in order and mints to the caller; unrestricted `transferFrom`; contract callers allowed (`IExternal.sol`; SCOPE §5.3 lists 7 assumptions). An adapter and a new factory may be needed. |
| OpenZeppelin 5.4.0 (vendored) | ERC721, Checkpoints, Clones, Initializable, ReentrancyGuardTransient (needs EIP-1153), MerkleProof, EIP712, ECDSA |
| OpenSea API | Floor readings (`OPENSEA_API_KEY`), listings of the Statement collection once known |
| RPC | Mainnet via `ETH_RPC` (default `https://ethereum-rpc.publicnode.com`, 8 s timeout, 1 retry, `lib/core.mjs:70-73`) |
| EIP-7825 | 16,777,216 gas per transaction. Binding for `assemble` (80-Credit burn) and `createParty` + 80 deposits (§6.5). `test/gas/Cap.t.sol` asserts under the cap. |
| EIP-170 | 24,576-byte runtime limit. Party is 24,304 bytes (272 spare); CreditKeys is a linked library for this. Re-measure: `forge build --sizes`. |

---

## 3. Trust model and roles

| Role | Can | Cannot | Where |
|---|---|---|---|
| **Host** (creator; one per party) | Set params at creation (immutable): eligibility Merkle root, minDeposit, duration 1–60 d, vote window, preset/seed, default price, floor mode, `minAskWei`, default buy wait 0–72 h. Manual preset: burn with any order within `MANUAL_GRACE` (1 day) of FULL. `transferHost`. | Edit params, close early, veto, move funds, act after the 1-day Manual window except as a card holder | `Party.sol:170-191, 289-298, 608-612` |
| **Card holder** | Redeem (OPEN/EXPIRED), propose/vote/execute prices, burn auto presets (and Manual after grace, Time order), claim 1/80 | Redeem while FULL; vote with cards acquired at/after the snapshot block; propose in the fill block | `Party.sol:248-270, 402-499, 565-580` |
| **Anyone** | `redeemFor` after expiry (pays holder), `claimFor` after sale (pays holder, 50k stipend, else `owed`), `countBlocked`, `raiseAsk`, `buy`, `withdraw` own `owed` | | `Party.sol:253, 502, 529, 540, 583, 599` |
| **Burner** (assemble caller) | Chooses which valid floor reading of the last 10 minutes the burn uses: it resolves a floor-relative ask **and** decides which voted prices still pass (41 vs 60) | Choose the order for auto presets (exactly one order verifies); skip a Fixed voted price by omitting the reading (`floor needed`) | `Party.sol:289-384` |
| **Floor signer** (one immutable EOA per factory) | Sign `Floor(floorWei, mode, issuedAt)`; accepted by **every** party with that `floorMode` for 10 min; sets floor-relative asks at burn/execute/raiseAsk and decides 41 vs 60 at execute and at the burn | Move funds or tokens; push a floor-relative ask below the host's `minAskWei` | `PartyFactory.sol:87-93`, `Party.sol:622-646` |
| **Fee recipient** (immutable) | Pull 1% + dust per party and per market sale | Anything else | `Party.sol:554`, `StatementMarket.sol:107-128` |
| **Collection owner** (`CreditCards.owner()`) | Edit the OpenSea collection page | Anything on-chain: no function checks `owner()` | `CreditCards.sol:20-22` |
| **Factory** | Register parties, route deposits (`transferFrom(msg.sender, party, id)` only), verify floor sigs | Move Credits from anyone but its caller; no admin/pause/upgrade | `PartyFactory.sol:46-67` |
| **Statement contract** (trusted, immutable in factory) | Operator over the party's Credits during `make` only; gates `buy` via `transferFrom` | Keep Credits (burn is verified) | `Party.sol:336-350` |
| **Site operator** | Runs the preview DB, floor feed, Merkle roots, SIWE sessions (`SESSION_SECRET`), crons, the public dev-mode preview; in future the floor key | Nothing on-chain beyond the floor key (not yet deployed) | §2.2 |

---

## 4. Intended rules (authoritative) and where enforced

"C" = contract (`Party.sol` unless named), "S" = site (`lib/core.mjs`). Hosted (FULL-mode) rules first; launch rules in
§4.2. SPEC.md v0.8 is the product spec; where SPEC and code differ, ask the owner.

### 4.1 Hosted parties (contracts + site)

| # | Rule | C | S |
|---|---|---|---|
| R1 | Users approve only the factory. Factory moves only its caller's Credits into its own parties; party records only Credits it received, only when called by the factory. | `PartyFactory.sol:58-67`, `onDeposit:217-246` | `checkDeposit:859` |
| R2 | Deposit count between min(minDeposit, remaining) and remaining; Merkle eligibility; no duplicates; one card per Credit to depositor. | `:217-238` | `checkDeposit` |
| R3 | 80th deposit sets `fullAt` and `fullBlock`; deadline pushed to ≥ now + 2 days (`FILL_GRACE`). | `:239-244` | `markFull:393` |
| R4 | Redeem only OPEN or EXPIRED, only by/for the current card holder; card burned. | `:248-270` | withdraw/return routes `:1351, 1527` |
| R5 | Auto presets: any current card holder burns; exactly one order verifies. Manual: host only until `fullAt + 1 day`, then any card holder with Time (ascending id) order. | `:289-298`, `CreditKeys.verifyOrder` | `:1459-1487` |
| R6 | Burn verified: Statement received, and all 80 `ownerOf` revert with `0x7e273289`. Statement approval only for the `make` call. | `:336-350` | n/a (simulated) |
| R7 | Only prices are governed (LIST, CANCEL). Weight = cards at `block.number − 1` at creation; no proposal in the fill block (`just filled`). Windows 1/24/48/72/168 h; CANCEL 24 h. Max 3 open per proposer. | `:402-427, 660-662` | `:1369-1404`; site adds 12 proposals/member/party/24 h, keeps last 200 closed (`:395, 459`) |
| R8 | Pass: YES ≥ 41 and NO = 0. LIST below the floor at execution: 60. Deadlock (≥ 3 counted blocked LISTs, or > 30 days since last execution/assembly/FULL): proposals created then pass at max(need, 54), NO ignored. Fixed LIST with no reading: treated as below floor (60). | `needFor:455-460`, `execute:462-499`, `_deadlocked:512-516` | `tally:426`, `deadlocked:468` |
| R9 | `countBlocked`: current-epoch, closed, unexecuted, non-deadlock LIST with YES ≥ 41 and NO > 0; counter resets on any execution. | `:502-510` | `canCountBlocked:450` |
| R10 | Execute within 7 days of close; any execution or burn bumps `priceEpoch` and supersedes all others. | `:462-480, 334` | `isSuperseded:445` |
| R11 | Floor reading: signer-signed, ≤ 10 min old (real time), never older than the last used by the party, 0 < floor ≤ 1e30. | `_floor:622-629` | preview uses server floor |
| R12 | Floor-relative prices clamp to ≥ `minAskWei` (required > 0 for any floor-relative default or proposal), including results ≤ 0 (Pashov M3), and need buy wait ≥ 1 h; Fixed prices are never clamped. | `:181-182, 413-414, 636-646, 656-658` | `delayOk:389`, `minAskWei:544`, `resolvePrice` |
| R13 | Asks only rise via `raiseAsk` (anyone, floor-relative only); `buyableAt` unchanged. | `:529-536` | `:1428` |
| R14 | Sale: `buy(maxPrice)` after `buyableAt`; fee 1% (+ dust < 80 wei) to fee recipient (pull); `perCard = (price − fee)/80`; excess refunded; **no royalty** (`Sold.royalty` = 0). | `:540-562` | `saleSplit:590` |
| R15 | Statement leaves only via `buy` (store-only). No offers/auctions for hosted parties. | no other transfer path in Party | `STORE_ONLY:849` |
| R16 | Claims: holder `claim` (card burned) or anyone `claimFor` (push, 50k gas, else `owed`). | `:565-596` | `:1604-1626` |
| R17 | No direct ETH; unsolicited ERC-721 safe transfers rejected except the Statement mint during `assemble`. | `:394-397, 665-667` | |
| R18 | Resale: seller lists owned, approved Statement; live only while seller owns it, approved, unexpired (`list` 30 d, `listFor` ≤ 180 d), and no `cancelAll` since; 1% fee, seller push 50k with pull fallback. | `StatementMarket.sol:61-128` | `/api/statements/:id` `:1246-1279` (403 in launch mode) |
| R19 | Site: settings lock once anyone else deposits; host can transfer hosting; terms + rules versions required on mutating routes; POSTs from other origins 403. | n/a | `:1627-1631, 1517, 988` |
| R20 | **Price at the burn** (Pashov H2, re-audit M-1/M-2). A LIST that first reaches 41 YES before the burn is recorded once, in that order, per price epoch. The burn judges only the latest 8 (`BURN_CANDIDATES`) plus the LIST executed while FULL; each with its final tally at **the burn's** floor reading, as `execute` judges (below floor 60, deadlock 54, any NO blocks unless deadlocked). First the highest-id candidate that is closed, in its execute window, unexecuted and passes (applied as if executed); else the executed-while-FULL price if it still passes; else the host default. A Fixed price at 41–59 YES with no reading refuses the burn (`floor needed`). Every price live at the burn waits ≥ 1 h. So a price executed while FULL is **pending**, not guaranteed. | `assemble:302-322`, `_burnPrice:359-374`, `_passesHere:376-384`, `_vote:446-450`, `execute:486-490` | `burnPrice:498`, `passesHere:485`, `noteCandidate:479` (propose `:1403`, vote `:1415`), execute resets the list `:1452`; UI "Pending price … depends on the floor at the burn" (`public/app.js:428`) |

### 4.2 Launch (house parties) — site only today; contract design SPEC §4d

| # | Rule | Site | Contract |
|---|---|---|---|
| L1 | Four hostless parties, fixed id ranges (§1.2), Time order, any card holder burns at 80 | `:712-731, 1482` | **Not implemented** (D-5); must be a separate contract (§1.1) |
| L2 | Burn requires a Credits floor reading; reserve = 100 × 24 h avg Credits floor | `:1492-1497, 588` | Not implemented |
| L3 | English auction: first bid ≥ reserve, +0.1 ETH steps, 24 h from first bid, +5 min anti-snipe, no end/fallback before first bid, outbid refunded at once | `:1547-1572, 594` | Not implemented |
| L4 | Settle by anyone after end; split like a sale; no price votes, `raiseAsk` or `buy` during the auction | `:1573-1590, 1371` | Not implemented (D-4, D-6) |
| L5 | Full mode (hosted parties, profiles, resale) locked until a Minute auction settles with a winner; locked routes 404/403 | `:710, 1000, 1257, 1293, 1666` | Not implemented (no on-chain launch lock) |

---

## 5. Invariants

Full lists: `docs/audit/INVARIANTS.md` (I-1…I-43; written at `5040009`, I-42/I-43 added at `e23f1e8`) and
`contracts/x-ray/invariants.md` (untracked, at `d548e55`). Summary of what must hold:

| Invariant | Statement | Enforced | Tested |
|---|---|---|---|
| ETH conservation | Before SOLD the party holds 0 accounted ETH. After: `balance == Σ owed + perCard × cardsOutstanding`; `fee + dust + 80·perCard == price`, `dust < 80`. | `buy`, `claim`, `claimFor`, `withdraw` | `test/invariant/PartyInvariants.t.sol:213-216` (I5); unit/Sale; Halmos `Party.halmos.t.sol` split |
| Card ↔ Credit 1:1 | Pre-burn: live cards of P ↔ Credits in `_order` bijectively; party holds exactly `count()` Credits; `cardsOutstanding == _order.length`. | `onDeposit`, `_redeem` | invariant I1 (`:124-152`) |
| Weights | Σ `heldNow(P,·)` = live cards of P ≤ 80; snapshots immutable; `yes + no ≤` snapshot weight. | `CreditCards._update:71-83`, `_vote` | invariant I2, I6 (`:132-192`) |
| Order immutability | Auto preset: exactly one accepted order; burn order is a permutation of the 80; stored as `burnOrderHash`, order emitted. | `CreditKeys.verifyOrder`, `assemble` | unit/Assemble, KeysSpec, Halmos keys/perm/shuffle, diff Presets* |
| Vote snapshot | Weight at `block.number − 1`; cards bought in or after the creation block carry none; no proposal in the fill block. | `propose:408`, `_vote:437-441` | invariant I6; Findings3 L4 tests |
| Burn price bounded (I-42) | The burn does at most 8 candidate judgements + 1, whatever the proposal count. | `_burnPrice:359-374` | unit/ReAudit `test_M1_*` (5,000 spam proposals change burn gas by < 20k) |
| Burn price re-judged (I-43) | A voted price goes live at the burn only if it passes at the burn's floor with its final tally. | `_burnPrice`, `_passesHere` | unit/ReAudit `test_M2_*`, invariant model (`Handler.sol`), diff scenarios S7a–S7e |
| Custody paths | Credits leave only by redeem/redeemFor or burn; the Statement leaves only by `buy`; ask changes only by vote/raise. | whole contract | Handler `_fail` checks I3/I4/I7 (`Handler.sol:145-184`) |
| No stuck funds | After all claims: party ETH 0; after full `redeemFor` on expiry: party Credits 0. | | invariant I8/I9 (`:218-239`) |
| Status monotone | OPEN→FULL→ASSEMBLED→SOLD; OPEN/FULL→EXPIRED; ASSEMBLED never expires. | `status:199-204` | unit tests |
| Floor | Reading monotone per party; `0 < floor ≤ 1e30`; floor-relative ask ≥ `minAskWei`. | `_floor`, `_clampMin` | unit/Floor, Fixes, Findings3; Halmos resolve |

Auction invariants (design only, SPEC §4d): auction balance == high bid + Σ pull balances; the Statement is always in
the auction, with the winner, or (before burn completes) in the party.

---

## 6. Findings history

Status keys: **FIXED** (commit), **OPEN**, **PENDING DECISION**, **ACCEPTED** (rationale), **MOOT** (royalties
removed in `f06b3c5`).

### 6.1 Contracts

Latest re-audit report (Pashov solidity-auditor, 2 passes, memory at `d548e55`):
`contracts/.solidity-auditor/runs/20260924-155040/full-report.md` (untracked). The first scan is
`runs/20260924-135350/full-report.md`.

| ID | Source | Finding | Status |
|---|---|---|---|
| T-1 | Static triage (`contracts/audit/static/TRIAGE.md`) | Lifetime `MAX_PROPOSALS = 256` exhausted by one card rotated over fresh addresses → governance frozen forever | FIXED `884add5` (per-proposer open list, `_refreshOpen:518-524`) |
| T-2 | Static | One holder self-NO's 3 proposals → permanent deadlock mode | FIXED `884add5` (YES ≥ 41, current epoch, reset on execute). Re-raised in a stronger form as Pashov H1 (ACCEPTED). |
| T-3 | Static | 24 h buy delay == min window → CANCEL can never beat `buy` | Changed `89f4ff3`: buy wait is voted per price (0–72 h). A wait > 24 h lets a cancel land first; a short wait lets the sale win. ACCEPTED by design (`test_cancelRace_shortWait_saleWinsByDesign`, Fixes.t.sol:483). |
| T-4 | Static | Floor key sets low asks; reading cherry-pick; every LIST execution needs the key | FIXED `884add5` (monotone readings, host `minAskWei`, Fixed LIST executes without floor at 60) + `7a9766e` (10-min age) + `5e54449` |
| T-5 | Static | Royalty decode bricks `buy` / silent skip | FIXED `884add5`, then MOOT `f06b3c5` |
| T-6 | Static | No post-assembly exit; stranded shares for contract holders | `claimFor` added `884add5` (FIXED). No exit when unsold: ACCEPTED (SPEC: Statements cannot be split back; THREAT_MODEL R-13) |
| T-7 | Static | Missing events | FIXED `884add5` (`BlockedCounted`, `Withdrawn`, `PendingPriceSet`, `PartyRegistered`) |
| Slither/Aderyn | Static | 21 + 14 groups; 0 + 1 true positives (A-L6 = T-7) | Triage in TRIAGE.md; rest FALSE POSITIVE/ACCEPTED |
| F1–F3 (invariant) | `test/invariant/Findings.t.sol` | Self-NO deadlock; proposal cap; deadlock clock ignored assembly | FIXED `884add5` (clock from last execution, else assembly, else FULL: `_deadlocked:512-516`) |
| F1–F4 (unit) | `test/unit/Findings.t.sol` | Same as T-1/T-2, counter reset, short royalty return | FIXED `884add5`; F4 MOOT |
| F2-1 | `test/unit/Findings2.t.sol` | Fixed-default party with `minAskWei = 0` votes a floor-relative LIST → 1-wei ask | FIXED `5e54449` (`propose:413`). Test header still says "FAILS"; stale comment. |
| Mutation | slither-mutate, `contracts/audit/mutation/` | Surviving mutant showed a floor-relative ask could resolve to 1 wei on a bad floor | FIXED `5e54449`. Scores after kills (at the time): Party ≥ 92.2% (1378/1495), CreditKeys ≥ 88.9% (536/603), `after-score.txt`. Not re-run after `6190a7c`/`e23f1e8`. |
| Halmos | `test/halmos/Party.halmos.t.sol` | Counterexample: floor ≥ 2^255 wraps negative in `int256` cast | FIXED `9ef9442` (`floorWei ≤ 1e30`, `Party.sol:627`) |
| Audit 3 #1 | external review 3 | Royalty stipend | Changed to 150k, then MOOT `f06b3c5` |
| Audit 3 #2 | external review 3 | Floor cherry-pick (1 h age) | FIXED: source in `7a9766e` (commit message is about the site log, but it carries the Party/StatementMarket changes); tests/docs in `856348d` |
| Audit 3 #3 | external review 3 | Burn check accepted a Statement that kept/moved the Credits | FIXED `7a9766e` (`0x7e273289` check, `Party.sol:343-349`) |
| Audit 3 #4 | external review 3 | StatementMarket stale listing revival | FIXED `7a9766e` (expiry + `cancelAll`), `7c33264` (cancel when `ownerOf` reverts). Residual revival within expiry: ACCEPTED (documented) |
| Royalty | owner decision | Creator royalty (ERC-2981) leg in Party and StatementMarket | Removed `f06b3c5` (cap lowered `8a98007` before). **All royalty findings MOOT.** |
| **H1** | Pashov 1st scan #1 [90]; re-raised as re-audit #1 [90] "KNOWN: R-2 (ACCEPTED)" | `countBlocked` fast path: a coalition's own NO counts and 41 (not the real threshold) qualifies; with 1 h windows, 60 cards can reach deadlock and sell below floor/for the minimum within about 2 h of the burn | **ACCEPTED** (user decision 2026-09-24; THREAT_MODEL R-2). The existing trigger stays: after 3 blocked price proposals or 30 days, 54 YES passes and NO is ignored (60 below floor). A holder group with 54+ cards (60 for below-floor) can self-block with its own NO and reach the override quickly. |
| **H2** | Pashov #2 [85] (THREAT_MODEL R-7) | Assemble superseded a passed-but-unexecuted FULL-phase price: one card holder burns first, the host default goes live, and with a 0 h wait buys at once | **FIXED `627e9cf`** (burn applies the newest passed-but-unexecuted LIST as if executed; every price live at the burn waits ≥ 1 h); refined by `e23f1e8` (M-1/M-2 below). Tests: unit/Findings3 `test_H2_*`, diff/DeadlockDiff S5. Site mirror `e031ad4`, then `e2586f3`. |
| **M3** | Pashov #3 [80] | `_resolveWith` reverted on `r ≤ 0` before `_clampMin`, so a floor ≤ a negative FloorDelta (or FloorPct rounding to 0) blocked assemble/execute/raiseAsk | **FIXED `8e8efa5`** (`r ≤ 0` resolves to 0, then clamps to `minAskWei`, `Party.sol:640, 646`; `test_minAsk_nonPositiveResolveClamps`, Fixes.t.sol:597). Site mirror `e031ad4`. |
| **L4** | Pashov #4 [60] | A proposal in the block that fills slot 80 snapshots `block.number − 1`, so the last depositors had no weight (could not veto) on it | **FIXED `f16d5cb`** (`propose` refuses `block.number <= fullBlock`, `Party.sol:408`). Site mirror `e031ad4` (same whole second as the fill refused, `lib/core.mjs:1376`). |
| P-5 | Pashov 1st scan #5 [55] | A Fixed price passed while FULL goes live at the burn with no new floor check | Superseded by re-audit M-2: **FIXED `e23f1e8`**. |
| **M-1** | Re-audit #3 [80] | One card holder rotated over addresses adds proposals until the burn's scan over every proposal passes the 16,777,216 gas cap (~7,450 gas each; ~1,650 proposals bricked the burn) | **FIXED `e23f1e8`**: candidates are recorded in `_vote` when a LIST first reaches 41 YES while FULL (`_passedIds[epoch]`, `Party.sol:446-450`); the burn judges at most the latest 8 (`BURN_CANDIDATES`, `:59`) plus the executed-while-FULL price. 5,000 spam proposals change burn gas by < 20k (unit/ReAudit `test_M1_spam1650_burnStillUnderCap`, `test_M1_spam5000_burnGasUnchanged`, `test_M1_candidatesBounded`). **Residual (ACCEPTED, THREAT_MODEL R-7):** a group that can put 41 YES on proposals can push older candidates out of the 8-entry window; such a group can pass its own price anyway. Site mirror `e2586f3` (scenario S7d). |
| **M-2** | Re-audit #2 [85] | A price that passed with 41 votes while FULL (executed or not) went live at the burn below the burn's floor | **FIXED `e23f1e8`**: every candidate and the executed-while-FULL price (`_pendingId`) is judged with its final tally at the burn's floor as `execute` judges (`_burnPrice:359-374`, `_passesHere:376-384`); failing ones are skipped; a Fixed price at 41–59 YES with no reading refuses the burn (`floor needed`). Tests: unit/ReAudit `test_M2_floorRelativePending_rejudgedAtBurn`, `test_M2_fixedPending_rejudgedAtBurn`, `test_M2_pendingWith60_stillLiveBelowFloor`, `test_M2_pendingNeedsFloorReading`; invariant model. Site mirror `e2586f3` (S7a–S7c, S7e). |
| Pashov leads | 1st scan "Leads"; re-audit "Leads" (16 entries, bodies missing from the report) and "Known from earlier scans" | Gas test covers 5 of 11 presets; deadlock clock/counter survive burn; testnet `timeUnit < 600 s` makes buy wait < floor age; Statement approval covers stray Credits; burner/executor/raiseAsk choose the reading (R-6); Manual host with no cards picks the order; `raiseAsk` unguarded during `make`; `redeemFor` pushes to contract holders; floor sig not party-bound (R-4); StatementMarket buyer callback before seller payment; "41 holders vote a price at the floor and one of them buys" | Unscored leads; OPEN for review. The re-audit's lead lines were not written to the report (tool output defect); the leads are in `contracts/.solidity-auditor/memory.tsv`. |
| Gas | `3953c99`, `6190a7c`, `test/gas/*` | Cold burn cost exceeded half the cap for sorted presets (Rarity ≈ 12.8M before the key table) | Reduced by `6190a7c` (sealed key table, no `describe` calls at the burn). Current figures §6.5. Real Statement mint cost unknown. |

### 6.2 Design review of SPEC §4d (`contracts/.solidity-auditor/design-review-spec-4d.md`, untracked)

| ID | Item | Status |
|---|---|---|
| D-1 | Reserve never met → Statement held forever (no end, no fallback, no vote) | **ACCEPTED by owner decision:** the auction simply waits for its first bid; there is no timer, end or fallback before it. |
| D-2 | Signer compromise or burner cherry-pick sets the reserve; key shared by all parties | OPEN (design) |
| D-3 | Settle must not `safeTransferFrom` to the winner | OPEN (design) |
| D-4 | Party cannot receive auction proceeds (`receive` reverts; `sold/perCard` set only in `buy`); EIP-170 headroom | OPEN (design). Headroom is now 272 bytes: the auction must be a separate contract (§1.1). |
| D-5 | Hostless creation does not fit `createParty` (host = sender, opening deposit required) | OPEN (design) |
| D-6 | Party sale path/governance must be disabled for house parties | OPEN (design) |
| D-7 | Auction reentrancy and accounting invariant under refund push | OPEN (design) |
| D-8 | Anti-snipe extension uncapped | OPEN (design; likely ACCEPTED) |
| D-9 | Royalty leg in "split like a sale" | FIXED in SPEC (§4d settle split says "no royalty") |
| D-10 | Burn liveness depends on the signer | OPEN (design; failure mode is expiry, Credits returned) |

### 6.3 Site

| ID | Source | Finding | Status |
|---|---|---|---|
| S-1 | `docs/security/SITE-AUDIT.md` first pass #1 (HIGH) | Terms records bloat the shared state doc (DoS) | FIXED `0b37d4b` (own `terms` table, sig cap, rate limit) |
| S-2 | #2 (MED) | Every POST took the global row lock; RPC under lock | FIXED `0b37d4b` (lock-free read-only POSTs, `:1715`), `1d26cea`/`03db3bb` (ownerOf pre-read outside the lock) |
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
| S-23 | 23-item site audit batch (`docs/security/SITE-AUDIT.md`, "second pass"; items 2, 5, 19 concern the contracts/SPEC) | Unbacked bids, RPC errors read as burned, CCIP-read SSRF, ENS write amplification, proposal pile-up, Party.sol parity, auctions missing from the gallery, stale gas figures, chunked bodies, Origin 500, pre-gate ownership read, floor window/staleness, `/sepolia` routing, dead settle path, float settlement, stale full-mode text, cron cold start, opening-bid rounding | **FIXED**: `704a42a`, `03db3bb`, `2056afe`, `f06b3c5`, `41652cb`, `bed9a2c`, `fa757bf`, `3953c99`, `165a33e` (the range `704a42a..165a33e`), plus `e031ad4` (site mirrors Party.sol `f06b3c5..627e9cf`). 49 local production-mode checks passed (SITE-AUDIT.md). |
| S-mirror | Contract change `e23f1e8` | Site previewed a price executed while FULL as guaranteed and did not re-judge voted prices at the burn floor | **FIXED `e2586f3`** (`burnPrice` mirrors `_burnPrice`; pending UI; full Rule 06, rules `.9`); `b1279b3` (Sepolia page: Manual after grace sends ascending ids; burn sends a floor reading when available). Diffs: rules 3000/3000, scenarios 0 diffs (S7a–S7e added). |

### 6.4 Stale statements in older docs (do not rely on them)

- THREAT_MODEL header says `5040009`; R-1 (256-proposal cap), R-3 (fixed 24 h `BUY_DELAY`), R-5 (Fixed LIST needs the
  key) still read "Open" and are superseded by T-1, T-3, T-4 above; R-14 (no `claimFor`) is superseded by `claimFor`.
  (R-7, R-12, R-21 were updated.)
- ARCHITECTURE header says `5040009`; §4/§6 "buy ≥ askLiveAt + 24h" (lines 63, 208), "Assembly does not update since"
  (line 122) and §9 "`claim` by the holder only" (line 178) are superseded. Its `assemble` section (line 148) is current.
- INVARIANTS header says `5040009`; I-42/I-43 are current.
- SCOPE.md §1 freeze commit `5040009` is obsolete.
- PRE_MAINNET.md "Open work" still lists H2, M3, L4 as in progress (FIXED, §6.1) and the site mirror as open (done in
  `e031ad4`, `d548e55`, `e2586f3`); its gas line gives the before-refund figure (5.14M worst), see §6.5.
- `contracts/x-ray/` is at `d548e55` (before `e23f1e8`) and untracked.

### 6.5 Gas (EIP-7825 cap 16,777,216 per transaction)

| Operation | Gas | Source |
|---|---|---|
| Burn (`assemble`), paid (after refunds), cold, with MockStatement | Deposit/Number/Time 3.95–3.97M, Manual 3.98M, Random 4.04M, Print/Weight/Eights/Ink 4.10–4.12M, Colors 4.11M, Rarity 4.16M; **plus the real Statement mint, unknown** | `test/gas/Cap.t.sol`, `Breakdown.t.sol --isolate`; `lib/core.mjs:34-40` |
| Burn before refunds (what the cap applies to) | 4.88M (Deposit) to 5.14M (Rarity), of which the mock mint is 1.51M | THREAT_MODEL R-12, PRE_MAINNET |
| Burn with 5,000 spam proposals | < 20k more than without (M-1 fix) | unit/ReAudit |
| `createParty` + 80 deposits in one transaction | 14.92M (1.86M under the cap) | PRE_MAINNET, `Cap.t.sol`; the site's Sepolia page therefore caps deposits at 40 per transaction (`d548e55`) |
| Key table deployment (`CreditTraits`, mainnet) | ≈ 81.2M gas in 16 transactions (largest 5.39M) | PRE_MAINNET |
| Party runtime size | 24,304 B (272 B under EIP-170) | `forge build --sizes` at `e23f1e8` |

### 6.6 Coverage (`scripts/coverage.sh`: `forge coverage --ir-minimum`, `src/` only, fork suites included)

| Scope | Lines | Branches |
|---|---:|---|
| Total (`src/`) | 95.9% | 91.1% |
| `CreditTraits.sol` | 82.5% | 57.1% |
| `PartyFactory.sol` | | 50% |
| `StatementMarket.sol` | | 70% |

The low branch figures are the ones to read first; `--ir-minimum` source maps can be slightly off (forge warning).

---

## 7. Known gaps, not built, decisions pending

1. **House-party contracts** (hostless creation, auction, launch lock): not implemented; SPEC §4d design only; D-2…D-8,
   D-10 open. Party has 272 bytes of EIP-170 headroom, so this code must live in a separate contract. Until built,
   launch mode exists only in the preview.
2. **D-1** reserve never met: ACCEPTED (auction waits indefinitely for the first bid).
3. **Deadlock trigger** (H1): ACCEPTED as designed by the user; no change.
4. **Burn candidate window** (M-1 residual): a 41-YES group can push older candidates out of the 8-entry window;
   ACCEPTED.
5. **Burn gas vs the cap:** paid 3.95–4.16M (before refunds up to 5.14M) excluding the real Statement mint, whose cost
   is **unknown**. Re-measure with the real Statement (PRE_MAINNET).
6. **Statement contract**: ABI and behavior unknown (drop expected ~2026-10-01 to 10-02). Adapter or factory redeploy
   likely.
7. **Sepolia**: v1 is stale (older rules). Redeploy after the above lands (`scripts/deploy-sepolia.sh`).
8. **Mainnet params** not chosen: `FEE_RECIPIENT`, `FLOOR_SIGNER` (and its key custody/rotation; it is immutable),
   `COLLECTION_OWNER`, `STATEMENT` address, CreditTraits table deployment. Full list: [PRE_MAINNET.md](PRE_MAINNET.md).
9. **Mainnet floor-signing service** does not exist (only `/api/sepolia/floor`). With M-2, a burn with a voted Fixed price
   at 41–59 YES needs a reading, so the burn's liveness depends on the signer too (D-10).
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
forge build --sizes                                   # EIP-170 headroom (Party 24,304 of 24,576 bytes)

# Local suites (no RPC): unit, market, invariants, smoke
forge test --match-path 'test/unit/*' --no-match-contract PresetsForkTest
forge test --match-path 'test/unit/ReAudit.t.sol' -vv  # M-1 / M-2 regressions
forge test --match-path 'test/market/*'
forge test --match-path 'test/LocalSmoke.t.sol'
forge test --match-path 'test/invariant/*'            # runs=256 depth=100 (foundry.toml); also Findings regressions

# Mainnet-fork suites (fork block 26044000; need an archive-capable RPC)
export ETH_RPC_URL=<mainnet rpc>
forge test --match-path 'test/Lifecycle.t.sol'
forge test --match-contract PresetsForkTest
forge test --match-path 'test/gas/Cap.t.sol' -vv      # asserts open+deposit and burn < 16,777,216
forge test --match-path test/gas/Breakdown.t.sol --isolate -vv   # cold per-preset burn cost
forge test                                            # everything

# Differential suites (site logic vs contracts) need an unbounded gas limit
forge test --match-path 'test/diff/{PresetsDiff,PresetsE2EDiff,TraitsDiff,DeadlockDiff}.t.sol' \
  --gas-limit 9223372036854775807 -vv
```

Full differential run (site `lib/core.mjs` vs contracts; needs `ALCHEMY_API_KEY`; it rewrites
`contracts/data/diff/*.json`, restore them with `git checkout contracts/data/diff/` afterwards):
```bash
bash scripts/diff/run-all.sh      # corpus checks, 500+16 preset sets, 3000 rules cases, scenarios S1–S7, rules-compare
```
Expected at `b1279b3`: rules 3000/3000 agreeing, exact prices; scenarios all SAME (23 rows).

Coverage:
```bash
bash scripts/coverage.sh          # §6.6; INV_RUNS (default 64) sets invariant runs
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

Key table (sealed trait table vs the live art contract; every step must report 0 mismatches):
```bash
bash scripts/keytable/verify.sh
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

### 8.2 Site

```bash
npm ci
node server.mjs                                  # dev: http://localhost:8088, file store in data/, DEV gates OFF
NODE_ENV=production SESSION_SECRET=$(openssl rand -hex 32) node server.mjs   # realistic: launch 404s on, no dev routes
npm run build:web3                               # rebuilds public/sepolia.js and public/wc.js from web3/
```
- Test on a copy: `data/*.json` is the local file store; copy the checkout (or `data/`) before writing to it.
- Dev sign-in (dev only; absent in production): `POST /api/auth/dev` with
  `{"address":"0x…","accept":true,"rules":true}` and `Origin: http://localhost:8088`, `content-type: application/json`.
  Dev also exposes `/api/dev/advance` (clock) and `/api/dev/fork`.
- Production-mode sign-in needs a real EIP-4361 signature: `POST /api/auth/nonce` → sign → `POST /api/auth/verify`.
- Without `DATABASE_URL` (or outside production) the file store is used. Do **not** point at the production DB;
  `ALLOW_DEV_DATABASE=1` overrides the guard and must not be used for testing.
- Probe production with GET and rejected inputs only. The public full-launch preview (§1.1) is dev mode: use it to see
  full-mode behavior, not to test gating.

Data regeneration (not needed to audit): `node scripts/fetch-chain.mjs` (`ALCHEMY_API_KEY`), `node scripts/traits.mjs`
(anvil), `node scripts/slips.mjs`, `scripts/keytable/build.sh`.

### 8.3 Environment variables (names only)

| Var | Used by | Purpose |
|---|---|---|
| `ETH_RPC_URL` | forge fork suites, deploy scripts, `coverage.sh` | Mainnet RPC |
| `ALCHEMY_API_KEY` | `scripts/diff/run-all.sh`, `scripts/coverage.sh`, `scripts/fetch-chain.mjs` | RPC for diff, coverage and snapshot |
| `NODE_ENV` | site | `production` disables dev routes, enables gates, requires `SESSION_SECRET` |
| `SESSION_SECRET` | site | HMAC for sessions and nonces |
| `DATABASE_URL`, `ALLOW_DEV_DATABASE` | `lib/store.mjs:102` | Neon Postgres; guard |
| `CRON_SECRET` | `api/index.mjs` | Cron bearer |
| `ETH_RPC` | `lib/core.mjs:70` | Site mainnet RPC |
| `OPENSEA_API_KEY`, `STATEMENT_SLUG` | floor feed, listings | |
| `WALLETCONNECT_PROJECT_ID` / `REOWN_PROJECT_ID` | WalletConnect | |
| `SEPOLIA_FLOOR_KEY`, `SEPOLIA_FACTORY` | `/api/sepolia/floor` | Sepolia-only signer |
| `PORT` | `server.mjs` | default 8088 |
| `CREDITS`, `STATEMENT`, `FEE_RECIPIENT`, `FLOOR_SIGNER`, `COLLECTION_OWNER`, `CONFIRM_MAINNET`, `ETHERSCAN_API_KEY`, `DEPLOY_SIGNER_ARGS` | mainnet deploy | |
| `SEPOLIA_RPC_URL`, `TEST_HOLDERS`, `PER_HOLDER`, `TIME_UNIT`, `EXISTING_*`, `CREDIT_KEYS` | Sepolia deploy | |

---

## 9. Where to look hardest (ranked)

1. **`assemble` and `_burnPrice`** (`Party.sol:289-384`): the candidate list (`_vote:446-450`: recorded only when
   `!assembled && !cancel`, keyed by the proposal's epoch, never re-added once listed), the 8-entry window and the
   `found && cid < id` skip, the revert-on-first-unjudgeable order (`floor needed` fires on the first Fixed candidate
   that fails without a reading, even if an older one would pass), the executed-while-FULL path not re-marking
   `executed`, the burner's choice of reading (it now decides which voted prices survive), who may call (Manual grace
   boundary `<=`), `setApprovalForAll` scope (every Credit the party holds, including strays), `_assembling` window,
   `onERC721Received`, burn verification exactness, reentrancy through the Statement into unguarded
   `propose/vote/countBlocked/raiseAsk/transferHost` (a `vote` during `make` sees `assembled == true`).
2. **`Party.sol` governance** (`propose`/`_vote`/`execute`/`countBlocked`/`_deadlocked`, `:402-516`). H1 is accepted:
   quantify the cheapest path to NO-ignored mode with 1 h windows and 3 open proposals per address anyway. Check
   epoch/supersede interplay with `assemble`, the fill-block refusal (`fullBlock`), vote changes after window close, and
   `execute` choosing between "no floor → 60" and a supplied reading.
3. **`CreditKeys.verifyOrder` and `CreditTraits`**: Manual duplicate check via `tstore(id)` in the linked library
   (delegatecall → Party's transient storage; confirm no collision with `ReentrancyGuardTransient`'s slot and that marks
   are cleared on every path); "not deposited" via `cardOfCredit` (confirm a redeemed-then-re-deposited id cannot slip);
   Time = ascending id (depends on `paidAt` being non-decreasing in id over all 122,154; `test/keytable`); 3-byte
   packing; `tableHash`/`TABLE_KECCAK` pinning vs the art contract; branch coverage of `CreditTraits` is 57.1%.
4. **Floor handling**: signature not party-bound (R-4), 10-minute caller choice, `lastFloorAt` advanced by any
   `raiseAsk` or burn (can make an in-flight `execute` revert), 1e30 bound, clamp only for floor-relative prices,
   testnet `timeUnit` vs real-time `FLOOR_MAX_AGE`.
5. **Sale and payouts** (`buy`/`claim`/`claimFor`/`withdraw`, `:540-606`): conservation, refund to reverting buyer,
   50k stipend griefing, `claimFor` to the party or factory itself, forced ETH.
6. **Factory deposit routing** (`PartyFactory.sol:46-67`, `onDeposit`): approval to factory only, `isParty`, the
   opening deposit path in `createParty`, deterministic clone salt (front-running `predictParty`), per-token
   `approve(factory)` path, gas of 80 deposits under the cap; factory branch coverage 50%.
7. **`CreditCards` checkpoints** (`:71-83`): self-transfer, same-block multiple transfers, burn, `SafeCast` of block
   number, `heldAt` future lookup.
8. **`StatementMarket`**: listing revival within expiry, `cancelAll` nonce (`uint64` wrap), `cancel` by third parties
   when `ownerOf` reverts, `safeTransferFrom` callback before seller payment, `uint96` price, self-buy check; branch
   coverage 70%.
9. **Gas cap margins**: every preset and Manual under 16,777,216 with a realistic `make`; redeem of 59 cards in one
   call (6.31M measured in TRIAGE).
10. **Site parity** (`lib/core.mjs:426-525`): `burnPrice`/`passesHere`/`noteCandidate` vs `_burnPrice` (the site keeps
    the candidate list in `p.burnCandidates`, capped at 8, reset on execute; parties stored before it existed derive it
    from current-epoch LISTs at 41+ YES), pruning that keeps candidates, the pending UI.
11. **Site auth and gating**: SIWE nonce MAC/expiry/single use, session HMAC, terms/rules version checks per route
    (`termsOkFor`/`rulesOkFor` let house-party actions pass on launch versions, `:839-840`), CSRF via Origin, launch 404
    gating (`:1000`) and its `DEV` bypass (the public full-launch preview runs with it), `depositGatesOk` pre-read vs
    in-lock re-check (TOCTOU), `lockFree` route regex (`:1715`).
12. **Auction routes** (`:1547-1590`): reserve from a thin 24 h window (a cold start with one reading sets the
    reserve), balance check not escrow, `now()` vs `endsAt` boundaries, self-outbid refusal, bid list truncation at
    1000, `openingUnlocked` flip on settle.
13. **SSRF/DoS**: ENS forward lookups from user-supplied names (CCIP-read off; confirm no other off-chain resolution),
    RPC timeouts, OpenSea fetch timeouts, per-instance in-memory rate limits (`rateOk`, `:1674`, keyed on the first
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
- Status of every OPEN item in §6 (confirm, refute, or re-grade), and whether each FIXED item's fix holds.
- A list of areas reviewed with no findings, and what was not reviewed.
- Any disagreement between SPEC.md, this packet, and the code.
