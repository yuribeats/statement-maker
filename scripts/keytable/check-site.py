#!/usr/bin/env python3
"""Cross-check (c): every entry of contracts/data/keytable/table.bin against the site's own trait data
(data/traits.json.gz: marks, eights, weight, print family, colors) and payment times (data/credits.json.gz ->
plate mask = paidAt % 15 + 1, whose C/M/Y/K bits must spell the site's colors). 0 mismatches required."""
import gzip, json, os, sys
root = os.path.join(os.path.dirname(__file__), '..', '..')
t = open(os.path.join(root, 'contracts/data/keytable/table.bin'), 'rb').read()
tr = {x['id']: x for x in json.load(gzip.open(os.path.join(root, 'data/traits.json.gz')))}
cr = {x['id']: x for x in json.load(gzip.open(os.path.join(root, 'data/credits.json.gz')))['credits']}
PR = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose']; WR = ['sparse', 'lean', 'even', 'extreme']
bad = []
for i in range(len(t) // 3):
    id_ = i + 1; b0, b1, b2 = t[3 * i], t[3 * i + 1], t[3 * i + 2]
    marks, mask, eights, pr, wr = b0, b1 >> 4, b1 & 15, b2 >> 4, b2 & 15
    s, c = tr[id_], cr[id_]
    colors = ''.join(ch for bit, ch in ((1, 'C'), (2, 'M'), (4, 'Y'), (8, 'K')) if mask & bit)
    ok = (marks == s['marks'] and eights == s['eights'] and WR[wr] == s['weight'] and PR[pr] == s['print']
          and mask == c['paidAt'] % 15 + 1 and colors == s['colors'])
    if not ok: bad.append(id_)
print(f'{len(t)//3} ids: table vs site traits mismatches: {len(bad)}', bad[:5])
sys.exit(1 if bad else 0)
