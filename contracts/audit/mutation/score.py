#!/usr/bin/env python3
"""Merge sharded slither-mutate -v logs into one score per file.

Usage: score.py <out.tsv> <shard.log> [<shard.log> ...]   (shard log names contain "party" or "keys")
Each mutant is keyed by (file, mutator, line, old, new) so state-variable mutants that every shard repeats count
once (a mutant counts as caught if any shard caught it). Writes one TSV row per distinct mutant and prints the
per-file / per-mutator summary.
"""
import re
import sys
from collections import defaultdict

ANSI = re.compile(r"\x1b\[[0-9;]*m")
LINE = re.compile(r"\[(\w+)\] Line (\d+): '(.*)' ==> '(.*)' --> (CAUGHT|UNCAUGHT|COMPILATION FAILURE)\s*$")


def main() -> None:
    out, logs = sys.argv[1], sys.argv[2:]
    result: dict[tuple, str] = {}
    for path in logs:
        f = "Party.sol" if "party" in path else "CreditKeys.sol"
        for raw in open(path, encoding="utf8", errors="replace"):
            m = LINE.search(ANSI.sub("", raw))
            if not m:
                continue
            mut, line, old, new, verdict = m.groups()
            key = (f, mut, int(line), old, new)
            prev = result.get(key)
            if prev == "CAUGHT" or (prev == "UNCAUGHT" and verdict == "COMPILATION FAILURE"):
                continue
            result[key] = verdict
    with open(out, "w", encoding="utf8") as o:
        o.write("file\tmutator\tline\tverdict\told\tnew\n")
        for (f, mut, line, old, new), v in sorted(result.items()):
            o.write(f"{f}\t{mut}\t{line}\t{v}\t{old}\t{new}\n")
    for f in ("Party.sol", "CreditKeys.sol"):
        per = defaultdict(lambda: [0, 0, 0])
        for (ff, mut, *_), v in result.items():
            if ff != f:
                continue
            per[mut][{"CAUGHT": 0, "UNCAUGHT": 1, "COMPILATION FAILURE": 2}[v]] += 1
        c = sum(x[0] for x in per.values())
        u = sum(x[1] for x in per.values())
        n = sum(x[2] for x in per.values())
        if c + u == 0:
            continue
        print(f"{f}: {c} caught / {c + u} compiled mutants = {100 * c / (c + u):.1f}% ({u} survived, {n} did not compile)")
        for mut, (a, b, d) in sorted(per.items()):
            print(f"  {mut:5} caught {a:4}  survived {b:4}  no-compile {d:4}")


if __name__ == "__main__":
    main()
