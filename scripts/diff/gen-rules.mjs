// Pass-rule and price-resolution cases for contracts/test/diff/RulesDiff.t.sol.
// Server verdicts come from the site's own tally/priceEth/belowFloor/cleanTarget (copied verbatim by server-copy.mjs).
// Units: the contract takes wei / basis points; the site takes exact decimal strings (ETH to 1 wei, percent to 1 bps) and
// does its math in BigInt wei. Each case is generated in contract units and handed to the site as the exact decimal
// (weiStr(wei), bps / 100). The floor reading is handed over in wei (what the signer signs); floorWei 0 is a signed
// reading of 0 on both sides (the contract rejects it: "floor").
//   node scripts/diff/gen-rules.mjs [cases=3000]
import fs from 'node:fs';
import path from 'node:path';
import { S, clock, ROOT } from './server-copy.mjs';

const N = Number(process.argv[2] || 3000);
let st = 0xC0FFEE;
const rand = () => { st |= 0; st = st + 0x6D2B79F5 | 0; let t = Math.imul(st ^ st >>> 15, 1 | st); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = a => a[Math.floor(rand() * a.length)];
const E = 10n ** 18n;
const randWei = (loEth, hiEth) => BigInt(Math.floor((loEth + rand() * (hiEth - loEth)) * 1e6)) * 10n ** 12n + BigInt(ri(0, 999999)) * 1000n + BigInt(ri(0, 999));

// Contract model (Party._checkPrice / _resolveWith); the fork-free test checks this model against the real ask().
function checkPrice(mode, v) {
  if (mode === 0) return v > 0n && v <= 10n ** 24n;
  if (mode === 1) return v > -10000n && v <= 1000000n;
  return v >= -(10n ** 24n) && v <= 10n ** 24n;
}
function resolve(mode, v, f) {
  if (mode === 0) return v;
  const r = mode === 1 ? f * (10000n + v) / 10000n : f + v; // BigInt division truncates toward zero, as Solidity
  return r <= 0n ? null : r;
}

const YES = [1, 2, 40, 41, 42, 53, 54, 55, 59, 60, 61, 79, 80];
const cases = [];
for (let i = 0; i < N; i++) {
  const cancel = rand() < 0.08;
  const state = cancel ? 1 : (rand() < 0.5 ? 0 : 1); // 0 FULL, 1 ASSEMBLED
  const deadlock = rand() < 0.3;
  let yes = rand() < 0.7 ? pick(YES) : ri(1, 80);
  let no = rand() < 0.55 ? 0 : (rand() < 0.5 ? 1 : ri(1, 80));
  if (yes + no > 80) no = 80 - yes;
  // floor: mostly 0.05–500 ETH, some huge (float absorbs small deltas), some missing (0 = no signed floor / site floor null)
  const fr = rand();
  const floorWei = fr < 0.04 ? 0n : fr < 0.2 ? randWei(100, 5000) : randWei(0.05, 500);
  const mode = cancel ? 0 : ri(0, 2);
  let value;
  const edge = rand() < 0.5;
  const f = floorWei || randWei(1, 10);
  if (mode === 0) {
    value = edge ? pick([f, f - 1n, f + 1n, f - 1000n, f + 1000n, 1n, 10n ** 24n, 10n ** 24n - 1n, 10n ** 24n + 1n]) : randWei(0.01, 800);
    if (value < 1n) value = 1n;
  } else if (mode === 1) {
    value = edge ? BigInt(pick([0, -1, 1, -9999, -10000, 999999, 1000000, 1000001, -5000, 2500])) : BigInt(ri(-9999, 20000));
  } else {
    value = edge ? pick([0n, -1n, 1n, -1000n, 1000n, -100000n, -(f), -(f) + 1n, -(10n ** 24n), 10n ** 24n, 10n ** 24n + 1n]) : (rand() < 0.5 ? -1n : 1n) * randWei(0, 50);
  }
  if (cancel) value = 0n;

  // Contract model
  const cPropose = cancel ? true : checkPrice(mode, value);
  const cPrice = cancel || floorWei === 0n ? 0n : (resolve(mode, value, floorWei) ?? 0n);

  // Site verdict with the copied server code
  const bpsStr = v => (v < 0n ? '-' : '') + ((v < 0n ? -v : v) / 100n) + '.' + ((v < 0n ? -v : v) % 100n).toString().padStart(2, '0');
  const input = cancel ? {} : mode === 0 ? { mode: 'fixed', value: S.weiStr(value) } : mode === 1 ? { mode: 'floorPct', value: bpsStr(value) } : { mode: 'floorEth', value: S.weiStr(value) };
  const p = { __floorEth: Number(floorWei) / 1e18, __floorWei: floorWei, params: {} };
  // Site propose route: LIST needs cleanTarget (range only, as Party.propose); the stored args are the cleaned target.
  let sPropose = true, sWhy = '', args = {};
  if (!cancel) { args = S.cleanTarget(input); sPropose = !!args; sWhy = args ? '' : 'out of range'; }
  const snapshot = {}, votes = {};
  for (let k = 0; k < 80; k++) snapshot['v' + k] = 1;
  for (let k = 0; k < yes; k++) votes['v' + k] = true;
  for (let k = yes; k < yes + no; k++) votes['v' + k] = false;
  const at = clock.now;
  const prop = { type: cancel ? 'CANCEL_LISTING' : 'LIST', args, at, endsAt: at + 48 * 36e5, override: deadlock, snapshot, votes };
  const saved = clock.now; clock.now = prop.endsAt;
  const t = S.tally(p, prop);
  clock.now = saved;
  const sPrice = cancel || !sPropose ? null : S.priceWei(args, p)?.toString() ?? null;
  cases.push({ state, cancel, mode, value: value.toString(), floorWei: floorWei.toString(), yes, no, deadlock, cPropose, cPrice: cPrice.toString(),
    sPropose, sWhy, sExec: sPropose && t.executable, sNeed: t.need, sBelow: t.below, sPrice });
}
const OUT = path.join(ROOT, 'contracts/data/diff');
const col = k => cases.map(c => c[k]);
const fx = { n: N, state: col('state'), cancel: col('cancel'), mode: col('mode'), value: col('value'), floorWei: col('floorWei'), yes: col('yes'), no: col('no'), deadlock: col('deadlock'), cPrice: col('cPrice') };
fs.writeFileSync(path.join(OUT, 'rules.json'), JSON.stringify(fx));
fs.writeFileSync(path.join(OUT, 'rules-site.json'), JSON.stringify(cases));
console.log(`cases ${N}`);
