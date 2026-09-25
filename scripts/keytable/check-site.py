#!/usr/bin/env python3
"""Cross-check (c): every entry of contracts/data/keytable/table.bin against the site's own trait data
(data/traits.json.gz: marks, eights, weight, print family, colors) and payment times (data/credits.json.gz ->
plate mask = paidAt % 15 + 1, whose C/M/Y/K bits must spell the site's colors), and every rarity class against Jack
Butcher's official rating snapshot (data/jack-rating.json.gz): sorting all ids by (class, id) must give exactly the order
(official rank, id), and two ids share a class iff they share an official rank. 0 mismatches required."""
import gzip, json, os, sys
root = os.path.join(os.path.dirname(__file__), '..', '..')
t = open(os.path.join(root, 'contracts/data/keytable/table.bin'), 'rb').read()
tr = {x['id']: x for x in json.load(gzip.open(os.path.join(root, 'data/traits.json.gz')))}
cr = {x['id']: x for x in json.load(gzip.open(os.path.join(root, 'data/credits.json.gz')))['credits']}
PR = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose']; WR = ['sparse', 'lean', 'even', 'extreme']
R = json.load(gzip.open(os.path.join(root, 'data/jack-rating.json.gz')))
rank = R['rank']
bad = []
assert len(t) == 5 * len(tr) == 5 * R['N'], 'table size'
cls = {}
for i in range(len(t) // 5):
    id_ = i + 1; b0, b1, b2 = t[5 * i], t[5 * i + 1], t[5 * i + 2]
    cls[id_] = t[5 * i + 3] << 8 | t[5 * i + 4]
    marks, mask, eights, pr, wr = b0, b1 >> 4, b1 & 15, b2 >> 4, b2 & 15
    s, c = tr[id_], cr[id_]
    colors = ''.join(ch for bit, ch in ((1, 'C'), (2, 'M'), (4, 'Y'), (8, 'K')) if mask & bit)
    ok = (marks == s['marks'] and eights == s['eights'] and WR[wr] == s['weight'] and PR[pr] == s['print']
          and mask == c['paidAt'] % 15 + 1 and colors == s['colors'])
    if not ok: bad.append(id_)
ids = list(range(1, len(t) // 5 + 1))
by_class = sorted(ids, key=lambda i: (cls[i], i))
by_rank = sorted(ids, key=lambda i: (rank[i - 1], i))
rbad = [a for a, b in zip(by_class, by_rank) if a != b]
pairs = {(cls[i], rank[i - 1]) for i in ids}
tie_bad = len(pairs) != len({c for c, _ in pairs}) or len(pairs) != len({r for _, r in pairs})
print(f'{len(t)//5} ids: table vs site traits mismatches: {len(bad)}', bad[:5])
print(f'{len(t)//5} ids: table rarity order vs official rating order mismatches: {len(rbad)}; class <-> rank one-to-one: {not tie_bad} ({len(pairs)} classes)')
sys.exit(1 if bad or rbad or tie_bad else 0)
