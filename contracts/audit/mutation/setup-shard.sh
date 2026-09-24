#!/usr/bin/env bash
# Creates one mutation shard: <dir>/p (pristine, built once with FOUNDRY_PROFILE=mut) and <dir>/m (the tree
# slither-mutate edits). Usage: setup-shard.sh <contracts-dir-with-mut-profile> <shard-dir>
set -euo pipefail
SRC=$1; D=$2
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$D/p" "$D/m"
rsync -a --delete --exclude 'out*' --exclude 'cache*' --exclude broadcast --exclude script \
  --exclude test/invariant --exclude test/diff --exclude test/halmos --exclude test/market "$SRC/" "$D/p/"
rsync -a --delete "$SRC/src" "$SRC/lib" "$D/m/" # no foundry.toml: slither-mutate's per-mutant compile check then uses plain solc
cd "$D/p"
grep -q '^\[profile.mut\]' foundry.toml || cat "$HERE/foundry-mut.toml" >> foundry.toml
# deploy Credits from its artifact so no test imports the via-IR-only art sources
sed -i '' -e 's#^import {Credits} from "./credits/Credits.sol";##' \
  -e 's#ILocalCredits(address(new Credits(address(this))))#ILocalCredits(vm.deployCode("Credits.sol:Credits", abi.encode(address(this))))#' test/LocalBase.t.sol
FOUNDRY_PROFILE=mut forge build >/dev/null 2>&1
mkdir -p data/mutant
jq -r '.deployedBytecode.linkReferences["src/CreditKeys.sol"].CreditKeys[0].start' out-mutp/Party.sol/Party.json > data/mutant/lib-offset
echo "shard $D ready, lib offset $(cat data/mutant/lib-offset)"
