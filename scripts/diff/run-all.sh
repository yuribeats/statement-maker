#!/usr/bin/env bash
# Differential tests: site logic (lib/core.mjs, or DIFF_SRC=git:HEAD:server.mjs) vs contracts. Needs ALCHEMY_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../.."
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
SKIP=(--skip 'test/unit/**' --skip 'test/halmos/**' --skip 'test/invariant/**')
node scripts/diff/corpus-checks.mjs
node scripts/diff/gen-presets.mjs 500 2000
node scripts/diff/gen-rules.mjs 3000
(cd contracts && forge test "${SKIP[@]}" --match-path 'test/diff/{PresetsDiff,PresetsE2EDiff,TraitsDiff,DeadlockDiff}.t.sol' --gas-limit 9223372036854775807 -vv | grep -E 'PASS|FAIL|violations|differing|compared|mismatches')
node scripts/diff/scenarios.mjs
node scripts/diff/rules-compare.mjs
