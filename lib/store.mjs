// Storage for Statement Maker's off-chain state.
// Postgres (Neon) when DATABASE_URL is set, otherwise JSON files under data/ (local dev).
// Shape: one JSON document "state" (parties, terms, clock) mutated under a row lock, plus small tables for
// floor readings, used sign-in nonces, and Credit ownership changes since the bundled snapshot.
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');

function fileStore() {
  const f = n => path.join(DATA, n);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(f(n))); } catch { return d; } };
  const write = (n, v) => { const t = f(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f(n)); };
  let lock = Promise.resolve();
  return {
    kind: 'file',
    async readState() { return read('state.json', { parties: [] }); },
    // Serialize writers in-process; the local server is a single process.
    async withState(fn) {
      const run = lock.then(async () => { const s = read('state.json', { parties: [] }); const out = await fn(s); write('state.json', s); return out; });
      lock = run.catch(() => {});
      return run;
    },
    async getTerms(a) { return read('terms.json', {})[a] || null; },
    async saveTerms(a, rec) { const t = read('terms.json', {}); t[a] = rec; write('terms.json', t); },
    async addFloor(x) { const h = read('floor.json', []); h.push(x); write('floor.json', h.filter(r => r.at > Date.now() - 25 * 36e5)); },
    async floors() { return read('floor.json', []); },
    async useNonce(n, exp) { const u = read('nonces.json', {}); for (const k in u) if (u[k] < Date.now()) delete u[k]; if (u[n]) return false; u[n] = exp; write('nonces.json', u); return true; },
    async ownerChanges() { return read('owners.json', { block: 0, changes: {} }); },
    async saveOwnerChanges(block, changes) { const o = read('owners.json', { block: 0, changes: {} }); Object.assign(o.changes, changes); o.block = block; write('owners.json', o); },
  };
}

async function pgStore(url) {
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = (await import('ws')).default;
  const pool = new Pool({ connectionString: url });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS floors (at bigint PRIMARY KEY, credit double precision NOT NULL, statement double precision);
    CREATE TABLE IF NOT EXISTS nonces (n text PRIMARY KEY, exp bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS owners (id integer PRIMARY KEY, owner text NOT NULL);
    CREATE TABLE IF NOT EXISTS terms (address text PRIMARY KEY, rec jsonb NOT NULL);
    INSERT INTO kv (k, v) VALUES ('state', '{"parties":[]}'::jsonb), ('owners_block', '0'::jsonb) ON CONFLICT (k) DO NOTHING;
  `);
  return {
    kind: 'postgres',
    async readState() { return (await pool.query(`SELECT v FROM kv WHERE k = 'state'`)).rows[0].v; },
    // Every write runs in a transaction holding a row lock, so concurrent requests cannot lose each other's updates.
    async withState(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const s = (await c.query(`SELECT v FROM kv WHERE k = 'state' FOR UPDATE`)).rows[0].v;
        const out = await fn(s);
        await c.query(`UPDATE kv SET v = $1 WHERE k = 'state'`, [JSON.stringify(s)]);
        await c.query('COMMIT');
        return out;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async getTerms(a) { return (await pool.query(`SELECT rec FROM terms WHERE address = $1`, [a])).rows[0]?.rec || null; },
    async saveTerms(a, rec) { await pool.query(`INSERT INTO terms (address, rec) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET rec = EXCLUDED.rec`, [a, JSON.stringify(rec)]); },
    async addFloor(x) {
      await pool.query(`INSERT INTO floors (at, credit, statement) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [x.at, x.credit, x.statement ?? null]);
      await pool.query(`DELETE FROM floors WHERE at < $1`, [Date.now() - 25 * 36e5]);
    },
    async floors() { return (await pool.query(`SELECT at, credit, statement FROM floors ORDER BY at`)).rows.map(r => ({ at: Number(r.at), credit: r.credit, ...(r.statement ? { statement: r.statement } : {}) })); },
    async useNonce(n, exp) {
      await pool.query(`DELETE FROM nonces WHERE exp < $1`, [Date.now()]);
      const r = await pool.query(`INSERT INTO nonces (n, exp) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [n, exp]);
      return r.rowCount === 1;
    },
    async ownerChanges() {
      const block = (await pool.query(`SELECT v FROM kv WHERE k = 'owners_block'`)).rows[0].v;
      const rows = (await pool.query(`SELECT id, owner FROM owners`)).rows;
      return { block: Number(block), changes: Object.fromEntries(rows.map(r => [r.id, r.owner])) };
    },
    async saveOwnerChanges(block, changes) {
      const ids = Object.keys(changes).map(Number), owners = ids.map(i => changes[i]);
      if (ids.length) await pool.query(`INSERT INTO owners (id, owner) SELECT * FROM unnest($1::int[], $2::text[]) ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner`, [ids, owners]);
      await pool.query(`UPDATE kv SET v = $1 WHERE k = 'owners_block'`, [JSON.stringify(block)]);
    },
  };
}

let _store;
export function store() {
  // Outside production (dev mode has no-signature sign-in) never touch a real database unless explicitly allowed:
  // the Neon integration pins DATABASE_URL to every Vercel environment, so a pulled env would otherwise hit production.
  const url = process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_DATABASE === '1' ? process.env.DATABASE_URL : '';
  if (!url && process.env.DATABASE_URL) console.warn('DATABASE_URL ignored outside production (set ALLOW_DEV_DATABASE=1 to override)');
  return (_store ||= url ? pgStore(url) : Promise.resolve(fileStore()));
}
