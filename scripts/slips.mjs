// Adds exact plate shifts to data/traits.json by calling the art library's own slips() (compiled from the verified source).
import fs from 'node:fs';
import { parseAbi } from 'viem';
import { startEvm } from './evm.mjs';
const SLIPS = '0x5119500000000000000000000000000000005119';
const abi = parseAbi(['function slips(bytes21 seed) pure returns (int8[4] dxs, int8[4] dys)']);
const { credits } = JSON.parse(fs.readFileSync(new URL('../data/credits.json', import.meta.url)));
const traits = JSON.parse(fs.readFileSync(new URL('../data/traits.json', import.meta.url)));
const { client, stop } = await startEvm();
const code = fs.readFileSync(new URL('../data/slips.bytecode', import.meta.url), 'utf8').trim();
await client.request({ method: 'anvil_setCode', params: [SLIPS, code] });
const todo = traits.map((t, i) => [t, credits[i]]).filter(([t]) => t.print !== 'Registered');
for (let i = 0; i < todo.length; i += 2000) {
  const chunk = todo.slice(i, i + 2000);
  const res = await Promise.all(chunk.map(([, c]) => client.readContract({ address: SLIPS, abi, functionName: 'slips', args: [c.seedHex] })));
  res.forEach(([dx, dy], k) => {
    const t = chunk[k][0];
    t.dx = dx.map(Number); t.dy = dy.map(Number);
    t.shifted = 'CMYK'.split('').filter((_, j) => t.dx[j] || t.dy[j]).join('');
    t.shift = Math.max(...t.dx.map(Math.abs), ...t.dy.map(Math.abs));
    t.register = [t.print, ...'CMYK'.split('').flatMap((p, j) => (t.dx[j] || t.dy[j]) ? [`${p} ${t.dx[j] > 0 ? '+' : ''}${t.dx[j]},${t.dy[j] > 0 ? '+' : ''}${t.dy[j]}`] : [])].join(' · ');
  });
  process.stdout.write(`\r${Math.min(i + 2000, todo.length)}/${todo.length}`);
}
stop();
for (const t of traits) if (t.print === 'Registered') { t.shifted = ''; t.shift = 0; }
fs.writeFileSync(new URL('../data/traits.json', import.meta.url), JSON.stringify(traits));
// Sanity: label ↔ movers/step rules from the source.
const bad = todo.filter(([t]) => {
  const n = t.shifted.length;
  return (t.print === 'Nudge' && (n !== 1 || t.shift !== 1)) || (t.print === 'Slip' && (n !== 2 || t.shift !== 1)) || (t.print === 'Skew' && (n !== 3 || t.shift !== 1)) ||
    (t.print === 'Drift' && (n < 2 || n > 3 || t.shift !== 2 || t.shifted.includes('K'))) || (t.print === 'Loose' && (n < 3 || n > 4 || t.shift !== 2));
});
console.log('\nchecked', todo.length, 'label mismatches', bad.length, 'example', todo[0][0].register);
