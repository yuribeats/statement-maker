#!/usr/bin/env python3
"""Pair survivor diffs (patches_files.txt, in order) with recheck.sh verdicts (same order), dedupe by
(file, source line, mutated text), and print the after-kill score using the baseline totals.
Usage: after.py <baseline-mutants.tsv> <out.tsv> <file-label>:<recheck.txt>:<patches.txt> ..."""
import re, sys, csv
base, out, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
rows = list(csv.DictReader(open(base), delimiter="\t"))
total = {}; caught = {}
for r in rows:
    if r["verdict"] == "COMPILATION FAILURE": continue
    total[r["file"]] = total.get(r["file"], 0) + 1
    caught[r["file"]] = caught.get(r["file"], 0) + (r["verdict"] == "CAUGHT")
res = {}
for p in pairs:
    label, rc, pf = p.split(":")
    verdicts = [l.split(" ", 1) for l in open(rc).read().splitlines() if l.strip()]
    diffs = re.split(r"(?m)^(?=--- )", open(pf).read())
    diffs = [d for d in diffs if d.startswith("--- ")]
    assert len(diffs) == len(verdicts), (pf, len(diffs), len(verdicts))
    for d, (v, _) in zip(diffs, verdicts):
        m = re.search(r"@@ -(\d+)", d); line = int(m.group(1))
        body = d.split("\n")
        start = next(i for i, l in enumerate(body) if l.startswith("@@"))
        off = 0; plus = ""
        for l in body[start + 1:]:
            if l.startswith("-"): break
            off += 1
        plus = next(l[1:].strip() for l in body[start + 1:] if l.startswith("+"))
        key = (label, line + off, plus)
        if res.get(key) != "KILLED": res[key] = v
with open(out, "w") as o:
    o.write("file\tline\tafter\tmutated\n")
    for (f, l, t), v in sorted(res.items()): o.write(f"{f}\t{l}\t{v}\t{t}\n")
for f in total:
    killed = sum(1 for (ff, _, _), v in res.items() if ff == f and v == "KILLED")
    surv = sum(1 for (ff, _, _), v in res.items() if ff == f and v != "KILLED")
    print(f"{f}: before {caught[f]}/{total[f]} = {100*caught[f]/total[f]:.1f}%; newly killed {killed}; "
          f"after {caught[f]+killed}/{total[f]} = {100*(caught[f]+killed)/total[f]:.1f}% ({surv} distinct survivors re-tested still alive)")
