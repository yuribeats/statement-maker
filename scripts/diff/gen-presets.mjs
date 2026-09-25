// Builds the preset-order fixture for contracts/test/diff/PresetsDiff.t.sol and the traits fixture for TraitsDiff.t.sol.
// Orders come from the site's own PRESETS code (copied verbatim out of server.mjs by server-copy.mjs).
//   node scripts/diff/gen-presets.mjs [randomSets=250] [poolSize=2000]
import fs from 'node:fs';
import path from 'node:path';
import { S, COPIED, ROOT } from './server-copy.mjs';

const N_RANDOM = Number(process.argv[2] || 250);
const POOL = Number(process.argv[3] || 2000);
const OUT = path.join(ROOT, 'contracts/data/diff');
fs.mkdirSync(OUT, { recursive: true });

// Deterministic PRNG so the fixture is reproducible.
let st = 0x5eed1234;
const rand = () => { st |= 0; st = st + 0x6D2B79F5 | 0; let t = Math.imul(st ^ st >>> 15, 1 | st); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const shuffle = a => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
const sample = (a, n) => shuffle(a).slice(0, n);

const all = [...S.byId.values()];
const byTrait = f => all.filter(f).map(c => c.id);

const sets = []; // { label, ids (deposit order), seed }
const add = (label, ids, seed) => {
  if (ids.length !== 80 || new Set(ids).size !== 80) throw new Error(`${label}: ${ids.length} ids`);
  sets.push({ label, ids, seed: seed ?? 1 + Math.floor(rand() * 999999) });
};

// Random sets from a fixed pool of real Credits (keeps fork RPC reads bounded).
const pool = sample(all.map(c => c.id), POOL);
for (let i = 0; i < N_RANDOM; i++) add(`random-${i}`, sample(pool, 80));

// Adversarial sets.
add('same-colors-CMYK', sample(byTrait(c => c.colors === 'CMYK'), 80));
add('same-colors-K', sample(byTrait(c => c.colors === 'K'), 80));
add('same-marks-60', sample(byTrait(c => c.marks === 60), 80));
add('all-ties-Y|Registered|even|0|31', sample(byTrait(c => c.colors === 'Y' && c.print === 'Registered' && c.weight === 'even' && c.eights === 0 && c.marks === 31), 80));
{ // same paidAt: largest timestamp groups
  const g = new Map(); for (const c of all) (g.get(c.paidAt) || g.set(c.paidAt, []).get(c.paidAt)).push(c.id);
  const ids = [...g.values()].sort((a, b) => b.length - a.length).flat().slice(0, 80);
  add('same-paidAt-groups', shuffle(ids));
}
add('eights-5-4-3', shuffle([...byTrait(c => c.eights >= 4), ...sample(byTrait(c => c.eights === 3), 80 - byTrait(c => c.eights >= 4).length)]));
add('print-mix', shuffle([...S.PRINT_ORDER.flatMap(p => sample(byTrait(c => c.print === p), 13)), ...sample(byTrait(c => c.print === 'Loose'), 20)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 80)));
add('weight-mix-marks-ties', shuffle(S.WEIGHT_ORDER.flatMap(w => { const m = byTrait(c => c.weight === w); const mk = S.byId.get(m[0]).marks; const same = m.filter(id => S.byId.get(id).marks === mk); return [...sample(same, 10), ...sample(m.filter(id => !same.includes(id)), 10)]; })));
add('colors-mix', shuffle([...S.COLOR_ORDER.flatMap(k => sample(byTrait(c => c.colors === k), 5)), ...sample(all.map(c => c.id), 400)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 80)));
add('id-extremes-desc', [...Array(40)].map((_, i) => 122154 - i).concat([...Array(40)].map((_, i) => 40 - i)));
{ // rarity ties and neighbours: official-rank groups of 2+ Credits next to their adjacent ranks
  const g = new Map(); for (const c of all) (g.get(c.rank) || g.set(c.rank, []).get(c.rank)).push(c.id);
  const rs = [...g.keys()].sort((a, b) => a - b);
  const ids = [];
  for (let i = 0; i < rs.length && ids.length < 80; i++) {
    if (g.get(rs[i]).length < 2) continue;
    for (const r of [rs[i - 1], rs[i], rs[i + 1]]) if (r !== undefined) for (const id of g.get(r).slice(0, 3)) if (!ids.includes(id) && ids.length < 80) ids.push(id);
  }
  add('rarity-ties', shuffle(ids));
}
add('most-misregistered-extreme', shuffle([...sample(byTrait(c => c.print === 'Loose'), 40), ...sample(byTrait(c => c.weight === 'extreme'), 40), ...sample(byTrait(c => c.print === 'Drift'), 10)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 80)));
// Random seed edges (server clamps seeds to 1..999999; contract takes any uint256).
const base = sample(pool, 80);
for (const seed of [1, 999999, 2, 500000]) add(`random-seed-${seed}`, base, seed);

const PRESETS = ['Number', 'Time', 'Rarity', 'Colors', 'Print', 'Weight', 'Eights', 'Ink'];
const fixture = { copied: COPIED, n: sets.length, labels: sets.map(s => s.label), seeds: sets.map(s => s.seed), deposit: sets.flatMap(s => s.ids) };
for (const p of [...PRESETS, 'Random']) {
  fixture[p] = sets.flatMap(s => {
    const out = S.PRESETS[p](s.ids.map(id => S.byId.get(id)), s.seed).map(c => c.id);
    if (out.length !== 80 || new Set(out).size !== 80 || !out.every(id => s.ids.includes(id))) throw new Error(`${p} ${s.label}: not a permutation`);
    return out;
  });
}
// Every id the fork test needs a key for.
const ids = [...new Set(fixture.deposit)].sort((a, b) => a - b);
fixture.pool = ids;
fs.writeFileSync(path.join(OUT, 'presets.json'), JSON.stringify(fixture));

// Traits fixture: every id in the preset pool (>= 2,000), with the site's view of each trait.
const t = ids.map(id => S.byId.get(id));
const traits = {
  n: t.length,
  ids: t.map(c => c.id),
  seedHex: t.map(c => c.seedHex),
  paidAt: t.map(c => c.paidAt),
  colors: t.map(c => c.colors),
  colorRank: t.map(c => S.COLOR_ORDER.indexOf(c.colors)),
  plates: t.map(c => c.plates),
  marks: t.map(c => c.marks),
  eights: t.map(c => c.eights),
  weight: t.map(c => c.weight),
  print: t.map(c => c.print),
  tier: t.map(c => c.tier),
};
// Official rating: the fixture ids in the site's (rank, id) order, with their ranks (TraitsDiff.test_rarityClassParity).
{
  const o = [...t].sort((a, b) => a.rank - b.rank || a.id - b.id);
  traits.rankOrder = o.map(c => c.id);
  traits.rankOfOrder = o.map(c => c.rank);
}
fs.writeFileSync(path.join(OUT, 'traits.json'), JSON.stringify(traits));
console.log(`sets ${sets.length} (${N_RANDOM} random + ${sets.length - N_RANDOM} adversarial), distinct ids ${ids.length}, source ${COPIED.source} ${COPIED.sha256.slice(0, 12)} ranges ${COPIED.ranges.join(' ')}`);

// End-to-end fixture: 80 of the fork WHALE's Credits (contracts/test/Base.t.sol), shuffled deposit order, seed 42
// (Base.params). The fork test deposits them into real Parties and burns with the site's order for every preset.
{
  const WHALE = '0xbdf883bdb53f42620f20629c3d40e75148965363';
  const mine = all.filter(c => c.owner === WHALE).map(c => c.id);
  const dep = sample(mine, 80);
  const e2e = { whale: WHALE, deposit: dep, seed: 42 };
  for (const p of ['Deposit', ...PRESETS, 'Random']) e2e[p] = S.PRESETS[p](dep.map(id => S.byId.get(id)), 42).map(c => c.id);
  fs.writeFileSync(path.join(OUT, 'e2e.json'), JSON.stringify(e2e));
  console.log(`e2e: 80 of ${mine.length} whale Credits`);
}
