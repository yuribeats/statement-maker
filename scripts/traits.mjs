// Computes traits for every Credit with the art contract's own describe(), writes data/traits.json.
import fs from 'node:fs';
import { startEvm, ART, artAbi } from './evm.mjs';
const { credits } = JSON.parse(fs.readFileSync(new URL('../data/credits.json', import.meta.url)));
const { client, stop } = await startEvm();
const out = new Array(credits.length);
const CHUNK = 2000;
for (let i = 0; i < credits.length; i += CHUNK) {
  const slice = credits.slice(i, i + CHUNK);
  const reads = await Promise.all(slice.map(c => client.readContract({ address: ART, abi: artAbi, functionName: 'describe', args: [c.seedHex, BigInt(c.paidAt)] })));
  reads.forEach((r, k) => {
    out[i + k] = { id: slice[k].id, colors: r.colors, plates: Number(r.plates), marks: Number(r.marks), capacity: Number(r.capacity), eights: Number(r.eights), tier: r.tier, weight: r.weight, print: r.register.split(' · ')[0], register: r.register };
  });
  process.stdout.write(`\r${Math.min(i + CHUNK, credits.length)}/${credits.length}`);
}
stop();
fs.writeFileSync(new URL('../data/traits.json', import.meta.url), JSON.stringify(out));
console.log('\ndone');
