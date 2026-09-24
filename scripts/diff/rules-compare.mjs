// Runs contracts/test/diff/RulesDiff.t.sol and compares each case with the site's verdict (rules-site.json).
//   node scripts/diff/gen-rules.mjs 3000 && node scripts/diff/rules-compare.mjs [forge-log]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeErrorResult, parseAbi } from 'viem';
import { ROOT } from './server-copy.mjs';

const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/data/diff/rules-site.json')));
let log;
if (process.argv[2]) log = fs.readFileSync(process.argv[2], 'utf8');
else {
  log = execFileSync('forge', ['test', '--skip', 'test/unit/**', '--skip', 'test/halmos/**', '--skip', 'test/invariant/**',
    '--match-path', 'test/diff/RulesDiff.t.sol', '--gas-limit', '9223372036854775807', '-vv'],
    { cwd: path.join(ROOT, 'contracts'), encoding: 'utf8', maxBuffer: 1 << 28 });
}
const abi = parseAbi(['error Bad(string why)']);
const reason = hex => { if (hex === '0x') return ''; try { return decodeErrorResult({ abi, data: hex }).args[0]; } catch { return hex.slice(0, 10); } };
const res = new Map();
for (const m of log.matchAll(/RULE\|(\d+)\|(\d)\|(\d)\|(\d+)\|(\d+)\|(0x[0-9a-f]*)/g)) {
  res.set(Number(m[1]), { pOk: m[2] === '1', eOk: m[3] === '1', need: Number(m[4]), ask: BigInt(m[5]), why: reason(m[6]) });
}
if (res.size !== site.length) throw new Error(`forge produced ${res.size} results for ${site.length} cases`);

const MODE = ['Fixed', 'FloorPct', 'FloorDelta'];
const buckets = new Map();
const put = (k, i) => { (buckets.get(k) || buckets.set(k, []).get(k)).push(i); };
let modelBad = 0, priceN = 0, maxAbs = 0n, maxRel = 0, exactN = 0;
const relHist = {};
for (let i = 0; i < site.length; i++) {
  const s = site[i], c = res.get(i);
  // 0. harness self-check: the contract model used for needFor's price input must match the real contract
  if (c.pOk !== s.cPropose) modelBad++;
  if (c.eOk && s.state === 1 && !s.cancel && c.ask !== BigInt(s.cPrice)) modelBad++;
  // 1. propose accepted
  if (c.pOk !== s.sPropose) put(`propose: contract ${c.pOk ? 'accepts' : 'rejects (' + c.why + ')'}, site ${s.sPropose ? 'accepts' : 'rejects (' + s.sWhy + ')'} [${s.cancel ? 'CANCEL' : MODE[s.mode]}]`, i);
  if (!(c.pOk && s.sPropose)) continue;
  // 2. required YES
  if (c.need !== s.sNeed && !(c.why === 'price <= 0' || c.why === 'floor')) put(`need: contract ${c.need}, site ${s.sNeed} [${MODE[s.mode]}${s.deadlock ? ', deadlock' : ''}]`, i);
  // 3. executes
  if (c.eOk !== s.sExec) put(`execute: contract ${c.eOk ? 'passes' : 'reverts "' + c.why + '"'}, site ${s.sExec ? 'passes' : 'fails'} [${s.cancel ? 'CANCEL' : MODE[s.mode]}${s.floorWei === '0' ? ', no floor' : ''}]`, i);
  // 4. resolved price (ASSEMBLED LIST that executed on both sides)
  if (c.eOk && s.sExec && s.state === 1 && !s.cancel && s.sPrice != null) {
    priceN++;
    const siteWei = BigInt(Math.round(s.sPrice * 1e18)); // exact conversion of the site's double
    const d = siteWei > c.ask ? siteWei - c.ask : c.ask - siteWei;
    if (d === 0n) exactN++;
    if (d > maxAbs) maxAbs = d;
    const rel = Number(d) / Number(c.ask);
    if (rel > maxRel) maxRel = rel;
    const b = d === 0n ? '0' : d < 1000n ? '<1e3 wei' : d < 1000000n ? '<1e6 wei' : d < 10n ** 9n ? '<1 gwei' : '>=1 gwei';
    relHist[`${MODE[s.mode]} ${b}`] = (relHist[`${MODE[s.mode]} ${b}`] || 0) + 1;
  }
}
const show = i => { const s = site[i], c = res.get(i); return `#${i} state=${s.state ? 'ASSEMBLED' : 'FULL'} ${s.cancel ? 'CANCEL' : MODE[s.mode] + ' value=' + s.value} floorWei=${s.floorWei} yes=${s.yes} no=${s.no} deadlock=${s.deadlock} | contract need=${c.need} exec=${c.eOk}${c.why ? ' (' + c.why + ')' : ''} | site need=${s.sNeed} below=${s.sBelow} exec=${s.sExec} price=${s.sPrice}`; };
console.log(`cases ${site.length}; contract-model self-check mismatches ${modelBad}`);
console.log(`boundary coverage: yes∈{40,41}: ${site.filter(s => s.yes === 40 || s.yes === 41).length}, {53,54}: ${site.filter(s => s.yes === 53 || s.yes === 54).length}, {59,60}: ${site.filter(s => s.yes === 59 || s.yes === 60).length}, no=1: ${site.filter(s => s.no === 1).length}, deadlock: ${site.filter(s => s.deadlock).length}, cancel: ${site.filter(s => s.cancel).length}, no floor: ${site.filter(s => s.floorWei === '0').length}`);
console.log(`agreeing cases: ${site.length - new Set([...buckets.values()].flat()).size}`);
for (const [k, v] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${v.length}× ${k}`);
  for (const i of v.slice(0, 2)) console.log('   ' + show(i));
}
console.log(`\nprice resolution, ${priceN} executed ASSEMBLED LISTs: exact ${exactN}, max |site−contract| ${maxAbs} wei, max relative ${maxRel.toExponential(2)}`);
console.log(relHist);
