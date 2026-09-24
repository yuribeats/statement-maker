#!/usr/bin/env bash
# Halmos proofs for Party/CreditKeys. Usage (from contracts/): bash test/halmos/run.sh [party|keys|shuffle|slow|all]
#   all   = party + keys + shuffle
#   slow  = the direct 256-bit multiply/divide proofs that TIME OUT on every solver tried (kept to re-try new solvers)
# Builds into a private out/cache dir (other `forge build` runs drop the AST halmos needs) and compiles only src/
# and test/halmos/, so unrelated test edits cannot break the proof build.
# First run downloads the yices/bitwuzla binaries from their GitHub releases (HALMOS_ALLOW_DOWNLOAD=1).
set -uo pipefail
cd "$(dirname "$0")/../.."
H="${HALMOS:-$HOME/.local/bin/halmos}"
D="${HALMOS_BUILD_DIR:-${TMPDIR:-/tmp}/statement-maker-halmos}"
export FOUNDRY_OUT="$D/out" FOUNDRY_CACHE_PATH="$D/cache" FOUNDRY_TEST=test/halmos FOUNDRY_SCRIPT=test/halmos HALMOS_ALLOW_DOWNLOAD=1
C=(--forge-build-out "$FOUNDRY_OUT" --solver-timeout-assertion "${HALMOS_TIMEOUT:-300s}")
G="${1:-all}"
SLOW='split_1e30|split_full|resolve_pct|resolve_monotone_pct|div_def_10000'
on() { [[ $G == all || $G == "$1" ]]; }

# 1-3: sale split (linearised), pass rule, price resolution. The FloorDelta "anyfloor" check FAILS by design:
# it documents the int256 wrap of floors >= 2^255 (see the report / proposed _floor bound).
if on party; then
  "$H" "${C[@]}" --match-contract '^(PartyHalmos|SplitLemmaHalmos)$' --solver bitwuzla --loop 4 \
    --match-test "^check_(?!($SLOW))"
fi

# 4b/5: key order per preset, packing, rank tables (string lengths 0..12,16,32 for the rank lookups)
if on keys; then
  "$H" "${C[@]}" --match-contract '^CreditKeysHalmos$' --loop 16 --match-test '^check_(?!shuffle)' \
    --array-lengths 's={0,1,2,3,4,5,6,7,8,9,10,11,12,16,32}'
fi

# 4a: shuffle is a permutation, n = 3..SHUFFLE_MAX (n! paths; loop bound must cover the n*n counting loop)
if on shuffle; then
  for n in $(seq 3 "${SHUFFLE_MAX:-7}"); do
    "$H" "${C[@]}" --match-contract '^CreditKeysHalmos$' --match-test "shuffle_perm_$n\\b" --loop $((n * n + 4))
  done
fi

# 6: (removed) the verifyOrder permutation proof covered the old O(n^2) scan. The current check (membership via the
#    credit -> card mapping, distinctness via transient marks) uses symbolic mapping keys halmos cannot model
#    (NotConcreteError); it is covered by test/unit/PermutationFuzz.t.sol against an independent definition.

if [[ $G == slow ]]; then
  "$H" "${C[@]}" --match-contract '^(PartyHalmos|SplitLemmaHalmos)$' --solver bitwuzla --loop 4 --match-test "^check_($SLOW)"
fi
