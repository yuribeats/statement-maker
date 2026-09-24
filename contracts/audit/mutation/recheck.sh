#!/usr/bin/env bash
# Re-tests the survivors of a campaign against the current tests. Usage: recheck.sh <shard-dir> <party|keys> <patches_files.txt...>
# Each survivor diff is applied to <shard>/m, tested with run-one.sh against <shard>/p, then reverted.
# Prints one line per survivor: KILLED|SURVIVED <first changed line of the diff>.
set -uo pipefail
D=$1; K=$2; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
cat "$@" | awk -v dir="$TMP" '/^--- /{n++} {print > (dir "/p" sprintf("%05d", n) ".diff")}'
for f in "$TMP"/p*.diff; do
  [ -s "$f" ] || continue
  grep -q '^--- ' "$f" || continue
  what=$(grep -m1 '^+[^+]' "$f" | cut -c2- | sed 's/^ *//')
  if ! (cd "$D/m" && patch -s -p1 < "$f" >/dev/null 2>&1); then echo "NOAPPLY $what"; (cd "$D/m" && rsync -a ../p/src/ src/); continue; fi
  if bash "$HERE/run-one.sh" "$D/m" "$D/p" "$K"; then echo "SURVIVED $what"; else echo "KILLED $what"; fi
  (cd "$D/m" && rsync -a ../p/src/ src/)
done
rm -rf "$TMP"
