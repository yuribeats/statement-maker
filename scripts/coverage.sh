#!/usr/bin/env bash
# Line/branch coverage of contracts/src. Plain `forge coverage` fails: it compiles without via-IR and the Credits art
# sources (test/credits) need via-IR ("stack too deep"). --ir-minimum compiles via-IR with minimal optimization
# (source maps can be slightly off, per forge's warning). Fork suites need ALCHEMY_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
FOUNDRY_OUT=${TMPDIR:-/tmp}/sm-cov-out FOUNDRY_CACHE_PATH=${TMPDIR:-/tmp}/sm-cov-cache FOUNDRY_INVARIANT_RUNS=${INV_RUNS:-64} \
  forge coverage --ir-minimum --skip 'test/halmos/**' --no-match-path 'test/halmos/*' --no-match-coverage '(test|script)/' \
  --gas-limit 9223372036854775807 --report summary "$@" # the diff suites need an unbounded test gas limit
