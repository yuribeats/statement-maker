// Derivation (b): the reference keys of every Credit, computed ON LIVE MAINNET by eth_call — the original key path
// (test/ref/CreditKeysRef.sol, compiled into RefProbe) runs against the real Credits and the real art contract,
// injected with a state override at an unused address. Nothing comes from local data, except Rarity: Jack Butcher's
// official rating is off-chain, so its keys are computed here, in JS, from data/jack-rating.json.gz (class = index of
// the Credit's rank among the distinct ranks, key = class << 32 | id): an independent derivation of the class file
// (contracts/data/keytable/rarity.bin, written by extract-input.py in Python) that keys-a.bin was built from.
// Writes contracts/data/keytable/work/keys-b.bin (same layout as keys-a.bin: per id, presets 1..8, 32 bytes each)
// and compares it byte for byte with keys-a.bin (derivation (a), forge). Usage: node scripts/keytable/live-keys.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const N = 122154, BATCH = Number(process.env.BATCH || 150), CONC = Number(process.env.CONC || 8);
const CREDITS = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const PROBE = '0x00000000000000000000000000000000000dEf01';
const W = new URL('../../contracts/data/keytable/work/', import.meta.url);
const art = JSON.parse(fs.readFileSync(new URL('../../contracts/out/CreditKeysRef.sol/RefProbe.json', import.meta.url)));
const code = art.deployedBytecode.object;
const abi = parseAbi(['function keys(uint8 p, address c, uint256[] ids) view returns (uint256[])']);
const client = createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`, { timeout: 120_000, retryCount: 5 }) });
const block = await client.getBlockNumber();

const out = Buffer.alloc(N * 8 * 32);
const RARITY = 3;
{
  const R = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../../data/jack-rating.json.gz', import.meta.url))));
  if (R.N !== N || R.rank.length !== N) throw new Error('rating snapshot size');
  const distinct = [...new Set(R.rank)].sort((a, b) => a - b);
  const cls = new Map(distinct.map((r, i) => [r, i]));
  for (let id = 1; id <= N; id++) {
    const k = (BigInt(cls.get(R.rank[id - 1])) << 32n) | BigInt(id);
    out.write(k.toString(16).padStart(64, '0'), ((id - 1) * 8 + (RARITY - 1)) * 32, 'hex');
  }
}
const jobs = [];
for (let from = 1; from <= N; from += BATCH) for (let p = 1; p <= 8; p++) if (p !== RARITY) jobs.push([from, Math.min(from + BATCH - 1, N), p]);
let done = 0;
async function run([from, to, p]) {
  const ids = []; for (let i = from; i <= to; i++) ids.push(BigInt(i));
  const data = encodeFunctionData({ abi, functionName: 'keys', args: [p, CREDITS, ids] });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await client.request({ method: 'eth_call', params: [{ to: PROBE, data, gas: '0x' + (1_500_000_000).toString(16) }, '0x' + block.toString(16), { [PROBE]: { code } }] });
      const ks = decodeFunctionResult({ abi, functionName: 'keys', data: r });
      ks.forEach((k, i) => out.write(k.toString(16).padStart(64, '0'), ((from - 1 + i) * 8 + (p - 1)) * 32, 'hex'));
      break;
    } catch (e) { if (attempt > 6) throw e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
  if (++done % 200 === 0) console.log(`${done}/${jobs.length}`);
}
const q = [...jobs];
await Promise.all(Array.from({ length: CONC }, async () => { while (q.length) await run(q.shift()); }));
fs.writeFileSync(new URL('keys-b.bin', W), out);
const a = fs.readFileSync(new URL('keys-a.bin', W));
let mism = 0, first = null;
for (let id = 1; id <= N; id++) for (let p = 1; p <= 8; p++) {
  const o = ((id - 1) * 8 + (p - 1)) * 32;
  if (a.compare(out, o, o + 32, o, o + 32) !== 0) { mism++; first ??= { id, p }; }
}
console.log(`block ${block}: ${N} ids x 8 presets compared, mismatches (a) vs (b): ${mism}`, first ?? '');
process.exit(mism ? 1 : 0);
