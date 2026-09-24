// Statement Maker — local prototype server. No contracts yet: parties live in data/state.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startEvm, ART, artAbi } from './scripts/evm.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8088);
const SLOTS = 80;
const ZERO = '0x0000000000000000000000000000000000000000';
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
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

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
  return { yes, no, passing, endsAt, closed, execBy, lapsed, executable: closed && passing && !prop.executed && !lapsed };
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
    eligible: [...byId.values()].filter(c => matches(c, p.params.filters)).length,
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
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = req => new Promise(r => { let s = ''; req.on('data', d => (s += d)); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
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
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(f));
    }
    const [, a, b, c] = seg;
    if (a === 'svg') {
      const id = Number(b);
      if (!byId.has(id)) return json(res, 404, { error: 'no credit' });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(await svg(id));
    }
    if (a === 'stats') {
      const bal = [...holders.values()].map(v => v.length);
      return json(res, 200, {
        block, credits: byId.size, holders: holders.size, maxStatements: Math.floor(byId.size / SLOTS),
        soloStatements: bal.reduce((s, n) => s + Math.floor(n / SLOTS), 0),
        scattered: bal.filter(n => n < SLOTS).reduce((s, n) => s + n, 0),
        ranges: { id: [1, byId.size], rank: [1, byId.size], marks: MARKS, minDeposit: [1, SLOTS], days: [1, 60] },
        floor: floor.credit, freq: Object.fromEntries(TRAITS.map(k => [k, Object.fromEntries(freq[k])])),
      });
    }
    if (a === 'gas') return json(res, 200, { ...gas, units: GAS });
    if (a === 'dev' && b === 'advance' && req.method === 'POST') {
      const x = await body(req);
      state.clockOffset = (state.clockOffset || 0) + Math.max(0, Number(x.hours) || 0) * 36e5;
      save(); return json(res, 200, { now: now() });
    }
    if (a === 'holders') return json(res, 200, [...holders].sort((x, y) => y[1].length - x[1].length).slice(0, 40).map(([address, ids]) => ({ address, count: ids.length })));
    if (a === 'wallet') {
      const ids = holders.get(addr(b)) || [];
      const inParty = new Set(state.parties.flatMap(deposited));
      return json(res, 200, ids.map(id => ({ ...card(byId.get(id)), deposited: inParty.has(id) })).sort((x, y) => x.rank - y.rank));
    }
    if (a === 'eligible' && req.method === 'POST') {
      const f = await body(req);
      const list = [...byId.values()].filter(c => matches(c, f));
      const owners = new Set(list.map(c => c.owner));
      return json(res, 200, { count: list.length, owners: owners.size, statements: Math.floor(list.length / SLOTS), sample: list.sort((x, y) => x.rank - y.rank).slice(0, 16).map(c => c.id) });
    }
    if (a === 'statements') return json(res, 200, state.parties.filter(q => q.assembled).sort((x, y) => x.assembled.number - y.assembled.number).map(view));
    if (a === 'parties' && !b && req.method === 'GET') return json(res, 200, state.parties.map(view));
    if (a === 'parties' && !b && req.method === 'POST') {
      const x = await body(req);
      const host = addr(x.address);
      if (!holders.has(host)) return json(res, 400, { error: 'host must hold at least one Credit' });
      const id = (x.name || 'party').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) + '-' + Date.now().toString(36).slice(-4);
      const p = { id, name: String(x.name || 'Untitled').slice(0, 60), hosts: [host], createdAt: Date.now(), deadline: Date.now() + (Number(x.days) || 14) * 864e5, params: { voteHours: WINDOWS.includes(Number(x.voteHours)) ? Number(x.voteHours) : 48, minDeposit: Math.max(1, Math.min(80, Number(x.minDeposit) || 1)), target: x.target || { mode: 'fixed', value: 2.5 }, filters: x.filters || {} }, deposits: [], order: null, arranger: null, proposals: [], chat: [] };
      state.parties.unshift(p); save();
      return json(res, 200, view(p));
    }
    const p = a === 'parties' && find(b);
    if (a === 'parties' && !p) return json(res, 404, { error: 'no party' });
    if (p && !c) return json(res, 200, view(p));
    if (p && req.method === 'POST') {
      const x = await body(req);
      const who = addr(x.address);
      const st = status(p);
      if (c === 'deposit') {
        if (st !== 'OPEN') return json(res, 400, { error: 'party is ' + st });
        const ids = [...new Set((x.ids || []).map(Number))];
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
        ids.forEach(id => p.deposits.push({ address: who, id, at: Date.now() }));
        save(); return json(res, 200, view(p));
      }
      if (c === 'withdraw') {
        if (st !== 'OPEN' && st !== 'EXPIRED') return json(res, 400, { error: 'withdrawals are closed once a party is full' });
        p.deposits = p.deposits.filter(d => !(d.address === who && (!x.ids || x.ids.map(Number).includes(d.id))));
        save(); return json(res, 200, view(p));
      }
      if (c === 'chat') {
        const isMember = p.deposits.some(d => d.address === who) || p.hosts.includes(who);
        if (!isMember) return json(res, 403, { error: 'only depositors and hosts can post' });
        const text = String(x.text || '').trim().slice(0, 500);
        if (text) p.chat.push({ address: who, text, at: Date.now() });
        save(); return json(res, 200, view(p));
      }
      if (c === 'propose') {
        if (st !== 'FULL' && st !== 'ASSEMBLED') return json(res, 400, { error: 'proposals open once the party is full' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'Credit Card holders only' });
        const allowed = st === 'FULL' ? ['NOMINATE_ARRANGER', 'APPROVE_ARRANGEMENT', 'LIST'] : ['LIST', 'CANCEL_LISTING', 'DISTRIBUTE'];
        if (x.type === 'LIST') {
          // Any price may be proposed, including below the floor. Only a vote sets it.
          const mode = ['fixed', 'floorEth', 'floorPct'].includes(x.args?.mode) ? x.args.mode : null;
          const value = Number(x.args?.value);
          if (!mode || !Number.isFinite(value)) return json(res, 400, { error: 'price needs a mode and a number' });
          if (mode === 'fixed' && value <= 0) return json(res, 400, { error: 'a fixed price must be above 0' });
          if (mode !== 'fixed' && !(priceEth({ mode, value }) > 0)) return json(res, 400, { error: 'that price is at or below 0 ETH' });
          x.args = { mode, value };
        }
        if (!allowed.includes(x.type)) return json(res, 400, { error: `${x.type} not allowed while ${st}` });
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
        if (!t.executable) return json(res, 400, { error: prop.executed ? 'already executed' : !t.closed ? 'voting is still open' : t.lapsed ? 'lapsed: not executed within 7 days' : 'did not pass' });
        {
          prop.executed = true; prop.executedBy = who;
          if (prop.type === 'NOMINATE_ARRANGER') p.arranger = prop.args.address;
          if (prop.type === 'APPROVE_ARRANGEMENT') p.order = prop.args.order;
          if (prop.type === 'LIST') p.listing = { ...prop.args, startEth: priceEth(prop.args), at: now() };
        }
        save(); return json(res, 200, view(p));
      }
      if (c === 'arrange') {
        if (who !== arrangerOf(p)) return json(res, 403, { error: 'only the arranger can submit an order' });
        const order = (x.order || []).map(Number);
        const have = new Set(deposited(p));
        if (order.length !== SLOTS || new Set(order).size !== SLOTS || !order.every(id => have.has(id))) return json(res, 400, { error: 'order must contain each of the 80 Credits once' });
        const at = now();
        p.proposals.push({ id: p.proposals.length + 1, type: 'APPROVE_ARRANGEMENT', args: { order, preset: String(x.preset || 'custom').slice(0, 60) }, by: who, at, endsAt: at + windowMs(x.hours, p), votes: { [who]: true } });
        save(); return json(res, 200, view(p));
      }
      if (c === 'assemble') {
        // Simulated: the Statement contract is not public yet. Any member may call once the order is approved.
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        if (st !== 'FULL') return json(res, 400, { error: 'party is ' + st });
        if (!p.order) return json(res, 400, { error: 'the arrangement has not been approved' });
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
        const next = { ...p.params, ...x.params };
        const breaks = p.deposits.filter(d => !matches(byId.get(d.id), next.filters));
        if (breaks.length) return json(res, 400, { error: `would disqualify ${breaks.length} deposited Credit(s)` });
        p.params = next; save(); return json(res, 200, view(p));
      }
    }
    json(res, 404, { error: 'unknown route' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`statement maker on http://localhost:${PORT}  (snapshot block ${block})`));
