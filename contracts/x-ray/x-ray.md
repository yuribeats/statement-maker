# X-Ray Report

> Statement Maker | 1115 nSLOC (src/, incl. mocks/testnet/interfaces; core 1017) | d548e55 (`main`) | Foundry | 24/09/26

---

## 1. Protocol Overview

**What it does:** Pools 80 sealed Credits (0x9763…3043) into a per-party clone, burns them into one Statement through the unpublished Statement contract in a verified order, and sells that Statement at a card-holder-voted ask, paying 1/80 of the net sale per Credit Card.

- **Users**: Host (opens a party, immutable params), depositors (one Credit Card per Credit), card holders (redeem, propose/vote/execute prices, burn, claim), buyers, Statement owners reselling on StatementMarket.
- **Core flow**: `PartyFactory.createParty/deposit` → 80 cards → `Party.assemble` (order check + applied price + verified burn) → `Party.buy` → `claim`/`claimFor`.
- **Key mechanism**: Snapshot card-weight governance over prices only (41/80 with zero NO; 60 below a signed floor; 54 with NO ignored after deadlock); EIP-712 floor readings from one immutable signer; raise-only floor-relative asks; burn-order presets checked against a sealed per-Credit trait table (CreditTraits, SSTORE2).
- **Token model**: Credits (external ERC-721, burned), CreditCards (ERC-721, per-party `Trace208` checkpoints), Statement (external ERC-721), ETH proceeds (1% fee + dust pull, 80 equal shares). No creator royalty (removed in f06b3c5).
- **Admin model**: No owner/admin/pause/upgrade on PartyFactory, Party, CreditTraits, StatementMarket. `CreditCards.owner()` exists for marketplace page editing only. Trust sits in the floor signer key, the Statement contract and the CreditTraits table, all fixed at factory deployment.

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|--------------|------:|------|
| Party core | Party | 499 | Custody, deposits, burn + applied price, price governance, sale, claims |
| Factory + cards | PartyFactory, CreditCards | 167 | Deterministic clones, deposit routing, floor signature check, vote checkpoints, on-chain metadata |
| Arrangement | CreditKeys (linked library), CreditTraits | 249 | Burn-order verification, trait-key formulas, rarity weights, seeded shuffle; sealed 3-byte-per-Credit trait table |
| Resale | StatementMarket | 102 | Fixed-price listings for any Statement, 1% fee, expiry + `cancelAll` |
| Testnet/helpers | TestnetPartyFactory, KeyProbe | 32 | Short-clock factory (refuses chainid 1), UI key probe |

Interfaces (`IExternal.sol`, 34) and `mocks/MockStatement.sol` (32) are counted in the header total but are not protocol logic.

### Backwards-Compatibility Code

- `CreditKeys.printRank / weightRank / printWeight / weightWeight` (`CreditKeys.sol:126-145,166-182`) — string-label helpers from the removed `describe()`-based key path (6190a7c); no caller in `src/` (only `test/ref`, `test/diff`, `test/halmos`). Not live.
- `KeyProbe.keys(…, ICredits c, …)` (`KeyProbe.sol:17-19`) — `c` ignored, "kept for the old ABI".
- `ICredits.seedOf / timestampOf / art / isSealed` and `ICreditArt` (`IExternal.sol:10-31`) — no call in `src/` since 6190a7c; used by tests and the Sepolia script only.

### How It Fits Together

The core trick: users approve only the factory, the factory pulls Credits only from its own caller into its own clones, and the Statement contract is approved only for the duration of one `make` call whose outcome (Statement received, all 80 `ownerOf` revert `ERC721NonexistentToken`) is checked afterwards.

### Deposit

```
PartyFactory.deposit(party, ids, proofs)
├─ Credits.transferFrom(msg.sender, party, id)      // factory is the only approved operator
└─ Party.onDeposit(msg.sender, ids, proofs)          // factory-only, nonReentrant
   ├─ Merkle eligibility, duplicate, ownerOf == party
   ├─ CreditCards.mint(from)                          // checkpoint +1 for (party, from)
   └─ 80th Credit → fullAt, fullBlock, deadline ≥ now + FILL_GRACE
```

### Burn (arrange + assemble, one call)

```
Party.assemble(order, floor)
├─ gate: Manual & ≤ fullAt + MANUAL_GRACE → host; else card holder, Manual → Time
├─ CreditKeys.verifyOrder(preset, traits, _order, cardOfCredit, order, seed)   // delegatecall
│    Deposit/Random: equality · Number/Time: ids strictly ascending
│    trait presets: CreditTraits.keys() strictly ascending · Manual: transient-mark permutation
├─ _passedUnexecuted(floor)      // newest current-epoch LIST that passed while FULL, applied as executed
│    else pendingPrice (executed while FULL) else defaultPrice; wait ≥ 1 h
├─ effects: assembled, burnOrderHash, ask, askSpec, askLiveAt, buyableAt, ++priceEpoch
├─ Credits.setApprovalForAll(statement, true) → Statement.make(order) → revoke
│    *_assembling window: onERC721Received accepts only the Statement*
└─ verify Statement.ownerOf(sid) == party and all 80 Credits.ownerOf revert 0x7e273289
```

### Price governance → sale

```
Party.propose(price, cancel, hours, buyDelay)  // from fullBlock + 1; snapshot = block - 1; auto YES
Party.vote(id, support)                        // weight = heldAt(snapshot)
Party.execute(id, floor)                       // endsAt ≤ now ≤ endsAt + 7 d, epoch current
├─ need = 41 | 60 (price < signed floor; Fixed w/o floor) | ≥ 54 if created in deadlock
├─ FULL → pendingPrice ; ASSEMBLED → ask, buyableAt = now + buyDelay ; CANCEL → ask = 0
Party.raiseAsk(floor)                          // floor-relative only, strictly higher
Party.buy(maxPrice)                            // ≥ buyableAt
├─ owed[feeRecipient] += 1% + dust ; perCard = rest / 80
└─ Statement.transferFrom(party, buyer) ; refund excess
Party.claim / claimFor → burn card, pay perCard (claimFor: 50k push, else owed)
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Governance** with **Vault/custody** and **fixed-price NFT sale** characteristics

`propose/vote/execute` with snapshot weights, thresholds and a deadlock rule is the dominant mechanism; each party escrows Credits and then one Statement; value leaves only through a fixed-price `buy` whose price is set by votes and a signed off-chain floor.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------|
| Floor signer (key, immutable in factory) | Trusted | Signs `(floorWei, mode, issuedAt)`, valid 10 min in every party with that mode; sets floor-relative asks at burn/execute/raiseAsk and the 41-vs-60 threshold. Instant, no rotation, no multisig in code. |
| Statement contract (immutable in factory) | Trusted | Operator over the party's Credits during `make`; its `transferFrom` is the only sale exit. Unpublished ABI. |
| CreditTraits table (deployer-supplied, immutable) | Trusted | Supplies every trait-preset sort key; content not checked on-chain (factory checks only `code.length > 0`). |
| Host | Bounded (params at creation; Manual order/burn ≤ 1 day after FULL; `transferHost`) | Default price, floor mode, `minAskWei`, preset, seed, eligibility root, default window and buy wait. |
| Card holder | Bounded (per-card weight, snapshot block − 1) | Redeem (OPEN/EXPIRED), propose/vote/execute prices, choose the floor reading when executing/burning, burn auto presets, claim. |
| Fee recipient | Bounded (pull only) | `withdraw` of fee + dust per party and per market sale. |
| CreditCards owner | Bounded (no protocol function reads `owner()`) | Marketplace collection page. |

**Adversary Ranking**:

1. **Card-holder coalition / vote buyer** — cards trade freely on marketplaces, so a coalition can steer price votes, reach deadlock mode (H1 accepted), or veto with a single NO.
2. **Burn caller choosing inputs** — the burner picks the floor reading, which decides which passed LIST (if any) goes live and at what price.
3. **Compromised or offline floor signer** — one key shared by every party feeds asks, thresholds and now burn liveness.
4. **Hostile or unexpected Statement contract behavior** — unknown ABI; `make`, mint callbacks and transfer rules are assumptions.
5. **Griefing contracts / proposal spammers** — revert on ETH, re-enter via callbacks, or inflate the FULL-phase proposal list.

See [entry-points.md](entry-points.md) for the full permissionless entry point map.

### Trust Boundaries

- **Floor signer** — single immutable key, not bound to a party (`PartyFactory.sol:87-94`); one reading sets a burn/execute price or threshold instantly, bounded only by `minAskWei` for floor-relative prices.
- **Statement contract** — approval scoped to one call (`Party.sol:333-337`), outcome verified (`Party.sol:338-344`); no alternate exit if its `transferFrom` restricts transfers after the burn.
- **CreditTraits deployer** — table content pinned only by the deploy script's `TABLE_KECCAK` (`script/DeployMainnet.s.sol:34`); on-chain the factory accepts any contract (`PartyFactory.sol:33`).
- **Factory ↔ Party** — `onDeposit` factory-only and re-checks custody (`Party.sol:215,228`); `isParty` gates the factory route (`PartyFactory.sol:59`).
- **Party ↔ CreditCards** — mint/burn restricted to the card's own party (`CreditCards.sol:49,57`); weights keyed by party.

### Key Attack Surfaces

- **Burn-time scan of passed-but-unexecuted LISTs (Pashov H2)** &nbsp;&#91;[I-12](invariants.md#i-12), [E-4](invariants.md#e-4), [I-19](invariants.md#i-19)&#93; — `_passedUnexecuted` (`Party.sol:355-366`) walks every current-epoch proposal with no total cap; worth measuring gas for a long FULL phase with 1-hour windows (3 open per address) against the 16,777,216 cap plus the real `make`.

- **Burn liveness tied to the floor signer** &nbsp;&#91;[G-27](invariants.md#g-27), [I-18](invariants.md#i-18), [I-19](invariants.md#i-19)&#93; — a passed floor-relative candidate, or a Fixed one short of 60 YES, makes the burn require a reading (`Party.sol:361-363`); worth tracing whether an offline signer plus a 7-day execute window can outlast `deadline` (`FILL_GRACE` 2 days).

- **Floor reading selection** &nbsp;&#91;[X-4](invariants.md#x-4), [I-10](invariants.md#i-10), [E-2](invariants.md#e-2)&#93; — `_floor` (`Party.sol:600-606`) accepts any signed reading ≤ 10 min and ≥ last used; at the burn the choice also decides whether the newest candidate passes or the scan falls through (`Party.sol:361-362`). Worth checking every consumer and cross-party reuse.

- **Sealed trait table as trusted data** &nbsp;&#91;[X-5](invariants.md#x-5), [I-23](invariants.md#i-23), [I-25](invariants.md#i-25)&#93; — `CreditTraits` constructor checks sizes only (`CreditTraits.sol:41-57`); Time == ascending id rests on off-chain verification (`CreditKeys.sol:11-12`). Worth confirming post-deploy `tableHash`/`packedOf` checks and parity with the site's `PRESETS`.

- **Deadlock counter and clock across the burn** &nbsp;&#91;[I-17](invariants.md#i-17), [I-22](invariants.md#i-22), [G-46](invariants.md#g-46)&#93; — `blockedPriceProposals` resets at the burn only when a passed LIST is applied (`Party.sol:308`), and `_deadlocked` prefers a FULL-phase `lastPriceExecutedAt` over `assembledAt` (`Party.sol:492`); worth confirming this matches SPEC §4 intent.

- **Pending price not re-judged at the burn** &nbsp;&#91;[E-2](invariants.md#e-2), [I-26](invariants.md#i-26)&#93; — a Fixed LIST executed while FULL was judged against that moment's floor (`Party.sol:453-468`) and goes live at the burn without a new threshold check (`Party.sol:314-315`).

- **Fixed price with no floor treated as below floor** &nbsp;&#91;[G-45](invariants.md#g-45)&#93; — `_judgePrice` returns `floorWei = max` (`Party.sol:371`); worth confirming the 60 / 54 interplay and that omitting a reading never lowers the bar.

- **Buy wait vs cancel window** &nbsp;&#91;[I-8](invariants.md#i-8), [I-9](invariants.md#i-9)&#93; — after the burn a Fixed LIST can execute with a 0-hour wait (`Party.sol:473`) while CANCEL always runs 24 h (`Party.sol:398`); worth checking whether holders can ever stop a live ask before `buyableAt`.

- **Verified burn and the `make` callback window** &nbsp;&#91;[I-13](invariants.md#i-13), [G-25](invariants.md#g-25), [G-26](invariants.md#g-26), [X-7](invariants.md#x-7)&#93; — state is ASSEMBLED before `make` (`Party.sol:322-335`); unguarded `propose`, `vote`, `raiseAsk`, `countBlocked` are reachable during it.

- **Card checkpoint integrity** &nbsp;&#91;[I-27](invariants.md#i-27), [X-1](invariants.md#x-1)&#93; — `_update` (`CreditCards.sol:71-83`) pushes per (party, account) per block; worth checking self-transfers, burns and same-block multi-transfers against `heldAt`.

- **Payout push/pull paths** &nbsp;&#91;[I-2](invariants.md#i-2), [I-30](invariants.md#i-30), [E-1](invariants.md#e-1)&#93; — `claimFor` 50k push with `owed` fallback (`Party.sol:571-572`), `StatementMarket.buy` 50k seller push (`StatementMarket.sol:121-122`); worth checking receivers that are the party/market itself.

- **StatementMarket listing revival** &nbsp;&#91;[I-32](invariants.md#i-32), [I-33](invariants.md#i-33), [I-31](invariants.md#i-31)&#93; — liveness is recomputed from current ownership (`StatementMarket.sol:100-104`); worth checking approval persistence across round trips.

### Protocol-Type Concerns

**As Governance:**
- Snapshot at `block.number − 1` (`Party.sol:403`) with freely tradable cards blocks flash loans but not vote buying across a block; thresholds are absolute counts of 80, and cards lost to dead wallets raise the effective bar.
- Closed proposal set (price/cancel only, `Party.sol:385-410`); `vote` has no status/epoch check (`Party.sol:416-430`), so votes on superseded proposals are accepted and ignored.

**As Custody / fixed-price sale:**
- Sale split rounding: `perCard = pot / 80`, dust < 80 wei to fee recipient (`Party.sol:526-532`).
- Random preset shuffles the deposit order with a seed fixed at creation (`CreditKeys.sol:207-214`); last depositors can predict their final positions.

### Temporal Risk Profile

**Deployment & Initialization:**
- Mainnet deploy not yet run; Statement address and CreditTraits are immutable in the factory (`PartyFactory.sol:32-41`) before the Statement ABI is public — an adapter or a table fix needs a new factory.
- `Party.initialize` runs atomically inside `createParty` (`PartyFactory.sol:47-51`); implementation locked (`Party.sol:163-165`).

**Market Stress:**
- A thin early Statement market sets the signed floor; the 24 h average is computed off-chain, not enforced on-chain.

### Composability & Dependency Risks

**Dependency Risk Map:**

> **Credits** — via `Party.onDeposit/_redeem/assemble`, `PartyFactory._deposit`
> - Assumes: sealed supply; `ownerOf` reverts `0x7e273289` after burn; `transferFrom` has no hooks
> - Validates: custody after transfer (`Party.sol:228`); burn selector (`Party.sol:342-343`)
> - Mutability: Immutable (sealed)
> - On failure: revert

> **CreditTraits** — via `CreditKeys.verifyOrder` (`CreditKeys.sol:80`)
> - Assumes: bytes equal the committed table built from the art contract's `describe()`
> - Validates: chunk count and sizes at construction; id range at read
> - Mutability: Immutable (no admin)
> - On failure: revert on bad id / unknown eights value (`CreditKeys.sol:199`) → preset cannot burn → party expires

> **Statement** — via `Party.assemble/buy`, `StatementMarket.buy`
> - Assumes: `make` burns 80 in order and mints to caller; unrestricted `transferFrom`
> - Validates: receipt + burn check after `make`
> - Mutability: Unknown (unpublished)
> - On failure: assemble reverts (expiry path) / buy reverts with no alternate exit

> **Floor signer** — via `PartyFactory.isValidFloor`
> - Assumes: honest, live
> - Validates: EIP-712 (chainId + factory in domain), age ≤ 10 min, monotonic per party, 0 < floor ≤ 1e30
> - Mutability: Immutable key
> - On failure: floor-relative prices cannot resolve; burns needing a reading revert

---

## 3. Invariants

> ### Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis — do not look here for the catalog.
>
> - **99 Enforced Guards** (`G-1` … `G-99`) — per-call preconditions with `Check` / `Location` / `Purpose`
> - **34 Single-Contract Invariants** (`I-1` … `I-34`) — Conservation, Bound, StateMachine, Temporal
> - **8 Cross-Contract Invariants** (`X-1` … `X-8`) — caller/callee pairs that cross scope boundaries
> - **5 Economic Invariants** (`E-1` … `E-5`) — higher-order properties deriving from `I-N` + `X-N`
>
> Every inferred block cites a concrete Δ-pair, guard-lift + write-sites, state edge, temporal predicate, or NatSpec quote. The **On-chain=No** blocks (I-12, I-23, I-32, X-4, X-5, E-2, E-4) are the high-signal ones — each is simultaneously an invariant and a potential bug. Attack-surface bullets above cross-link directly into the relevant blocks.

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `README.md`, `contracts/README.md` (Foundry boilerplate) |
| NatSpec | ~10 tagged lines + dense `///` prose | Rules restated in `Party.sol:22-42`; library/table layout in `CreditKeys.sol:6-13`, `CreditTraits.sol:7-15` |
| Spec/Whitepaper | Present | `SPEC.md` v0.8 (§4d auction design only; §4 still lists NOMINATE_ARRANGER etc.); `docs/audit/{ARCHITECTURE,INVARIANTS,THREAT_MODEL,SCOPE,PACKET,PRE_MAINNET}.md`. ARCHITECTURE.md is partly stale (still cites `MAX_PROPOSALS = 256`, a 24 h buy delay, a never-reset deadlock counter) |
| Inline Comments | Thorough | Recent fixes (H2, M3, L4) carry comments naming the finding |

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 46 (44 under `test/`; the scan also matched 2 files in `src/testnet/`) | File scan (always reliable) |
| Test functions | 371 | File scan (always reliable) |
| Line coverage | Unavailable — `forge coverage` fails: stack too deep without via-IR (`test/credits/CreditDrawing.sol:226`), and a Yul "too deep" error with `--ir-minimum` (also when skipping `test/credits`) | Coverage tool (requires compilation) |
| Branch coverage | Unavailable — same failure | Coverage tool (requires compilation) |

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | ~320 across 19 files in `test/unit` + `test/market` | Party, PartyFactory, CreditCards, CreditKeys, StatementMarket |
| Differential | 34 across 5 suites (`test/diff`) | Presets, traits, rules, deadlock vs the site's `server.mjs` |
| Fork | 4 files (`createSelectFork`) | Lifecycle, key table (all 122,154 ids), presets; need `ETH_RPC_URL` |
| Stateless Fuzz | 3 | StatementMarket split, permutation, shuffle |
| Stateful Fuzz (Foundry) | 1 (`invariant_` entry) + 3 finding replays | Party via Handler + HostileActor |
| Stateful Fuzz (Echidna / Medusa) | 0 | none |
| Formal Verification (Halmos) | 35 `check_` | CreditKeys, Party (`test/halmos`, 2 files) |
| Formal Verification (Certora / HEVM) | 0 | none |
| Gas | 2 (`test/gas`) | Burn gas vs per-tx cap |

### Gaps

- No line/branch coverage figure for this commit (compile failure under coverage settings).
- One stateful invariant entry point; no Echidna/Medusa/Certora.
- No test targets the burn-scan length (I-12) at scale, or burn liveness with the signer offline; could not confirm either way from file names alone.
- Fork suites (lifecycle, key table, gas cap) need an RPC to run.

---

## 6. Developer & Git History

> Repo shape: normal_dev — monorepo (site + contracts); 141 commits over 2 days, 19 touching `contracts/src`. Analyzed branch: `main` at `d548e55` (git script run from the monorepo root with `--src-dir contracts/src`).

### Contributors

| Author | Commits | Source Lines (+/-) | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| Yuri Rybak | 141 | +1743 / -274 | 100% |

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 1 | Single-dev |
| Merge commits | 0 of 141 (0%) | No merge-based review |
| Repo age | 2026-09-23 → 2026-09-24 | 2 days |
| Recent source activity (30d) | 19 commits to `contracts/src` (all of them) | Late burst; 5 since the previous x-ray (f06b3c5..627e9cf) |
| Test co-change rate | 68.4% | Share of source commits that also touched test files (co-modification, not coverage) |

### File Hotspots

| File | Modifications | Note |
|------|-------------:|------|
| contracts/src/Party.sol | 16 | Highest churn; H2/M3/L4 fixes all landed here on 2026-09-24 |
| contracts/src/PartyFactory.sol | 6 | Deposit routing, traits wiring |
| contracts/src/StatementMarket.sol | 5 | Royalty removed, expiry/cancel changes |
| contracts/src/CreditKeys.sol | 4 | Rewritten to table keys in 6190a7c |
| contracts/src/CreditCards.sol | 3 | Ownable added |
| contracts/src/CreditTraits.sol | 1 | New in 6190a7c |

### Security-Relevant Commits

**Score** = weighted sum of fix-like signals (message keywords, guard/access/accounting diff patterns, change shape). **10+ warrants a manual diff.**

| SHA | Date | Subject | Score | Key Signal |
|-----|------|---------|------:|------------|
| 90d3530 | 2026-09-23 | StatementMarket: fixed-price listings, 1% fee | 21 | fund flows + access control |
| 5e49bf4 | 2026-09-24 | Approvals go to the factory only | 16 | loosens access control (+1/-2) |
| f06b3c5 | 2026-09-24 | Remove the creator royalty | 15 | removes runtime guards (+1/-3), net removal |
| 5040009 | 2026-09-23 | Contracts v0 | 15 | >500 source lines |
| 884add5 | 2026-09-23 | Audit fix batch (proposal caps, countBlocked, deadlock clock, floor rules) | 14 | no test change in commit |
| 627e9cf | 2026-09-24 | Pashov H2: burn applies passed-unexecuted LIST; ≥ 1 h wait | 11 | oracle/pricing, state machine |
| 6190a7c | 2026-09-24 | Sequencing off-chain: sealed CreditTraits, Time = ascending id, burnOrderHash | 11 | 7 source files, guards +10/-5 |
| 7a5987a | 2026-09-23 | Sepolia factory, CreditKeys linked library | 11 | no test change in commit |
| 8e8efa5 | 2026-09-24 | Pashov M3: floor-relative ≤ 0 clamps to minAskWei | 10 | rewrites guards (+4/-4) |
| 47acfeb | 2026-09-24 | Manual burn grace, then any holder in Time order | 10 | access to burn |

### Dangerous Area Evolution

| Security Area | Commits | Key Files |
|--------------|--------:|-----------|
| fund_flows | 19 | Party.sol, PartyFactory.sol, StatementMarket.sol |
| signatures | 19 | PartyFactory.sol, Party.sol, CreditKeys.sol |
| oracle_price | 18 | Party.sol, StatementMarket.sol |
| state_machines | 16 | Party.sol |

### Forked Dependencies

| Library | Path | Upstream | Status | Notes |
|---------|------|----------|--------|-------|
| openzeppelin-contracts | lib/openzeppelin-contracts | OpenZeppelin | Internalized (not a submodule) | Mixed pragmas are upstream's own; byte-identity to a tagged release not confirmed |

### Security Observations

- **Single developer, no merge review** — 100% of source by one author over 2 days.
- **Five post-audit commits to Party in one day** — H2 (+68 lines), M3, L4, royalty removal, table keys; all include test changes.
- **Party.sol at 23,886 / 24,576 bytes** — 690 bytes of EIP-170 headroom (`forge build --sizes`).
- **Audit docs lag code** — ARCHITECTURE.md still states rules replaced by 884add5/89f4ff3.
- **Statement contract unpublished** — every burn/sale assumption about it is unverified.
- **Coverage tooling broken at this commit** — earlier report measured coverage with `--ir-minimum`; it no longer compiles.

### Cross-Reference Synthesis

- **Party.sol is top in churn and holds 9 of 12 attack surfaces** → `assemble`/`_passedUnexecuted`, `_floor`, `countBlocked`/`_deadlocked` are the highest-leverage review.
- **627e9cf (H2) added the only unbounded loop over proposals** → I-12 and E-4 are On-chain=No and newest code.
- **6190a7c moved trait truth off-chain** → X-5 / I-23 depend on the deploy script and `scripts/keytable`, not on-chain checks.

---

## X-Ray Verdict

**ADEQUATE** — Unit, differential, fuzz, one stateful invariant suite and Halmos proofs exist and a spec plus audit docs are present, but there is no timelock/multisig anywhere and the floor signer is a single immutable key.

**Structural facts:**
1. 1115 nSLOC in `src/` (1017 excluding mocks/testnet/interfaces); one 499-nSLOC core contract at 23,886 bytes.
2. No owner/upgrade path in PartyFactory, Party, CreditTraits or StatementMarket; parties are EIP-1167 clones.
3. 371 test functions across 44 test files; 35 Halmos checks; 1 Foundry invariant entry point; coverage currently not measurable.
4. Single contributor; 19 source commits in 2 days, 5 after the previous x-ray.
