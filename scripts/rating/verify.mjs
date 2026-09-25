// Verifies data/jack-rating.json.gz (from fetch.mjs). Exits non-zero on any mismatch.
//   1. completeness: every id 1..N exactly once, ranks are a valid competition ranking, score == 80 + 720 * (ids
//      strictly below) / (N - 1) (Jack's engine; equals the published 80 + 720 (N - rank) / (N - 1) when untied)
//   2. independent reproduction of all N ranks from the Credits' own traits (data/credits.json.gz seeds,
//      data/traits.json.gz): palette, active bits (marks), occupied cells (plates OR-ed, from sha256(seed)), eights,
//      print; p_t = tail share ("as rare or rarer"), weights 1,1,1,2,1; also reports how far p_t = percent is off
//   3. live sample (default 240 ids, --sample=K) against /api/detail/<id>: rank, score and every fact's value, count,
//      tail equal the snapshot and the local reproduction
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))));
const R = gz('data/jack-rating.json.gz');
const N = R.N;
let bad = 0;
const fail = (m) => { bad++; if (bad <= 20 || process.env.V) console.log('MISMATCH', m); };

// 1. completeness + internal consistency
if (N !== 122154 || R.rank.length !== N || R.score.length !== N) fail(`sizes ${N} ${R.rank.length} ${R.score.length}`);
const order = [...Array(N).keys()].sort((a, b) => R.rank[a] - R.rank[b] || a - b);
for (let i = 0; i < N; i++) {
  const k = order[i];
  const want = i && R.rank[order[i - 1]] === R.rank[k] ? R.rank[order[i - 1]] : i + 1;
  if (R.rank[k] !== want) fail(`competition rank of id ${k + 1}: ${R.rank[k]} vs ${want}`);
}
const ranks = [...R.rank].sort((a, b) => a - b);
const lowerCount = (r) => { let l = 0, h = N; while (l < h) { const m = (l + h) >> 1; if (ranks[m] <= r) l = m + 1; else h = m; } return N - l; };
for (let i = 0; i < N; i++) {
  const s = 80 + (720 * lowerCount(R.rank[i])) / (N - 1);
  if (Math.abs(s - R.score[i]) > 1e-9) fail(`score of id ${i + 1}: ${R.score[i]} vs ${s}`);
}
const distinct = new Set(R.rank).size;
console.log(`1. completeness: ${N} ids, each exactly once; ${distinct} distinct ranks; scores follow rank (${bad} mismatches)`);

// 2. reproduction from the Credits' own traits
const credits = gz('data/credits.json.gz').credits, traits = gz('data/traits.json.gz');
const rows = credits.map((c, i) => {
  const t = traits[i];
  if (t.id !== c.id || c.id !== i + 1) throw new Error('trait/credit order');
  const h = crypto.createHash('sha256').update(Buffer.from(c.seedHex.slice(2), 'hex')).digest();
  // occupied cells = nonzero pixels of the art's raster (CreditDrawing.raster): each enabled plate's 8x8 bits drawn at
  // its misregistration shift (dx, dy from the art library's slips(), data/traits.json.gz), plates OR-ed
  const cells = new Set(), dx = t.dx || [0, 0, 0, 0], dy = t.dy || [0, 0, 0, 0];
  let marks = 0;
  'CMYK'.split('').forEach((L, layer) => {
    if (!t.colors.includes(L)) return;
    for (let bit = 0; bit < 64; bit++) {
      const index = layer * 64 + bit;
      if ((h[index >> 3] >> (7 - (index & 7))) & 1) { marks++; cells.add(((bit >> 3) + dy[layer]) * 16 + (bit & 7) + dx[layer]); }
    }
  });
  if (marks !== t.marks) throw new Error(`marks of ${c.id}`);
  return { id: c.id, Palette: t.colors, 'Active bits': marks, 'Occupied cells': cells.size, Dots: t.eights, Registration: t.print };
});
const TRAITS = [['Palette', 1], ['Active bits', 1], ['Occupied cells', 1], ['Dots', 2], ['Registration', 1]];
const counts = {}, tails = {};
for (const [t] of TRAITS) {
  counts[t] = {};
  for (const r of rows) counts[t][r[t]] = (counts[t][r[t]] || 0) + 1;
  tails[t] = {};
  for (const [v, n] of Object.entries(counts[t])) tails[t][v] = Object.values(counts[t]).reduce((s, k) => s + (k <= n ? k : 0), 0);
}
function rankBy(p) {
  const raw = rows.map((r) => TRAITS.reduce((s, [t, w]) => s - w * Math.log(p(t, r[t])), 0) / 6);
  const sorted = [...raw].sort((a, b) => b - a);
  return raw.map((x) => { let l = 0, h = N; while (l < h) { const m = (l + h) >> 1; if (sorted[m] > x + 1e-12) l = m + 1; else h = m; } return l + 1; });
}
const rTail = rankBy((t, v) => tails[t][v] / N), rPct = rankBy((t, v) => counts[t][v] / N);
let mTail = 0, mPct = 0;
for (let i = 0; i < N; i++) { if (rTail[i] !== R.rank[i]) { mTail++; fail(`reproduced rank (tail) of id ${i + 1}: ${rTail[i]} vs ${R.rank[i]}`); } if (rPct[i] !== R.rank[i]) mPct++; }
console.log(`2. reproduction: p = tail share -> ${mTail} of ${N} ranks differ; p = percent (own value's share) -> ${mPct} differ`);

// 3. live sample vs /api/detail
const K = Number((process.argv.find((a) => a.startsWith('--sample=')) || '=240').split('=')[1]);
const pick = new Set([1, 2, N, 52512, 11469, ...order.slice(0, 20).map((k) => k + 1), ...order.slice(-10).map((k) => k + 1)]);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
while (pick.size < K) pick.add(1 + Math.floor(rnd() * N));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let a = 0; ; a++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); if (a > 6 || (r.status !== 429 && r.status < 500)) throw new Error(`HTTP ${r.status}`); }
    catch (e) { if (a > 6) throw e; }
    await sleep(1000 * 2 ** a);
  }
}
const ids = [...pick];
let checked = 0;
async function worker() {
  while (ids.length) {
    const id = ids.pop();
    const d = await get(`${R.source}/api/detail/${id}`);
    const r = rows[id - 1];
    if (d.rank !== R.rank[id - 1]) fail(`detail rank of ${id}: ${d.rank} vs ${R.rank[id - 1]}`);
    if (Math.abs(d.score - R.score[id - 1]) > 1e-9) fail(`detail score of ${id}: ${d.score} vs ${R.score[id - 1]}`);
    for (const f of d.facts) {
      if (String(f.value) !== String(r[f.name])) fail(`fact ${f.name} of ${id}: ${f.value} vs ${r[f.name]}`);
      if (f.count !== counts[f.name][r[f.name]]) fail(`count ${f.name} of ${id}`);
      if (Math.abs(f.tail - (100 * tails[f.name][r[f.name]]) / N) > 1e-9) fail(`tail ${f.name} of ${id}`);
    }
    checked++;
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`3. live sample: ${checked} ids vs /api/detail (rank, score, every fact's value/count/tail)`);
console.log(bad ? `FAIL: ${bad} mismatches` : `OK: 0 mismatches (snapshot fetched ${R.fetchedAt}, methodology ${R.methodology})`);
process.exit(bad ? 1 : 0);
