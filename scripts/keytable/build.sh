#!/usr/bin/env bash
# Builds the sealed CreditTraits table (contracts/data/keytable/table.bin) and the reference keys of derivation (a).
#   1. extract-input.py: seeds + payment times from data/credits.json.gz (checks paidAt never decreases with id)
#   2. BuildKeyTable.t.sol in 13 shards (forge, mainnet fork for the art contract's code): packed traits from the art
#      contract's describe() and reference keys from the original on-chain key path (test/ref/CreditKeysRef.sol)
#   3. concatenates the shards; writes table.sha256 and table.keccak
# Then run scripts/keytable/verify.sh (derivation (b) on live mainnet + all cross-checks). Needs ALCHEMY_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../.."
export ETH_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY"
python3 scripts/keytable/extract-input.py
N=122154; STEP=10000
W=contracts/data/keytable/work
rm -f $W/table-*.bin $W/keys-a-*.bin
S=(--skip 'test/unit/**' --skip 'test/halmos/**' --skip 'test/invariant/**' --skip 'test/diff/**' --skip 'test/gas/**' \
   --skip 'test/market/**' --skip test/Base.t.sol --skip test/LocalBase.t.sol --skip test/Lifecycle.t.sol --skip test/LocalSmoke.t.sol --skip 'script/**')
(cd contracts && forge build "${S[@]}" >/dev/null 2>&1)
pids=()
for ((from = 1; from <= N; from += STEP)); do
  to=$((from + STEP - 1)); ((to > N)) && to=$N
  (cd contracts && KEYTABLE_BUILD=true FROM=$from TO=$to forge test "${S[@]}" --match-path test/keytable/BuildKeyTable.t.sol \
     --gas-limit 9223372036854775807 >/dev/null) & pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
python3 - <<'PY'
import glob, hashlib, os
from Crypto.Hash import keccak
W = 'contracts/data/keytable/work'
parts = sorted(glob.glob(f'{W}/table-*.bin'), key=lambda p: int(p.rsplit('-', 1)[1][:-4]))
t = b''.join(open(p, 'rb').read() for p in parts)
assert len(t) == 122154 * 3, len(t)
open('contracts/data/keytable/table.bin', 'wb').write(t)
k = b''.join(open(p, 'rb').read() for p in sorted(glob.glob(f'{W}/keys-a-*.bin'), key=lambda p: int(p.rsplit('-', 1)[1][:-4])))
assert len(k) == 122154 * 8 * 32
open(f'{W}/keys-a.bin', 'wb').write(k)
open('contracts/data/keytable/table.sha256', 'w').write(hashlib.sha256(t).hexdigest() + '\n')
h = keccak.new(digest_bits=256); h.update(t)
open('contracts/data/keytable/table.keccak', 'w').write('0x' + h.hexdigest() + '\n')
print('table.bin', len(t), 'bytes; sha256', hashlib.sha256(t).hexdigest())
PY
