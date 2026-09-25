# Pre-mainnet checklist

Nothing is deployed to mainnet. Every item below must be done (and checked off in a commit) before `scripts/deploy-mainnet.sh` is run.

## When Jack's Statement contract is published
- [ ] Re-run the full gas measurement: cold, per preset, with the real `make()`/mint (`test/gas/Cap.t.sol`, `test/gas/Breakdown.t.sol --isolate`), replacing `MockStatement`.
- [ ] Re-check the 16,777,216 per-transaction cap margin (today: worst burn 5.09M before refunds with the mock, of which the mock mint is 1.51M; opening with 80 Credits in one transaction is 14.92M).
- [ ] Re-fetch Jack Butcher's official rating and re-verify it: `node scripts/rating/fetch.mjs --fresh && node scripts/rating/verify.mjs` (0 mismatches; note the methodology version). If any rank changed, rebuild the table (`scripts/keytable/build.sh`), update `TABLE_KECCAK`, the site data and the diff fixtures, and re-run everything below. Rarity is frozen at whatever snapshot is deployed (THREAT_MODEL R-23).
- [ ] Re-verify the key table against the live art contract and the rating snapshot: `scripts/keytable/verify.sh` (live eth_call derivation, site data, full table check, fork samples + house ids).
- [ ] Re-run the fork suites against the real Statement contract (adapter if its ABI differs from `IStatement`; SCOPE.md §5.3 assumptions: burns via `Credits.burn`, mints to the caller, accepts contract callers, unrestricted `transferFrom`).
- [ ] Re-run the audit (Pashov auditor and the external review) on the final code.

## Keys, addresses, services
- [ ] Floor signer: a mainnet floor-signing service does not exist yet (only `/api/sepolia/floor`). Build it (signs at request time, readings valid 10 minutes, mainnet domain = the mainnet factory address) and a keeper that calls `raiseAsk` during floor-relative buy waits.
- [ ] Floor signer key: generate, custody, and set `FLOOR_SIGNER` (immutable in the factory; no rotation without a new factory).
- [ ] Fee recipient address (`FEE_RECIPIENT`): confirm it can receive ETH and call `withdraw` on each party / the market.
- [ ] Collection owner (`COLLECTION_OWNER`): CreditCards marketplace-page owner only.
- [ ] Etherscan API key in the environment (`ETHERSCAN_API_KEY`) for `--verify`; verify the Party implementation (linked to CreditKeys) and CreditCards explicitly (the script does both).
- [ ] Key table: `data/keytable/table.bin` keccak equals `TABLE_KECCAK` in `DeployMainnet.s.sol` (the script refuses otherwise). Budget the table deployment: about 133.7M gas in 26 transactions (25 data chunks of 24,576 B, largest 5.36M; forge dry-run estimate / 1.3). Snapshot in the committed table: fetched 2026-09-25T03:38Z.

## Open work
- [ ] House-party contracts (hostless parties, launch lock, HouseAuction, SPEC §4d) are NOT implemented: the Party edit they need is awaiting approval.
- [x] Pashov audit findings H2, M3, L4 fixed (627e9cf, 8e8efa5, f16d5cb); re-audit M-1/M-2 fixed (e23f1e8); site mirrors landed (e031ad4, e2586f3); H1 accepted (THREAT_MODEL R-2).
- [ ] Sepolia redeploy with the current contracts (`scripts/deploy-sepolia.sh`, now with verification); the Sepolia v1 contracts are unverified and run old rules.
- [ ] Site: mirror every contract rule change (factory-only approvals, 10-minute floor readings, floor-relative buy wait >= 1 h, 1-hour windows, no royalty, market listing fields, Manual 1-day fallback, Time == ascending id, `burnOrderHash` instead of `burnOrder()`).
