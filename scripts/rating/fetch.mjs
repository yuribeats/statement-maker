// Fetches Jack Butcher's official Credits rating (https://jack.art/credits/rating) from its public JSON API
// (the same-origin endpoints the page itself uses) and writes data/jack-rating.json.gz:
//   { source, api, methodology, fetchedAt, N, pageSize, pages, rank: [rank of id 1..N], score: [score of id 1..N] }
// Polite: 3 requests at a time, retries with backoff on 429/5xx/network errors, pages cached under the OS temp dir so
// a rerun resumes (pass --fresh to refetch everything). Run scripts/rating/verify.mjs afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://jack.art/credits/rating';
const OUT = path.join(ROOT, 'data/jack-rating.json.gz');
const CACHE = path.join(os.tmpdir(), 'jack-rating-pages');
const CONCURRENCY = 3;
if (process.argv.includes('--fresh')) fs.rmSync(CACHE, { recursive: true, force: true });
fs.mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 8) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'statement-maker rating snapshot' } });
      if (r.ok) return url.endsWith('.mjs') ? r.text() : r.json();
      if (a >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${url}: HTTP ${r.status}`);
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 1000 * 2 ** a);
    } catch (e) {
      if (a >= tries || /HTTP 4/.test(e.message)) throw e;
      await sleep(1000 * 2 ** a);
    }
  }
}

const engine = await get(`${BASE}/engine.mjs`);
const methodology = (engine.match(/VERSION='([^']+)'/) || [])[1] || null;
const first = await get(`${BASE}/api/ranking?page=0`);
const N = first.total, pageSize = first.items.length, pages = Math.ceil(N / pageSize);
fs.writeFileSync(path.join(CACHE, '0.json'), JSON.stringify(first));
console.log(`total ${N}, page size ${pageSize}, ${pages} pages (0..${pages - 1}), methodology ${methodology}`);

let next = 1, done = 1;
async function worker() {
  while (next < pages) {
    const p = next++;
    const f = path.join(CACHE, `${p}.json`);
    if (fs.existsSync(f)) { done++; continue; }
    const j = await get(`${BASE}/api/ranking?page=${p}`);
    if (j.page !== p || j.total !== N) throw new Error(`page ${p}: unexpected page/total ${j.page}/${j.total}`);
    fs.writeFileSync(f, JSON.stringify(j));
    if (++done % 250 === 0) console.log(`${done}/${pages}`);
    await sleep(50);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const rank = new Array(N).fill(0), score = new Array(N).fill(null);
let seen = 0;
for (let p = 0; p < pages; p++) {
  const j = JSON.parse(fs.readFileSync(path.join(CACHE, `${p}.json`), 'utf8'));
  for (const it of j.items) {
    if (!(it.id >= 1 && it.id <= N)) throw new Error(`bad id ${it.id} on page ${p}`);
    if (rank[it.id - 1]) throw new Error(`id ${it.id} appears twice (page ${p})`);
    rank[it.id - 1] = it.rank;
    score[it.id - 1] = it.score;
    seen++;
  }
}
if (seen !== N || rank.some((r) => !r)) throw new Error(`incomplete: ${seen} items for ${N} ids`);
const doc = {
  source: `${BASE}`,
  api: `${BASE}/api/ranking?page=0..${pages - 1}`,
  methodology,
  fetchedAt: new Date().toISOString(),
  N, pageSize, pages,
  note: 'rank and score of Credit id i are rank[i-1] and score[i-1]. Rank 1 = rarest; ties share a competition rank. Frozen snapshot of the live page.',
  rank, score,
};
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
console.log(`wrote ${path.relative(ROOT, OUT)}: ${N} ids, ${fs.statSync(OUT).size} bytes`);
