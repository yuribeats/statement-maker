// Whole-corpus checks that need no chain: all 122,154 Credits.
//  - paidAt % 15 + 1 mask letters == traits.json colors (what CreditKeys.colorRank reads vs what the site sorts on)
//  - every trait value is one CreditKeys handles without reverting (print/weight/eights tables)
//  - Rarity: the site's official ranks (lib/core.mjs, from data/jack-rating.json.gz) form a valid competition ranking,
//    and the site's Rarity order over ALL 122,154 Credits == the order of the contract's committed rarity classes
//    (contracts/data/keytable/rarity.bin, (class, id)), with equal ranks <=> equal classes
import fs from 'node:fs';
import path from 'node:path';
import { S, ROOT } from './server-copy.mjs';

const rarityBin = fs.readFileSync(path.join(ROOT, 'contracts/data/keytable/rarity.bin'));
const all = [...S.byId.values()];
const N = all.length;
const letters = m => [...'CMYK'].filter((_, b) => m >> b & 1).join('');
let bad = 0;
const fail = (what, x) => { if (++bad <= 10) console.log('MISMATCH', what, x); };

for (const c of all) {
  if (letters(c.paidAt % 15 + 1) !== c.colors) fail('mask vs colors', c.id);
  if (!S.PRINT_ORDER.includes(c.print)) fail('print outside PRINT_ORDER', c.id);
  if (!S.WEIGHT_ORDER.includes(c.weight)) fail('weight outside WEIGHT_ORDER', c.id);
  if (!(c.eights >= 0 && c.eights <= 15)) fail('eights outside the table field (4 bits)', c.id);
  if (!(Number.isInteger(c.rank) && c.rank >= 1 && c.rank <= N)) fail('rank', c.id);
  if (!(c.rating >= 80 && c.rating <= 800)) fail('rating outside 80..800', c.id);
}
// Site Rarity order (PRESETS.Rarity over every Credit) vs the contract's class order
const site = S.PRESETS.Rarity(all).map(c => c.id);
const cls = id => rarityBin.readUInt16BE((id - 1) * 2);
const table = all.map(c => c.id).sort((a, b) => cls(a) - cls(b) || a - b);
let checked = 0;
if (rarityBin.length !== N * 2) fail('rarity.bin size', rarityBin.length);
for (let i = 0; i < N; i++) {
  if (site[i] !== table[i]) fail('Rarity order: site vs table classes, position', i);
  if (i) {
    const a = S.byId.get(site[i - 1]), b = S.byId.get(site[i]);
    const want = i && a.rank === b.rank ? a.rank : i + 1;
    if (b.rank !== want) fail('competition rank', b.id);
    if ((a.rank === b.rank) !== (cls(a.id) === cls(b.id))) fail('rank tie vs class tie', b.id);
  }
  checked++;
}
console.log(`Credits ${N}; Rarity order positions checked (site vs contract classes) ${checked}; mismatches ${bad}`);
process.exit(bad ? 1 : 0);
