// Statement Maker — local prototype server. No contracts yet: parties live in data/state.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startEvm, ART, artAbi } from './scripts/evm.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8088);
const DEV = process.env.NODE_ENV !== 'production'; // dev clock only outside production
const MAX_BODY = 64 * 1024;
const SLOTS = 80;
const ZERO = '0x0000000000000000000000000000000000000000';
const TERMS_VERSION = '2026-09-23';
const VOTE_WINDOW = 48 * 36e5;
const WINDOWS = [24, 48, 72, 168]; // allowed voting windows, hours
const EXEC_WINDOW = 7 * 864e5; // a passed proposal lapses if nobody executes it within 7 days
const windowMs = (h, p) => (WINDOWS.includes(Number(h)) ? Number(h) : (p.params.voteHours || 48)) * 36e5;
// Measured on a mainnet fork (see SPEC §4c) or estimated; used to show costs next to actions.
const GAS = { deposit: 125815, withdraw: 125815, propose: 120000, vote: 60000, execute: 80000, arrange: 2000000, assemble: 2576314, returnCredit: 125815 };

// ---- chain snapshot + traits ----
const { block, credits } = JSON.parse(fs.readFileSync(path.join(DATA, 'credits.json')));
const traits = JSON.parse(fs.readFileSync(path.join(DATA, 'traits.json')));
const byId = new Map();
credits.forEach((c, i) => byId.set(c.id, { ...c, ...traits[i], owner: c.owner?.toLowerCase() }));

// Rarity = information content over the four on-chain traits (sum of -log2 p). Rank 1 = rarest.
const TRAITS = ['colors', 'print', 'weight', 'eights'];
const freq = Object.fromEntries(TRAITS.map(k => [k, new Map()]));
for (const c of byId.values()) for (const k of TRAITS) freq[k].set(c[k], (freq[k].get(c[k]) || 0) + 1);
for (const c of byId.values()) c.score = TRAITS.reduce((s, k) => s + -Math.log2(freq[k].get(c[k]) / byId.size), 0);
[...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id).forEach((c, i) => { c.rank = i + 1; });

let MARKS = [Infinity, -Infinity];
for (const c of byId.values()) MARKS = [Math.min(MARKS[0], c.marks), Math.max(MARKS[1], c.marks)];

const holders = new Map();
for (const c of byId.values()) if (c.owner && c.owner !== ZERO) (holders.get(c.owner) || holders.set(c.owner, []).get(c.owner)).push(c.id);

// ---- floor (data input only; nothing is listed anywhere) ----
let floor = { credit: null, at: 0 };
async function refreshFloor() {
  try {
    const r = await fetch('https://api.opensea.io/api/v2/collections/credits/stats', { headers: process.env.OPENSEA_API_KEY ? { 'x-api-key': process.env.OPENSEA_API_KEY } : {} });
    const j = await r.json();
    if (j?.total?.floor_price) floor = { credit: j.total.floor_price, at: Date.now() };
  } catch {}
}
refreshFloor(); setInterval(refreshFloor, 10 * 60 * 1000);
let gas = { gwei: null, ethUsd: null };
async function refreshGas() {
  try {
    const r = await fetch('https://ethereum-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' });
    gas.gwei = parseInt((await r.json()).result, 16) / 1e9;
    const q = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    gas.ethUsd = Number((await q.json()).data.amount);
  } catch {}
}
refreshGas(); setInterval(refreshGas, 5 * 60 * 1000);

// ---- state ----
const STATE = path.join(DATA, 'state.json');
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : { parties: [] };
// Dev clock: lets the prototype skip ahead through voting windows and deadlines.
const now = () => Date.now() + (state.clockOffset || 0);
const save = () => { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, STATE); };

function matches(c, f = {}) {
  if (f.colors?.length && !f.colors.includes(c.colors)) return false;
  if (f.print?.length && !f.print.includes(c.print)) return false;
  if (f.weight?.length && !f.weight.includes(c.weight)) return false;
  if (f.eights?.length && !f.eights.map(Number).includes(c.eights)) return false;
  if (f.rankMax && c.rank > f.rankMax) return false;
  if (f.idMin && c.id < f.idMin) return false;
  if (f.idMax && c.id > f.idMax) return false;
  if (f.marksMin && c.marks < f.marksMin) return false;
  if (f.marksMax && c.marks > f.marksMax) return false;
  return true;
}
// ---- input schema: every host-supplied value is reduced to known values and bounded numbers ----
const KNOWN = { colors: new Set(), print: new Set(), weight: new Set(), eights: new Set() };
for (const c of byId.values()) for (const k of TRAITS) KNOWN[k].add(c[k]);
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
function cleanFilters(f) {
  f = f && typeof f === 'object' && !Array.isArray(f) ? f : {};
  const out = {};
  for (const k of TRAITS) {
    if (!Array.isArray(f[k])) continue;
    const vals = [...new Set(f[k].slice(0, 20).map(v => (k === 'eights' ? Number(v) : String(v))).filter(v => KNOWN[k].has(v)))];
    if (vals.length) out[k] = vals;
  }
  for (const [k, lo, hi] of [['rankMax', 1, byId.size], ['idMin', 1, byId.size], ['idMax', 1, byId.size], ['marksMin', 0, 256], ['marksMax', 0, 256]]) {
    const n = int(f[k], lo, hi); if (n !== undefined) out[k] = n;
  }
  return out;
}
function cleanTarget(t) {
  const mode = ['fixed', 'floorEth', 'floorPct'].includes(t?.mode) ? t.mode : null;
  const value = Number(t?.value);
  if (!mode || !Number.isFinite(value)) return null;
  if (mode === 'fixed' && !(value > 0 && value < 1e6)) return null;
  if (mode === 'floorPct' && !(value > -100 && value < 1e6)) return null;
  if (mode === 'floorEth' && !(value > -1e6 && value < 1e6)) return null;
  return { mode, value };
}
const eligibleCount = f => { let n = 0; for (const c of byId.values()) if (matches(c, f)) n++; return n; };
const isAddr = a => /^0x[0-9a-f]{40}$/.test(a);
// A stored order is valid only if it is exactly the party's current 80 deposits.
const validOrder = (p, order) => Array.isArray(order) && order.length === SLOTS && new Set(order).size === SLOTS && order.every(id => p.deposits.some(d => d.id === id)) && p.deposits.length === SLOTS;
const deposited = p => p.deposits.map(d => d.id);
const members = p => {
  const m = new Map();
  for (const d of p.deposits) m.set(d.address, (m.get(d.address) || 0) + 1);
  return [...m].map(([address, count]) => ({ address, count, host: p.hosts.includes(address) })).sort((a, b) => b.count - a.count);
};
function status(p) {
  if (p.closed || (!p.assembled && now() > p.deadline)) return 'EXPIRED';
  if (p.assembled) return 'ASSEMBLED';
  return p.deposits.length >= SLOTS ? 'FULL' : 'OPEN';
}
function tally(p, prop) {
  const w = new Map(members(p).map(m => [m.address, m.count]));
  let yes = 0, no = 0;
  for (const [a, v] of Object.entries(prop.votes)) (v ? (yes += w.get(a) || 0) : (no += w.get(a) || 0));
  const endsAt = prop.endsAt || prop.at + VOTE_WINDOW;
  const closed = now() >= endsAt;
  const passing = yes > SLOTS / 2 && no === 0;
  const execBy = endsAt + EXEC_WINDOW;
  const lapsed = closed && passing && !prop.executed && now() > execBy;
  return { yes, no, passing, endsAt, closed, execBy, lapsed, executable: closed && passing && !prop.executed && !lapsed && !prop.superseded };
}
function priceEth(t) {
  const base = floor.credit ? floor.credit * SLOTS : null;
  if (t.mode === 'fixed') return t.value;
  if (!base) return null;
  return t.mode === 'floorPct' ? base * (1 + t.value / 100) : base + t.value;
}
function targetEth(p) {
  const t = p.params.target;
  const base = floor.credit ? floor.credit * SLOTS : null;
  if (t.mode === 'fixed') return t.value;
  if (!base) return null;
  return t.mode === 'floorPct' ? base * (1 + t.value / 100) : base + t.value;
}
// The first host arranges unless members elect someone else.
const arrangerOf = p => p.arranger || p.hosts[0];
function view(p) {
  const order = p.order || deposited(p);
  return {
    ...p, now: now(), orderApproved: !!p.order, arranger: arrangerOf(p), arrangerElected: !!p.arranger, status: status(p), members: members(p), targetEth: targetEth(p),
    credits: order.map(id => card(byId.get(id), p.deposits.find(d => d.id === id)?.address)),
    proposals: p.proposals.map(x => ({ ...x, ...tally(p, x) })),
    eligible: p.eligible ?? (p.eligible = eligibleCount(p.params.filters)),
    floorEth: floor.credit ? floor.credit * SLOTS : null,
    listingEth: p.listing ? priceEth(p.listing) : null,
  };
}
const card = (c, depositor) => c && ({ id: c.id, colors: c.colors, print: c.print, weight: c.weight, eights: c.eights, tier: c.tier, marks: c.marks, rank: c.rank, paidAt: c.paidAt, owner: c.owner, depositor });

// ---- svg cache ----
fs.mkdirSync(path.join(DATA, 'svg'), { recursive: true });
const { client } = await startEvm();
async function svg(id) {
  const f = path.join(DATA, 'svg', id + '.svg');
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const c = byId.get(id);
  const s = await client.readContract({ address: ART, abi: artAbi, functionName: 'svg', args: [c.seedHex, BigInt(c.paidAt)] });
  fs.writeFileSync(f, s);
  return s;
}

// ---- demo seed: real Credits from real holders, marked DEMO ----
if (!state.parties.length) {
  const pick = (f, n, perHolderMax) => {
    const out = [];
    for (const [addr, ids] of [...holders].sort((a, b) => b[1].length - a[1].length)) {
      const ok = ids.filter(id => matches(byId.get(id), f)).slice(0, perHolderMax);
      for (const id of ok) { if (out.length < n) out.push({ address: addr, id, at: Date.now() - Math.random() * 864e5 }); }
      if (out.length >= n) break;
    }
    return out;
  };
  const mk = (id, name, params, n, per) => {
    const deposits = pick(params.filters, n, per);
    return { id, name, demo: true, hosts: [deposits[0].address], createdAt: Date.now() - 2 * 864e5, deadline: Date.now() + 8 * 864e5, params, deposits, order: null, arranger: null, proposals: [], chat: [] };
  };
  const a = mk('eights', 'Two Eights Or More', { minDeposit: 1, target: { mode: 'floorPct', value: 40 }, filters: { eights: [2, 3, 4, 5] } }, 51, 6);
  const b = mk('cyan', 'Cyan Plate Only', { minDeposit: 2, target: { mode: 'fixed', value: 3 }, filters: { colors: ['C'] } }, 23, 4);
  const c = mk('slip', 'Misregistered', { minDeposit: 1, target: { mode: 'floorEth', value: 0.5 }, filters: { print: ['Slip', 'Drift', 'Skew', 'Loose', 'Nudge'] } }, 80, 5);
  const ms = members(c);
  c.arranger = null;
  c.proposals.push({ id: 1, type: 'NOMINATE_ARRANGER', args: { address: ms[1].address }, by: ms[0].address, at: Date.now() - 20 * 36e5, votes: (() => { const v = {}; let w = 0; for (const m of ms) { if (m.address === ms[1].address || w + m.count > 36) continue; v[m.address] = true; w += m.count; } return v; })() });
  c.chat.push({ address: ms[0].address, text: 'we are full. nominating an arranger. i like sorting by print, drift on top.', at: Date.now() - 35e5 });
  c.chat.push({ address: ms[2].address, text: 'yes from me. keep the loose ones in the bottom row.', at: Date.now() - 20e5 });
  a.chat.push({ address: a.hosts[0], text: 'twos and up only. 29 slots left.', at: Date.now() - 50e5 });
  state.parties = [a, b, c];
  save();
}

// ---- http ----
const json = (res, code, body) => { res.writeHead(code, { ...SECURITY, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
// JSON bodies only, capped at 64 KB.
const body = req => new Promise((ok, fail) => {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) { req.resume(); return fail(new HttpError(415, 'content-type must be application/json')); }
  let s = '', size = 0;
  req.on('data', d => { size += d.length; if (size > MAX_BODY) { fail(new HttpError(413, 'request too large')); req.destroy(); } else s += d; });
  req.on('end', () => { try { const v = JSON.parse(s || '{}'); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(new HttpError(400, 'bad json')); } });
});
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
const termsOk = a => state.terms?.[a]?.version === TERMS_VERSION;
const find = id => state.parties.find(p => p.id === id);
const addr = a => String(a || '').toLowerCase();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    if (seg[0] !== 'api') {
      const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
      if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { ...SECURITY, 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
    const [, a, b, c] = seg;
    if (a === 'svg') {
      const id = Number(b);
      if (!byId.has(id)) return json(res, 404, { error: 'no credit' });
      res.writeHead(200, { ...SECURITY, 'content-security-policy': 'sandbox', 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(await svg(id));
    }
    if (a === 'stats') {
      const bal = [...holders.values()].map(v => v.length);
      return json(res, 200, {
        block, credits: byId.size, holders: holders.size, maxStatements: Math.floor(byId.size / SLOTS),
        soloStatements: bal.reduce((s, n) => s + Math.floor(n / SLOTS), 0),
        scattered: bal.filter(n => n < SLOTS).reduce((s, n) => s + n, 0),
        ranges: { id: [1, byId.size], rank: [1, byId.size], marks: MARKS, minDeposit: [1, SLOTS], days: [1, 60] },
        dev: DEV, floor: floor.credit, freq: Object.fromEntries(TRAITS.map(k => [k, Object.fromEntries(freq[k])])),
      });
    }
    if (a === 'terms' && req.method === 'GET') return json(res, 200, { version: TERMS_VERSION, accepted: state.terms?.[addr(b)]?.version === TERMS_VERSION });
    if (a === 'terms' && req.method === 'POST') {
      const x = await body(req);
      const who = addr(x.address);
      if (!/^0x[0-9a-f]{40}$/.test(who)) return json(res, 400, { error: 'bad address' });
      if (x.version !== TERMS_VERSION || x.accept !== true) return json(res, 400, { error: 'terms must be accepted in full' });
      (state.terms ||= {})[who] = { version: TERMS_VERSION, at: now() };
      save(); return json(res, 200, { accepted: true });
    }
    if (a === 'gas') return json(res, 200, { ...gas, units: GAS });
    if (DEV && a === 'dev' && b === 'advance' && req.method === 'POST') {
      const x = await body(req);
      state.clockOffset = (state.clockOffset || 0) + (int(x.hours, 0, 24 * 30) || 0) * 36e5;
      save(); return json(res, 200, { now: now() });
    }
    if (a === 'holders') return json(res, 200, [...holders].sort((x, y) => y[1].length - x[1].length).slice(0, 40).map(([address, ids]) => ({ address, count: ids.length })));
    if (a === 'wallet' && c === 'fit') {
      // Starting points for a wallet: open parties its Credits qualify for, and party ideas built from what it holds.
      const who = addr(b);
      const inParty = new Set(state.parties.flatMap(deposited));
      const mine = (holders.get(who) || []).map(id => byId.get(id)).filter(cr => !inParty.has(cr.id));
      const parties = state.parties.filter(q => status(q) === 'OPEN').map(q => {
        const fit = mine.filter(cr => matches(cr, q.params.filters));
        const left = SLOTS - q.deposits.length;
        return { id: q.id, name: q.name, filters: q.params.filters, target: q.params.target, filled: q.deposits.length, left, minDeposit: Math.min(q.params.minDeposit, left), fit: fit.length, sample: fit.slice(0, 8).map(cr => cr.id) };
      }).filter(q => q.fit > 0 && q.fit >= q.minDeposit).sort((x, y) => y.fit - x.fit);
      const ideas = [];
      const seen = new Set();
      for (const k of TRAITS) {
        const counts = new Map();
        for (const cr of mine) counts.set(cr[k], (counts.get(cr[k]) || 0) + 1);
        for (const [v, n] of counts) {
          if (n < 1) continue;
          const filters = { [k]: [v] };
          ideas.push({ label: `${k === 'eights' ? 'Eights' : k[0].toUpperCase() + k.slice(1)} ${v}`, filters, mine: n, eligible: freq[k].get(v), holders: null, rarity: freq[k].get(v) / byId.size });
        }
      }
      // Rare-and-held first: ideas where the wallet holds a big share of a small pool, then the biggest holdings.
      ideas.sort((x, y) => (y.mine / y.eligible) - (x.mine / x.eligible) || y.mine - x.mine);
      const top = [];
      for (const i of ideas) { if (i.eligible < SLOTS || seen.has(i.label)) continue; seen.add(i.label); top.push(i); if (top.length >= 6) break; }
      const any = { label: 'Any Credit', filters: {}, mine: mine.length, eligible: byId.size };
      const ranks = mine.map(cr => cr.rank).sort((x, y) => x - y);
      const k = Math.min(10, ranks.length);
      const r = k ? Math.max(ranks[k - 1], SLOTS) : 0;
      const rare = k ? { label: `Rarity top ${r.toLocaleString()}`, filters: { rankMax: r }, mine: ranks.filter(x => x <= r).length, eligible: r } : null;
      return json(res, 200, { held: mine.length, parties: parties.slice(0, 12), ideas: [...top, ...(rare && rare.eligible < byId.size ? [rare] : []), any].map(i => ({ ...i, sample: mine.filter(cr => matches(cr, i.filters)).slice(0, 8).map(cr => cr.id) })) });
    }
    if (a === 'wallet') {
      const ids = holders.get(addr(b)) || [];
      const inParty = new Set(state.parties.flatMap(deposited));
      return json(res, 200, ids.map(id => ({ ...card(byId.get(id)), deposited: inParty.has(id) })).sort((x, y) => x.rank - y.rank));
    }
    if (a === 'eligible' && req.method === 'POST') {
      const f = cleanFilters(await body(req));
      const list = [...byId.values()].filter(c => matches(c, f));
      const owners = new Set(list.map(c => c.owner));
      return json(res, 200, { count: list.length, owners: owners.size, statements: Math.floor(list.length / SLOTS), sample: list.sort((x, y) => x.rank - y.rank).slice(0, 16).map(c => c.id) });
    }
    if (a === 'statements') return json(res, 200, state.parties.filter(q => q.assembled).sort((x, y) => x.assembled.number - y.assembled.number).map(view));
    if (a === 'parties' && !b && req.method === 'GET') return json(res, 200, state.parties.map(view));
    if (a === 'parties' && !b && req.method === 'POST') {
      const x = await body(req);
      const host = addr(x.address);
      if (!termsOk(host)) return json(res, 403, { error: 'accept the terms first' });
      if (!holders.has(host)) return json(res, 400, { error: 'host must hold at least one Credit' });
      if (state.parties.filter(q => q.hosts[0] === host && ['OPEN', 'FULL'].includes(status(q))).length >= 3) return json(res, 429, { error: 'a host can run at most 3 open parties' });
      const target = cleanTarget(x.target);
      if (!target) return json(res, 400, { error: 'target price is out of range' });
      const days = int(x.days, 1, 60); if (!days) return json(res, 400, { error: 'deadline must be 1–60 days' });
      const minDeposit = int(x.minDeposit, 1, SLOTS); if (!minDeposit) return json(res, 400, { error: 'minimum deposit must be 1–80' });
      const filters = cleanFilters(x.filters);
      const name = String(x.name || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) + '-' + crypto.randomUUID().slice(0, 8);
      const p = { id, name, hosts: [host], createdAt: now(), deadline: now() + days * 864e5, params: { voteHours: WINDOWS.includes(Number(x.voteHours)) ? Number(x.voteHours) : 48, minDeposit, target, filters }, eligible: eligibleCount(filters), deposits: [], order: null, arranger: null, proposals: [], chat: [] };
      state.parties.unshift(p); save();
      return json(res, 200, view(p));
    }
    const p = a === 'parties' && find(b);
    if (a === 'parties' && !p) return json(res, 404, { error: 'no party' });
    if (p && !c) return json(res, 200, view(p));
    if (p && req.method === 'POST') {
      const x = await body(req);
      const who = addr(x.address);
      if (!termsOk(who)) return json(res, 403, { error: 'accept the terms first' });
      const st = status(p);
      if (c === 'deposit') {
        if (st !== 'OPEN') return json(res, 400, { error: 'party is ' + st });
        const ids = [...new Set((Array.isArray(x.ids) ? x.ids.slice(0, SLOTS) : []).map(Number))];
        const remaining = SLOTS - p.deposits.length;
        const min = Math.min(p.params.minDeposit, remaining);
        if (ids.length < min) return json(res, 400, { error: `minimum deposit is ${min}` });
        if (ids.length > remaining) return json(res, 400, { error: `only ${remaining} slots left` });
        const taken = new Set(state.parties.flatMap(deposited));
        for (const id of ids) {
          const cr = byId.get(id);
          if (!cr || cr.owner !== who) return json(res, 400, { error: `#${id} is not held by this wallet` });
          if (taken.has(id)) return json(res, 400, { error: `#${id} is already in a party` });
          if (!matches(cr, p.params.filters)) return json(res, 400, { error: `#${id} does not meet this party's filters` });
        }
        ids.forEach(id => p.deposits.push({ address: who, id, at: now() }));
        save(); return json(res, 200, view(p));
      }
      if (c === 'withdraw') {
        if (st !== 'OPEN' && st !== 'EXPIRED') return json(res, 400, { error: 'withdrawals are closed once a party is full' });
        const only = Array.isArray(x.ids) ? new Set(x.ids.slice(0, SLOTS).map(Number)) : null;
        p.deposits = p.deposits.filter(d => !(d.address === who && (!only || only.has(d.id))));
        save(); return json(res, 200, view(p));
      }
      if (c === 'chat') {
        const isMember = p.deposits.some(d => d.address === who) || p.hosts.includes(who);
        if (!isMember) return json(res, 403, { error: 'only depositors and hosts can post' });
        const text = String(x.text || '').trim().slice(0, 500);
        const last = [...p.chat].reverse().find(m => m.address === who);
        if (last && now() - last.at < 3000) return json(res, 429, { error: 'slow down' });
        if (text) p.chat.push({ address: who, text, at: now() });
        if (p.chat.length > 1000) p.chat = p.chat.slice(-1000);
        save(); return json(res, 200, view(p));
      }
      if (c === 'propose') {
        if (st !== 'FULL' && st !== 'ASSEMBLED') return json(res, 400, { error: 'proposals open once the party is full' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'Credit Card holders only' });
        // APPROVE_ARRANGEMENT is created only through /arrange, which checks the arranger and the order.
        const allowed = st === 'FULL' ? ['NOMINATE_ARRANGER', 'LIST'] : ['LIST', 'CANCEL_LISTING', 'DISTRIBUTE'];
        if (!allowed.includes(x.type)) return json(res, 400, { error: `${String(x.type).slice(0, 40)} not allowed while ${st}` });
        if (p.proposals.filter(q => q.by === who && !tally(p, q).closed).length >= 3) return json(res, 429, { error: 'at most 3 open proposals per member' });
        if (x.type === 'NOMINATE_ARRANGER') {
          const nominee = addr(x.args?.address);
          if (!isAddr(nominee) || !p.deposits.some(d => d.address === nominee)) return json(res, 400, { error: 'the nominee must be a member' });
          x.args = { address: nominee };
        } else if (x.type !== 'LIST') x.args = {};
        if (x.type === 'LIST') {
          // Any price may be proposed, including below the floor. Only a vote sets it.
          const t = cleanTarget(x.args);
          if (!t) return json(res, 400, { error: 'price is out of range' });
          if (!(priceEth(t) > 0)) return json(res, 400, { error: 'that price is at or below 0 ETH' });
          x.args = t;
        }
        const at = now();
        p.proposals.push({ id: p.proposals.length + 1, type: x.type, args: x.args || {}, by: who, at, endsAt: at + windowMs(x.hours, p), votes: { [who]: true } });
        save(); return json(res, 200, view(p));
      }
      if (c === 'vote') {
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'Credit Card holders only' });
        if (tally(p, prop).closed) return json(res, 400, { error: 'voting has closed' });
        prop.votes[who] = !!x.yes;
        save(); return json(res, 200, view(p));
      }
      if (c === 'execute') {
        // Any member may execute a proposal once its window has closed with YES > 40 and no NO.
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        const t = tally(p, prop);
        if (!t.executable) return json(res, 400, { error: prop.executed ? 'already executed' : prop.superseded ? 'superseded by a later decision' : !t.closed ? 'voting is still open' : t.lapsed ? 'lapsed: not executed within 7 days' : 'did not pass' });
        const RUNS_IN = { NOMINATE_ARRANGER: ['FULL'], APPROVE_ARRANGEMENT: ['FULL'], LIST: ['FULL', 'ASSEMBLED'], CANCEL_LISTING: ['ASSEMBLED'], DISTRIBUTE: ['ASSEMBLED'] };
        if (!RUNS_IN[prop.type]?.includes(st)) return json(res, 400, { error: `${prop.type} cannot run while ${st}` });
        if (prop.type === 'APPROVE_ARRANGEMENT' && !validOrder(p, prop.args.order)) return json(res, 400, { error: 'order no longer matches the party' });
        prop.executed = true; prop.executedBy = who;
        if (prop.type === 'NOMINATE_ARRANGER') p.arranger = prop.args.address;
        if (prop.type === 'APPROVE_ARRANGEMENT') p.order = prop.args.order;
        if (prop.type === 'LIST') p.listing = { ...prop.args, startEth: priceEth(prop.args), at: now() };
        if (prop.type === 'CANCEL_LISTING') p.listing = null;
        // Executing one proposal supersedes every other pending proposal of the same kind (no stale re-runs).
        const kind = t => (t === 'CANCEL_LISTING' ? 'LIST' : t);
        for (const q of p.proposals) if (q !== prop && !q.executed && kind(q.type) === kind(prop.type)) q.superseded = true;
        save(); return json(res, 200, view(p));
      }
      if (c === 'arrange') {
        if (st !== 'FULL') return json(res, 400, { error: 'arranging happens only while the party is full' });
        if (who !== arrangerOf(p)) return json(res, 403, { error: 'only the arranger can submit an order' });
        const order = Array.isArray(x.order) ? x.order.slice(0, SLOTS + 1).map(Number) : [];
        if (!validOrder(p, order)) return json(res, 400, { error: 'order must contain each of the 80 Credits once' });
        if (p.proposals.filter(q => q.type === 'APPROVE_ARRANGEMENT' && !tally(p, q).closed).length >= 3) return json(res, 429, { error: 'at most 3 arrangements under vote at once' });
        const at = now();
        p.proposals.push({ id: p.proposals.length + 1, type: 'APPROVE_ARRANGEMENT', args: { order, preset: String(x.preset || 'custom').slice(0, 60) }, by: who, at, endsAt: at + windowMs(x.hours, p), votes: { [who]: true } });
        save(); return json(res, 200, view(p));
      }
      if (c === 'assemble') {
        // Simulated: the Statement contract is not public yet. Any member may call once the order is approved.
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        if (st !== 'FULL') return json(res, 400, { error: 'party is ' + st });
        if (!p.order || !validOrder(p, p.order)) return json(res, 400, { error: 'the arrangement has not been approved' });
        p.assembled = { by: who, at: now(), number: state.parties.filter(q => q.assembled).length + 1 };
        save(); return json(res, 200, view(p));
      }
      if (c === 'return') {
        // After expiry any member may push every Credit back to its depositor.
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        if (st !== 'EXPIRED') return json(res, 400, { error: 'party has not expired' });
        p.returned = { by: who, at: now(), count: p.deposits.length };
        p.deposits = [];
        save(); return json(res, 200, view(p));
      }
      if (c === 'params') {
        if (!p.hosts.includes(who)) return json(res, 403, { error: 'hosts only' });
        if (st !== 'OPEN') return json(res, 400, { error: 'params lock when the party fills' });
        const q = x.params && typeof x.params === 'object' ? x.params : {};
        const next = { ...p.params };
        if ('minDeposit' in q) { const n = int(q.minDeposit, 1, SLOTS); if (!n) return json(res, 400, { error: 'minimum deposit must be 1–80' }); next.minDeposit = n; }
        if ('target' in q) { const t = cleanTarget(q.target); if (!t) return json(res, 400, { error: 'target price is out of range' }); next.target = t; }
        if ('filters' in q) next.filters = cleanFilters(q.filters);
        if ('voteHours' in q) { if (!WINDOWS.includes(Number(q.voteHours))) return json(res, 400, { error: 'vote window must be 24, 48, 72 or 168 hours' }); next.voteHours = Number(q.voteHours); }
        const breaks = p.deposits.filter(d => !matches(byId.get(d.id), next.filters));
        if (breaks.length) return json(res, 400, { error: `would disqualify ${breaks.length} deposited Credit(s)` });
        p.params = next; p.eligible = eligibleCount(next.filters); save(); return json(res, 200, view(p));
      }
    }
    json(res, 404, { error: 'unknown route' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.code, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'server error' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`statement maker on http://localhost:${PORT}  (snapshot block ${block})`));
