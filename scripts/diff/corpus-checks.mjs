// Whole-corpus checks that need no chain: all 122,154 Credits.
//  - paidAt % 15 + 1 mask letters == traits.json colors (what CreditKeys.colorRank reads vs what the site sorts on)
//  - every trait value is one CreditKeys handles without reverting (print/weight/eights tables)
//  - CreditKeys.sol rarity constants == data/rarity.json == round(-log2(count/N) * 1e9) from the sealed supply
import fs from 'node:fs';
import path from 'node:path';
import { S, ROOT } from './server-copy.mjs';

const sol = fs.readFileSync(path.join(ROOT, 'contracts/src/CreditKeys.sol'), 'utf8');
const all = [...S.byId.values()];
const N = all.length;
const letters = m => [...'CMYK'].filter((_, b) => m >> b & 1).join('');
let bad = 0;
const fail = (what, x) => { if (++bad <= 10) console.log('MISMATCH', what, x); };

for (const c of all) {
  if (letters(c.paidAt % 15 + 1) !== c.colors) fail('mask vs colors', c.id);
  if (!S.PRINT_ORDER.includes(c.print)) fail('print outside PRINT_ORDER', c.id);
  if (!S.WEIGHT_ORDER.includes(c.weight)) fail('weight outside WEIGHT_ORDER', c.id);
  if (!(c.eights >= 0 && c.eights <= 5)) fail('eights outside 0..5 (eightsWeight reverts)', c.id);
  if (!Number.isSafeInteger(c.score)) fail('score not an exact integer in JS', c.id);
}
// Contract constant tables, parsed from CreditKeys.sol
const fnBody = name => sol.slice(sol.indexOf(`function ${name}(`), sol.indexOf('\n    }', sol.indexOf(`function ${name}(`)));
const nums = body => [...body.matchAll(/return (\d{6,});/g)].map(m => Number(m[1]));
const maskOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const tables = {
  colors: [nums(fnBody('colorWeight')), maskOrder.map(letters)],
  print: [nums(fnBody('printWeight')), S.PRINT_ORDER],
  weight: [nums(fnBody('weightWeight')), S.WEIGHT_ORDER],
  eights: [nums(fnBody('eightsWeight')), ['0', '1', '2', '3', '4', '5']],
};
let checked = 0;
for (const [k, [ws, keys]] of Object.entries(tables)) {
  if (ws.length !== keys.length) fail(`${k} table length`, `${ws.length} vs ${keys.length}`);
  keys.forEach((v, i) => {
    const r = S.RARITY[k][v];
    const recomputed = Math.round(-Math.log2(r.count / N) * 1e9);
    const count = all.filter(c => String(c[k]) === v).length;
    if (count !== r.count) fail(`${k}=${v} count`, `${count} vs rarity.json ${r.count}`);
    if (ws[i] !== r.w) fail(`${k}=${v} CreditKeys.sol vs rarity.json`, `${ws[i]} vs ${r.w}`);
    if (recomputed !== r.w) fail(`${k}=${v} rarity.json vs recomputed`, `${r.w} vs ${recomputed}`);
    checked++;
  });
}
console.log(`Credits ${N}; rarity constants checked ${checked}; mismatches ${bad}`);
process.exit(bad ? 1 : 0);
