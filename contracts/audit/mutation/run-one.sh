#!/usr/bin/env bash
# Test command for slither-mutate (one mutant). Usage: run-one.sh <mutation-tree> <pristine-tree> <party|keys>
#   <mutation-tree>: the contracts/ copy slither-mutate edits in place (src/Party.sol or src/CreditKeys.sol mutated)
#   <pristine-tree>: an unmodified contracts/ copy, already built with FOUNDRY_PROFILE=mut, never recompiled
# Compiles only the mutated file with solc (legacy codegen, optimizer 200, cancun: the settings of the mut profile),
# writes its runtime code to <pristine>/data/mutant/, and runs the unit suite there; test/LocalBase.t.sol etches the
# mutant over the Party implementation (MUTANT_PARTY) or the linked CreditKeys library (MUTANT_KEYS).
# Exit 0 = mutant survived. A mutant that slither compiled but this solc run could not is logged to harness-fail.log.
set -uo pipefail
M=$1; P=$2; K=$3
SOLC=${SOLC:-"$HOME/Library/Application Support/svm/0.8.28/solc-0.8.28"}
SENTINEL=0xC0FfEE0000000000000000000000000000c0fFEe
mkdir -p "$P/data/mutant"
if [ "$K" = party ]; then FILE=src/Party.sol; NAME=Party; else FILE=src/CreditKeys.sol; NAME=CreditKeys; fi
HEX=$(cd "$M" && "$SOLC" @openzeppelin/=lib/openzeppelin-contracts/ --optimize --optimize-runs 200 --evm-version cancun \
  --libraries "src/CreditKeys.sol:CreditKeys=$SENTINEL" --bin-runtime "$FILE" 2>/dev/null \
  | awk -v want="$FILE:$NAME" '$0 ~ "^======= " want " =======" {f=1; next} f && /^[0-9a-f]+$/ {print; exit}')
if [ -z "$HEX" ]; then echo "$(date +%s) $K $(shasum "$M/$FILE" | cut -c1-12)" >> "$M/../harness-fail.log"; exit 1; fi
OUT="$P/data/mutant/$K.hex"
printf '0x%s' "$HEX" > "$OUT"
cd "$P"
if [ "$K" = party ]; then VAR=MUTANT_PARTY; else VAR=MUTANT_KEYS; fi
env FOUNDRY_PROFILE=mut "$VAR=data/mutant/$K.hex" MUTANT_LIB_OFFSET="$(cat "$P/data/mutant/lib-offset")" \
  forge test --match-path 'test/unit/*' --no-match-contract 'PresetsForkTest|Findings2Test' --fail-fast >/dev/null 2>&1
