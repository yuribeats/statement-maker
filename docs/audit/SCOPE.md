# Statement Maker: audit scope

Prepared 2026-09-24 (UTC). Repository: https://github.com/yuribeats/statement-maker

## 1. Commit

| Item | Value |
|---|---|
| Last commit touching `contracts/src/` | `5040009440fe0e9d606577b5725c92ae8003c97d` (2026-09-23 22:24 -0400, "Contracts v0 ...") |
| Repository HEAD when this file was written | `44d09c88b2dd41d16ecae05c936af7b0eec19a0d` |
| `contracts/src/` changed between the two | No (`git diff 5040009 44d09c8 -- contracts/src` is empty) |

Freeze the audit on a tagged commit before the engagement starts. Other work (tests, deploy scripts, site) is landing on the branch concurrently; none of it touches `contracts/src/`.

SHA-256 of in-scope files at the commit above:

```
af4c37e77daac7f32cb0976b23b2e93c692ea990cc764db28e1c609195fc3ff8  contracts/src/Party.sol
ce2ff1dc71441941240cdf58b60f3804466fb280d742c8293d3565ee7ce8b686  contracts/src/PartyFactory.sol
0ad94416b89eb771e5e03e1becf72db0370f26cefecb73daf250cec515645cb6  contracts/src/CreditCards.sol
0dc918c39dba807d828be57a573d1c600daaecc151eddf03bf5f53b6243bbf6c  contracts/src/CreditKeys.sol
57932a231f5118c31e844d739958902e391566d9d1c9a473003dea7e28feaa3b  contracts/src/interfaces/IExternal.sol
```

## 2. In-scope files

`cloc` is not installed. "Code" counts lines that are not blank and not comments (`//`, `///`, `/* */`).

| File | Total lines | Code lines | What it is |
|---|---:|---:|---|
| `contracts/src/Party.sol` | 564 | 456 | One party: deposits, redemption, verified burn, price governance, sale, claims. Deployed as a minimal clone. |
| `contracts/src/PartyFactory.sol` | 59 | 45 | Deploys party clones, owns the shared card collection, verifies EIP-712 floor signatures. No admin. |
| `contracts/src/CreditCards.sol` | 120 | 96 | Shared ERC-721 for all parties. Per-party vote checkpoints. On-chain SVG/JSON metadata. |
| `contracts/src/CreditKeys.sol` | 143 | 121 | Library: arrangement presets, sort keys from on-chain Credits data, rarity table, seeded shuffle. |
| `contracts/src/interfaces/IExternal.sol` | 45 | 34 | Interfaces for Credits, CreditArt, the unpublished Statement contract, ERC-2981. |
| **Total** | **931** | **752** | |

## 3. Out of scope

| Path | Reason |
|---|---|
| `contracts/src/mocks/MockStatement.sol` (45 lines) | Test stand-in for the unpublished Statement contract. Read it to understand the assumed interface (§6), but do not audit it. |
| `contracts/test/**` | Tests, harnesses, and `test/credits/` (a byte-identical copy of Jack Butcher's verified Credits source, used only for local fuzzing). |
| `contracts/script/**`, `contracts/lib/**` | Deploy scripts and vendored libraries. |
| `server.mjs`, `public/`, `scripts/`, `tools/`, `data/` | The website, indexer, and off-chain floor/Merkle tooling. Their outputs (Merkle root, floor signatures) are inputs to the contracts and are covered as trust assumptions in THREAT_MODEL.md. |
| `research/` | Copies of the third-party Credits contracts, for reference. |

## 4. Build settings (`contracts/foundry.toml`)

| Setting | Value |
|---|---|
| solc | `0.8.28` (pragma pinned `0.8.28` in every source file) |
| EVM version | `cancun` (uses transient storage through `ReentrancyGuardTransient`) |
| Optimizer | on, `runs = 200` |
| `via_ir` | `true` |
| Remappings | `@openzeppelin/=lib/openzeppelin-contracts/`, `forge-std/=lib/forge-std/src/` |
| Fuzz | `runs = 1000` |
| Invariant | `runs = 256`, `depth = 100`, `fail_on_revert = false` |
| Local toolchain | forge 1.7.1 (Homebrew) |

Target chain: Ethereum mainnet only. `cancun` is required, so an L2 without EIP-1153 cannot host these contracts as built.

## 5. External dependencies

### 5.1 OpenZeppelin Contracts v5.4.0 (`contracts/lib/openzeppelin-contracts`, `package.json` version 5.4.0)

| Import | Used by | Purpose |
|---|---|---|
| `token/ERC721/ERC721.sol` | CreditCards, MockStatement | Card token. `_update` overridden for checkpoints. |
| `utils/structs/Checkpoints.sol` (`Trace208`) | CreditCards | Per-party, per-account card balance history for snapshot voting. |
| `utils/math/SafeCast.sol` | CreditCards | Block number to `uint48`. |
| `utils/Strings.sol`, `utils/Base64.sol` | CreditCards | On-chain metadata. |
| `proxy/Clones.sol` | PartyFactory | EIP-1167 clone per party. |
| `proxy/utils/Initializable.sol` | Party | Clone initialization. The implementation constructor calls `_disableInitializers()`. |
| `utils/ReentrancyGuardTransient.sol` | Party | Reentrancy lock in transient storage, shared by all guarded functions. |
| `utils/cryptography/MerkleProof.sol` | Party | Eligibility allowlist (`verifyCalldata`, double-hashed leaf). |
| `utils/cryptography/EIP712.sol`, `ECDSA.sol` | PartyFactory | Floor attestation signatures (`tryRecover`, domain "Statement Maker" / "1"). |

forge-std 1.16.2 is used by tests only.

### 5.2 Credits (live, third party, not in scope but critical)

Verified on mainnet on 2026-09-24 with `cast` against `ethereum-rpc.publicnode.com`:

| Property | Value |
|---|---|
| Address | `0x97630aa70ab14ed9883b41dafccbc11349723043` (Credits / CREDIT, ERC-721, OZ `ERC721` + `Ownable`) |
| Source | Verified on Sourcify. Copy in `research/Credits.sol`, byte-identical to `contracts/test/credits/Credits.sol`. |
| `isSealed()` | `true` |
| `sealedAt()` | `1790181707` (2026-09-23 12:41:47 EDT) |
| `supply()` | `122154` (fixed: `distribute` reverts once sealed) |
| `owner()` | `0xc8f8e2F59Dd95fF67c3d39109ecA2e2A017D4c8a`. After sealing, `seal`/`distribute` both revert, so the owner cannot mint or change token data. |
| `art()` | `0xFbE816B82547B483C7DFfC5b14C75eC84f8c1985` (CreditArt; `describe(bytes21,uint64)` is `pure`) |
| ERC-2981 | `supportsInterface(0x2a55205a)` returns `false` |

Burn semantics (`research/Credits.sol` lines 88-102):
- `burn(address owner_, uint256[] ids) returns (bytes21[] seeds)`
- Reverts unless `isSealed`, unless `ids` is non-empty, and unless `msg.sender == owner_` or `isApprovedForAll(owner_, msg.sender)`.
- Every id must be owned by `owner_`. Duplicates revert (O(n²) check). Seeds come back in call order and stay readable in `seedOf` after the burn.
- A burned id makes `ownerOf` revert (OZ `ERC721NonexistentToken`, selector `0x7e273289`; confirmed against mainnet Credits 0x9763…3043 on 2026-09-24). `Party.assemble` requires exactly this revert for every one of the 80.

Functions Party uses: `transferFrom` (never `safeTransferFrom`), `ownerOf`, `setApprovalForAll`, `seedOf`, `timestampOf`, `art`. CreditKeys uses `seedOf`, `timestampOf`, and `CreditArt.describe`.

### 5.3 Statement contract (unpublished; `MockStatement` stands in)

Jack Butcher's Statement contract had not been published at this commit (expected around 2026-10-01). Everything below is an assumption the auditors must check against the real contract once it ships. An adapter may be needed.

Interface assumed (`contracts/src/interfaces/IExternal.sol` lines 37-41):

```solidity
interface IStatement {
    function make(uint256[] calldata creditIds) external returns (uint256 statementId);
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}
```

Behavior assumed by `Party.assemble` / `Party.buy`:
1. `make(ids)` burns exactly the given 80 Credits, owned by `msg.sender` (the party), by calling `Credits.burn(msg.sender, ids)` as an approved operator. The party grants `setApprovalForAll(statement, true)` for this one call only and revokes it right after.
2. `make` mints the Statement to `msg.sender` and returns its id. A `safeMint` callback is accepted only during `assemble` and only from the factory's `statement` address (`Party.onERC721Received`).
3. The order of `creditIds` is meaningful to the artwork. Unverified: order semantics are unknown.
4. Contract callers are allowed. If the real contract rejects contract callers (`tx.origin` checks, EOA-only, a signature from the owner), no party can assemble. Parties then expire and every Credit is redeemable (SPEC §2).
5. The Statement is a standard ERC-721 that `transferFrom(party, buyer, id)` can move with no restrictions. If transfers are restricted, `buy` reverts and the Statement stays in the party forever, because no other exit exists.
6. Optional `royaltyInfo(tokenId, price)` (ERC-2981) on the Statement contract. It is called by raw `staticcall` with a 150,000-gas stipend (room for a delegating implementation); a revert, a short or dirty answer, or running out of that gas counts as no royalty. The result is capped at 1%.
7. `make` does not re-enter the party. Every state-changing entry point except `propose`/`vote`/`countBlocked`/`raiseAsk`/`transferHost` shares one transient reentrancy lock.

`MockStatement` implements exactly 1, 2, 5, and 6. Its `make` requires `ids.length == 80`.

## 6. Documents for auditors

- `docs/audit/ARCHITECTURE.md`: roles, state machine, money flow, voting, presets, floor oracle, access control.
- `docs/audit/INVARIANTS.md`: numbered invariants with where they are enforced and which tests cover them.
- `docs/audit/THREAT_MODEL.md`: actors, trust assumptions, known risks, prior review history, open questions.
- `SPEC.md` (v0.8): product spec. **The contracts depart from SPEC.md in several places** (listed in ARCHITECTURE.md §9). Where they conflict, the code is the intended behavior under audit unless the team says otherwise.
- `contracts/audit/static/`: Slither and Aderyn output generated on this commit (separate workstream).

## 7. How to build and test

```
cd contracts
forge build
forge test --no-match-path 'test/Lifecycle.t.sol'   # local harness, no RPC needed
ETH_RPC_URL=<mainnet rpc> forge test                 # includes mainnet-fork tests (fork block 26044000)
```
