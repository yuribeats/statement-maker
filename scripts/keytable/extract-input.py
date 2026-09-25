#!/usr/bin/env python3
"""Writes contracts/data/keytable/work/input.bin (and the committed paidat.bin): for ids 1..N in order, seed (21 bytes) ++ paidAt (8 bytes, big-endian),
from data/credits.json.gz (the site's chain snapshot). Also checks ids are contiguous and paidAt never decreases with id
(the property that makes Time order == ascending id).
Also writes the committed contracts/data/keytable/rarity.bin: per id, uint16 big-endian rarity class = the index of the
Credit's official rank among the distinct ranks of data/jack-rating.json.gz (Jack Butcher's rating snapshot), 0 = rarest.
Class order == official rank order; Credits that share a rank share a class."""
import gzip, json, os, sys
root = os.path.join(os.path.dirname(__file__), '..', '..')
cs = json.load(gzip.open(os.path.join(root, 'data/credits.json.gz')))['credits']
cs.sort(key=lambda c: c['id'])
assert [c['id'] for c in cs] == list(range(1, len(cs) + 1)), 'ids not contiguous'
dec = sum(1 for a, b in zip(cs, cs[1:]) if b['paidAt'] < a['paidAt'])
ties = sum(1 for a, b in zip(cs, cs[1:]) if b['paidAt'] == a['paidAt'])
out = bytearray()
for c in cs:
    s = bytes.fromhex(c['seedHex'][2:])
    assert len(s) == 21
    out += s + int(c['paidAt']).to_bytes(8, 'big')
p = os.path.join(root, 'contracts/data/keytable/work/input.bin')
open(p, 'wb').write(out)
# Committed: payment times as uint32 big-endian per id (checked against the chain by test/keytable/KeyTable.t.sol).
assert all(c['paidAt'] < 2**32 for c in cs)
open(os.path.join(root, 'contracts/data/keytable/paidat.bin'), 'wb').write(b''.join(int(c['paidAt']).to_bytes(4, 'big') for c in cs))
R = json.load(gzip.open(os.path.join(root, 'data/jack-rating.json.gz')))
assert R['N'] == len(cs) == len(R['rank']), 'rating snapshot size'
cls_of = {r: i for i, r in enumerate(sorted(set(R['rank'])))}
assert len(cls_of) < 2**16, 'more than 65,535 distinct ranks'
open(os.path.join(root, 'contracts/data/keytable/rarity.bin'), 'wb').write(b''.join(cls_of[r].to_bytes(2, 'big') for r in R['rank']))
print(f"rarity.bin: {len(cs)} ids, {len(cls_of)} classes, from the rating snapshot fetched {R['fetchedAt']}")
print(f'{len(cs)} credits -> {p} ({len(out)} bytes); paidAt decreases: {dec}, ties: {ties}')
sys.exit(1 if dec else 0)
