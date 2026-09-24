#!/usr/bin/env bash
# Verifies contracts/data/keytable/table.bin (after build.sh). Every step must report 0 mismatches.
#   (b) live-keys.mjs: reference keys of all 122,154 ids x 8 presets computed by eth_call ON LIVE MAINNET (real Credits,
#       real art contract) == derivation (a) from build.sh (forge)
#   (c) check-site.py: table entries == the site's own trait data (data/traits.json.gz, data/credits.json.gz)
#   (d) KeyTable.t.sol full check: the table's keys (what Party verifies) == derivation (a), all ids x presets
#   (e) KeyTable.t.sol fork checks: 2,000 sampled ids + all 320 house-party ids vs the live art contract on a fork
# The site's preset orders are compared in scripts/diff/run-all.sh (PresetsDiff: 500+ sets, site == table == reference).
set -euo pipefail
cd "$(dirname "$0")/../.."
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
(cd contracts && forge build test/ref/CreditKeysRef.sol >/dev/null 2>&1)
node scripts/keytable/live-keys.mjs | tail -1
python3 scripts/keytable/check-site.py
(cd contracts && KEYTABLE_VERIFY=true forge test --match-path test/keytable/KeyTable.t.sol --gas-limit 9223372036854775807 2>&1 | grep -E "PASS|FAIL|Ran ")
