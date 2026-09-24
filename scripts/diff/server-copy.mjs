// Loads the site's own logic out of server.mjs, verbatim, without starting the server.
// A missing or duplicated anchor fails loudly instead of silently diffing stale code.
//
// Copied ranges are located by anchor text (server.mjs is edited concurrently, so fixed line numbers drift).
// Each range runs from the line starting with `first` to the next line (inclusive) starting with `last`.
// The resolved line numbers and the server.mjs sha256 are exported as COPIED for the report.
//   SLOTS, VOTE_WINDOW, EXEC_WINDOW, DEADLOCK_FAILS/DEADLOCK_DAYS/OVERRIDE
//   credits + traits → byId, TRAITS, RARITY → score + rank
//   COLOR_ORDER … PRESETS (arrangement presets)
//   tally, kindOf, deadlocked, belowFloor, priceEth, cleanTarget
// Stubs (the only non-verbatim pieces): floorFor(p) returns { eth: p.__floorEth } and now() returns the harness clock.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { keccak256, encodePacked } from 'viem';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// Source of the site logic. server.mjs held it through commit 2a02b46; the working tree moved it to lib/core.mjs.
//   DIFF_SRC=lib/core.mjs (default when present) | DIFF_SRC=server.mjs | DIFF_SRC=git:<rev>:<path> (e.g. git:HEAD:server.mjs)
import { execFileSync } from 'node:child_process';
export const SRC_NAME = process.env.DIFF_SRC || (fs.existsSync(path.join(ROOT, 'lib/core.mjs')) ? 'lib/core.mjs' : 'server.mjs');
const SRC = (SRC_NAME.startsWith('git:')
  ? execFileSync('git', ['-C', ROOT, 'show', SRC_NAME.slice(4)], { encoding: 'utf8', maxBuffer: 1 << 26 })
  : fs.readFileSync(path.join(ROOT, SRC_NAME), 'utf8')).split('\n');

export const COPIED = { source: SRC_NAME, sha256: crypto.createHash('sha256').update(SRC.join('\n')).digest('hex'), ranges: [] };
function lines(first, last) {
  const a = SRC.findIndex(l => l.startsWith(first));
  if (a < 0) throw new Error(`${SRC_NAME}: anchor not found: ${first}`);
  if (SRC.findIndex((l, i) => i > a && l.startsWith(first)) >= 0) throw new Error(`${SRC_NAME}: anchor not unique: ${first}`);
  const b = SRC.findIndex((l, i) => i >= a && l.startsWith(last));
  if (b < 0) throw new Error(`${SRC_NAME}: end not found after ${first}: ${last}`);
  COPIED.ranges.push(`${a + 1}-${b + 1}`);
  return SRC.slice(a, b + 1).join('\n');
}

export const RANGES = [
  ['const SLOTS = 80;', 'const SLOTS = 80;'],
  ['const VOTE_WINDOW', 'const VOTE_WINDOW'],
  ['const EXEC_WINDOW', 'const EXEC_WINDOW'],
  ['const DEADLOCK_FAILS', 'const DEADLOCK_FAILS'],
  ['const { block, credits }', 'credits.forEach('],
  ['const TRAITS', 'const TRAITS'],
  ['const RARITY', '[...byId.values()].sort('],
  ['const COLOR_ORDER', '};'],
  ['function tally(p, prop)', '}'],
  ['const kindOf', 'const kindOf'],
  ['function deadlocked(p, type)', '}'],
  ['const belowFloor', 'const belowFloor'],
  ['function priceEth(t, p)', '}'],
  ['function cleanTarget(t)', '}'],
];

const code = RANGES.map(r => lines(...r)).join('\n') + `
;({ SLOTS, OVERRIDE, VOTE_WINDOW, EXEC_WINDOW, DEADLOCK_FAILS, DEADLOCK_DAYS, byId, credits, TRAITS, RARITY,
    COLOR_ORDER, PRINT_ORDER, WEIGHT_ORDER, PRESETS, tally, kindOf, deadlocked, belowFloor, priceEth, cleanTarget })`;

export const clock = { now: Date.UTC(2026, 8, 23) };
const ctx = vm.createContext({
  fs, path, DATA: path.join(ROOT, 'data'), keccak256, encodePacked, BigInt, Math, Number, String, Map, Object, JSON,
  // lib/core.mjs reads data through readData (plain or .gz); same result for the plain files.
  readData: n => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', n))),
  floorFor: p => ({ eth: p.__floorEth ?? null }),
  now: () => clock.now,
});
export const S = vm.runInContext(code, ctx, { filename: `${SRC_NAME} (copied ranges)` });
