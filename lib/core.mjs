// Statement Maker core: request handler + jobs. Runs under the local server (server.mjs) and on Vercel (api/index.mjs).
// No contracts yet: parties live in the store (lib/store.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ART, artAbi } from '../scripts/evm.mjs';
import { store } from './store.mjs';
import { createPublicClient, http as viemHttp, getAddress, parseAbi, keccak256, encodePacked } from 'viem';
import { mainnet } from 'viem/chains';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const DEV = process.env.NODE_ENV !== 'production'; // dev clock only outside production
const MAX_BODY = 64 * 1024;
// Build id: changes whenever the served front end changes, so open tabs can notice a deploy and reload.
let BUILD = 'dev';
try { BUILD = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public/app.js'))).update(fs.readFileSync(path.join(ROOT, 'public/style.css'))).digest('hex').slice(0, 12); } catch {}
const SLOTS = 80;
const ZERO = '0x0000000000000000000000000000000000000000';
const TERMS_VERSION = '2026-09-23.4';
const VOTE_WINDOW = 48 * 36e5;
const WINDOWS = [24, 48, 72, 168]; // allowed voting windows, hours
const EXEC_WINDOW = 7 * 864e5;
// Deadlock escape: after 3 NO-blocked proposals of a kind, or 30 days without one executing, 2/3 (54 cards) passes it despite NO.
const DEADLOCK_FAILS = 3, DEADLOCK_DAYS = 30, OVERRIDE = Math.ceil(80 * 2 / 3); // a passed proposal lapses if nobody executes it within 7 days
const windowMs = (h, p) => (WINDOWS.includes(Number(h)) ? Number(h) : (p.params.voteHours || 48)) * 36e5;
// Measured on a mainnet fork (see SPEC §4c) or estimated; used to show costs next to actions.
const GAS = { deposit: 125815, withdraw: 125815, propose: 120000, vote: 60000, execute: 80000, arrange: 2000000, assemble: 2576314, returnCredit: 125815 };

// ---- chain snapshot + traits ----
// Credits snapshot + traits: the gzipped copies are committed (Vercel deploys from git); plain JSON is used if present.
const readData = n => { try { return JSON.parse(fs.readFileSync(path.join(DATA, n))); } catch { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, n + '.gz')))); } };
const { block, credits } = readData('credits.json');
const traits = readData('traits.json');
const byId = new Map();
credits.forEach((c, i) => byId.set(c.id, { ...c, ...traits[i], owner: c.owner?.toLowerCase() }));

// Rarity = information content over the four on-chain traits (sum of -log2 p). Rank 1 = rarest.
const TRAITS = ['colors', 'print', 'weight', 'eights'];
const freq = Object.fromEntries(TRAITS.map(k => [k, new Map()]));
for (const c of byId.values()) for (const k of TRAITS) freq[k].set(c[k], (freq[k].get(c[k]) || 0) + 1);
// Rarity uses the same integer table as the contract (CreditKeys.sol): round(-log2(count/N) * 1e9) per trait value.
const RARITY = JSON.parse(fs.readFileSync(path.join(DATA, 'rarity.json')));
for (const c of byId.values()) c.score = TRAITS.reduce((s, k) => s + RARITY[k][String(c[k])].w, 0);
[...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id).forEach((c, i) => { c.rank = i + 1; });

let MARKS = [Infinity, -Infinity];
for (const c of byId.values()) MARKS = [Math.min(MARKS[0], c.marks), Math.max(MARKS[1], c.marks)];

const holders = new Map();
for (const c of byId.values()) if (c.owner && c.owner !== ZERO) (holders.get(c.owner) || holders.set(c.owner, []).get(c.owner)).push(c.id);

// ---- live ownership: follow Credits Transfer events from the snapshot block onward ----
const CREDITS = '0x97630aa70ab14ed9883b41dafccbc11349723043';
const RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
const chain = createPublicClient({ chain: mainnet, transport: viemHttp(RPC) });
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
let syncedBlock = block;
function moveCredit(id, to) {
  const c = byId.get(id); if (!c) return;
  const from = c.owner;
  if (from && holders.has(from)) { const l = holders.get(from).filter(x => x !== id); l.length ? holders.set(from, l) : holders.delete(from); }
  c.owner = to;
  if (to && to !== ZERO) (holders.get(to) || holders.set(to, []).get(to)).push(id);
}
async function syncTransfers() {
  try {
    // Stay a few blocks behind: load-balanced RPCs can report a head the node serving getLogs hasn't reached.
    const head = Number(await chain.getBlockNumber()) - 3;
    while (syncedBlock < head) {
      const to = Math.min(syncedBlock + 500, head);
      const logs = await chain.request({ method: 'eth_getLogs', params: [{ address: CREDITS, topics: [TRANSFER], fromBlock: '0x' + (syncedBlock + 1).toString(16), toBlock: '0x' + to.toString(16) }] });
      const changes = {};
      for (const l of logs) { const id = parseInt(l.topics[3], 16), who = '0x' + l.topics[2].slice(26).toLowerCase(); moveCredit(id, who); changes[id] = who; }
      syncedBlock = to;
      await (await store()).saveOwnerChanges(to, changes);
    }
  } catch (e) { console.error('transfer sync', e.shortMessage || e.message); }
}
export { syncTransfers };
// Apply ownership changes recorded since the bundled snapshot (refreshed at most once a minute per instance).
let ownersLoadedAt = 0;
async function loadOwners() {
  if (Date.now() - ownersLoadedAt < 60_000) return;
  ownersLoadedAt = Date.now();
  const o = await (await store()).ownerChanges();
  for (const [id, who] of Object.entries(o.changes)) if (byId.get(Number(id))?.owner !== who) moveCredit(Number(id), who);
  if (o.block > syncedBlock) syncedBlock = o.block;
}
const ownerAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);
// Belt and braces at deposit: read ownerOf on-chain for each Credit. (The real vault only counts Credits it actually receives.)
async function liveOwners(ids) {
  const r = await Promise.all(ids.map(id => chain.readContract({ address: CREDITS, abi: ownerAbi, functionName: 'ownerOf', args: [BigInt(id)] }).then(a => a.toLowerCase(), () => ZERO)));
  return new Map(ids.map((id, i) => [id, r[i]]));
}

// ---- sign-in: EIP-4361 message whose statement is the terms acceptance; session cookie after verification ----
// Sessions and sign-in challenges are HMAC-signed values (no server memory); used nonces are recorded in the store.
const SECRET = process.env.SESSION_SECRET || (DEV ? crypto.randomBytes(32).toString('hex') : null);
if (!SECRET) throw new Error('SESSION_SECRET is required in production');
const SESSION_MS = 7 * 864e5;
const mac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function sessionOf(req) {
  const t = cookies(req).sm_session || '';
  const [address, exp, sig] = t.split('.');
  if (!address || !exp || !sig || sig.length !== 43) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac(address + '.' + exp)))) return null;
  if (Number(exp) < Date.now() || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  return address;
}
function startSession(res, address) {
  const exp = Date.now() + SESSION_MS;
  const token = `${address}.${exp}.${mac(address + '.' + exp)}`;
  res.setHeader('set-cookie', `sm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${DEV ? '' : '; Secure'}`);
}
const TERMS_STATEMENT = `I accept the Statement Maker terms and conditions, version ${TERMS_VERSION}. I understand that deposits lock at 80, that assembly burns my Credits permanently, that a single no vote can block a sale, and that Credit Cards may be worth nothing.`;
function siweMessage(host, origin, address, nonce) {
  return `${host} wants you to sign in with your Ethereum account:\n${address}\n\n${TERMS_STATEMENT}\n\nURI: ${origin}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
}

// ---- floor (data input only; nothing is listed anywhere) ----
// Credits floor from OpenSea listings, read every minute and kept for 25 hours (data/floor.json).
// A party uses either the 24-hour average of these readings (default; resists a single cheap listing) or the latest reading.
let floorHist = [];
let floorsLoadedAt = 0;
async function loadFloors() { if (Date.now() - floorsLoadedAt < 30_000) return; floorsLoadedAt = Date.now(); floorHist = await (await store()).floors(); }
// Once Jack's Statement collection exists on OpenSea, set STATEMENT_SLUG and its own floor replaces the 80 × Credits proxy.
const STATEMENT_SLUG = process.env.STATEMENT_SLUG || '';
async function osFloor(slug) {
  const r = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, { headers: process.env.OPENSEA_API_KEY ? { 'x-api-key': process.env.OPENSEA_API_KEY } : {} });
  const v = Number((await r.json())?.total?.floor_price);
  return v > 0 ? v : null;
}
async function refreshFloor() {
  try {
    const v = await osFloor('credits');
    const st = STATEMENT_SLUG ? await osFloor(STATEMENT_SLUG).catch(() => null) : null;
    if (v > 0) {
      const r = { at: Date.now(), credit: v, ...(st ? { statement: st } : {}) };
      await (await store()).addFloor(r);
      floorHist.push(r); floorHist = floorHist.filter(x => x.at > Date.now() - 25 * 36e5);
    }
  } catch {}
}
export { refreshFloor };
const FLOOR_MODES = ['avg24h', 'latest'];
// Source: the Statement collection's floor when readings exist, otherwise 80 × the Credits floor.
function floorInfo(mode = 'avg24h') {
  if (!floorHist.length) return { credit: null, eth: null, hours: 0, samples: 0, mode, source: 'credits' };
  const useStatement = floorHist.at(-1).statement > 0;
  const val = x => (useStatement ? x.statement : x.credit * SLOTS);
  const source = useStatement ? 'statements' : 'credits';
  if (mode === 'latest') { const l = floorHist.at(-1); return { credit: l.credit, eth: val(l), hours: 0, samples: 1, at: l.at, mode, source }; }
  const xs = floorHist.filter(x => x.at > Date.now() - 864e5 && (!useStatement || x.statement > 0));
  const eth = xs.reduce((a, x) => a + val(x), 0) / xs.length;
  return { credit: xs.reduce((a, x) => a + x.credit, 0) / xs.length, eth, hours: +((Date.now() - xs[0].at) / 36e5).toFixed(1), samples: xs.length, mode, source };
}
const floorFor = p => floorInfo(p?.params?.floorMode || 'avg24h');
const floor = { get credit() { return floorInfo('avg24h').credit; } };
let gas = { gwei: null, ethUsd: null };
async function refreshGas() {
  try {
    const r = await fetch('https://ethereum-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' });
    gas.gwei = parseInt((await r.json()).result, 16) / 1e9;
    const q = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    gas.ethUsd = Number((await q.json()).data.amount);
  } catch {}
}
let gasAt = 0;
const maybeRefreshGas = () => { if (Date.now() - gasAt > 5 * 6e4) { gasAt = Date.now(); refreshGas(); } };

// ---- state ----
// Per-request state: each request gets its own copy from the store (writes commit in one locked transaction).
const als = new AsyncLocalStorage();
const state = new Proxy({}, { get: (_, k) => als.getStore()?.[k], set: (_, k, v) => { als.getStore()[k] = v; return true; } });
function migrate() {
  state.parties ||= [];
  state.nextCard ||= 1;
  for (const p of state.parties) for (const d of p.deposits) { d.depositor ||= d.address; d.card ||= state.nextCard++; }
  for (const p of state.parties) for (const q of p.proposals) if (!q.snapshot) { const m = {}; for (const d of p.deposits) m[d.address] = (m[d.address] || 0) + 1; q.snapshot = m; }
  for (const p of state.parties) if (p.deposits.length >= 80 && !p.fullAt) p.fullAt = Math.max(...p.deposits.map(d => d.at));
}
// Dev clock: lets the prototype skip ahead through voting windows and deadlines.
const now = () => Date.now() + (state.clockOffset || 0);
const save = () => {}; // the store commits the whole request's changes

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
  // Misregistration detail, from the art library's own slips(): which plates moved and how far.
  if (f.shiftPlates?.length && !f.shiftPlates.every(pl => c.shifted.includes(pl))) return false;
  if (f.shiftOnly && f.shiftPlates?.length && c.shifted !== 'CMYK'.split('').filter(pl => f.shiftPlates.includes(pl)).join('')) return false;
  if (f.shiftMin && c.shift < f.shiftMin) return false;
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
  if (Array.isArray(f.shiftPlates)) { const v = [...new Set(f.shiftPlates.map(String).filter(x => 'CMYK'.includes(x) && x.length === 1))]; if (v.length) out.shiftPlates = v; }
  if (f.shiftOnly === true && out.shiftPlates) out.shiftOnly = true;
  { const n = int(f.shiftMin, 1, 2); if (n) out.shiftMin = n; }
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
// ---- default arrangement presets (same orderings as the client's auto-order) ----
const COLOR_ORDER = ['C', 'M', 'Y', 'K', 'CM', 'CY', 'MY', 'CK', 'MK', 'YK', 'CMY', 'CMK', 'CYK', 'MYK', 'CMYK'];
const PRINT_ORDER = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHT_ORDER = ['sparse', 'lean', 'even', 'extreme'];
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
// Must match CreditKeys.sol exactly: strictly ordered keys, ties broken by ascending id.
const PRESETS = {
  Deposit: cs => cs,
  Number: cs => [...cs].sort((a, b) => a.id - b.id),
  Time: cs => [...cs].sort((a, b) => a.paidAt - b.paidAt || a.id - b.id),
  Rarity: cs => [...cs].sort((a, b) => b.score - a.score || a.id - b.id),
  Colors: cs => [...cs].sort((a, b) => COLOR_ORDER.indexOf(a.colors) - COLOR_ORDER.indexOf(b.colors) || a.id - b.id),
  Print: cs => [...cs].sort((a, b) => PRINT_ORDER.indexOf(b.print) - PRINT_ORDER.indexOf(a.print) || a.id - b.id),
  Weight: cs => [...cs].sort((a, b) => WEIGHT_ORDER.indexOf(a.weight) - WEIGHT_ORDER.indexOf(b.weight) || a.marks - b.marks || a.id - b.id),
  Eights: cs => [...cs].sort((a, b) => b.eights - a.eights || a.id - b.id),
  Ink: cs => [...cs].sort((a, b) => a.marks - b.marks || a.id - b.id),
  // Fisher–Yates with j = keccak256(abi.encodePacked(uint256 seed, uint256 i)) mod (i + 1), as CreditKeys.shuffle.
  Random: (cs, seed) => { const o = [...cs]; for (let i = o.length; i > 1; i--) { const j = Number(BigInt(keccak256(encodePacked(['uint256', 'uint256'], [BigInt(seed), BigInt(i - 1)]))) % BigInt(i)); [o[i - 1], o[j]] = [o[j], o[i - 1]]; } return o; },
};
function cleanArrangement(a) {
  // 'Manual' means the host orders the 80 by hand in the same step as the burn.
  const preset = a?.preset === 'Manual' || Object.hasOwn(PRESETS, a?.preset) ? a.preset : 'Deposit';
  return preset === 'Random' ? { preset, seed: int(a?.seed, 1, 999999) || 1 + Math.floor(Math.random() * 999999) } : { preset };
}
const defaultOrder = p => { const a = p.params.arrangement || { preset: 'Deposit' }; return (PRESETS[a.preset] || PRESETS.Deposit)(p.deposits.map(d => byId.get(d.id)), a.seed).map(c => c.id); };
const BUY_DELAY = 24 * 36e5; // a price must be live this long before anyone can buy
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
  if (p.sold) return 'SOLD';
  if (p.assembled) return 'ASSEMBLED';
  return p.deposits.length >= SLOTS ? 'FULL' : 'OPEN';
}
function tally(p, prop) {
  // Weight comes from the cards each address held when the proposal was created (no buy-vote-sell).
  const w = new Map(Object.entries(prop.snapshot || {})); // no snapshot, no weight (never fall back to current holders)
  let yes = 0, no = 0;
  for (const [a, v] of Object.entries(prop.votes)) (v ? (yes += w.get(a) || 0) : (no += w.get(a) || 0));
  const endsAt = prop.endsAt || prop.at + VOTE_WINDOW;
  const closed = now() >= endsAt;
  // A price below the floor needs 75% of cards (60 of 80); everything else needs a majority (41).
  const below = prop.type === 'LIST' && belowFloor(prop.args, p);
  const need = below ? Math.ceil(SLOTS * 0.75) : Math.floor(SLOTS / 2) + 1;
  const passing = prop.override ? yes >= Math.max(need, OVERRIDE) : yes >= need && no === 0;
  const execBy = endsAt + EXEC_WINDOW;
  const lapsed = closed && passing && !prop.executed && now() > execBy;
  return { yes, no, need: prop.override ? Math.max(need, OVERRIDE) : need, override: !!prop.override, below, passing, endsAt, closed, execBy, lapsed, executable: closed && passing && !prop.executed && !lapsed && !prop.superseded };
}
const kindOf = t => (t === 'CANCEL_LISTING' ? 'LIST' : t);
function deadlocked(p, type) {
  const k = kindOf(type);
  const same = p.proposals.filter(q => kindOf(q.type) === k);
  if (same.some(q => q.executed)) return false;
  const blocked = same.filter(q => { const t = tally(p, q); return t.closed && t.no > 0 && !q.override; }).length;
  const since = p.assembled?.at || p.fullAt;
  return blocked >= DEADLOCK_FAILS || (since != null && now() - since > DEADLOCK_DAYS * 864e5);
}
const belowFloor = (t, p) => { const e = priceEth(t, p), f = floorFor(p).eth; return e != null && f != null && e < f; };
function priceEth(t, p) {
  const base = floorFor(p).eth;
  if (t.mode === 'fixed') return t.value;
  if (!base) return null;
  return t.mode === 'floorPct' ? base * (1 + t.value / 100) : base + t.value;
}
function targetEth(p) {
  const t = p.params.target;
  const base = floorFor(p).eth;
  if (t.mode === 'fixed') return t.value;
  if (!base) return null;
  return t.mode === 'floorPct' ? base * (1 + t.value / 100) : base + t.value;
}
function view(p) {
  // Until the burn, show the order the party's arrangement setting would produce.
  const order = p.order || (p.deposits.length === SLOTS ? defaultOrder(p) : deposited(p));
  return {
    ...p, now: now(), manual: p.params.arrangement?.preset === 'Manual', status: status(p), members: members(p), targetEth: targetEth(p),
    credits: order.map(id => { const d = p.deposits.find(x => x.id === id); return { ...card(byId.get(id), d?.address), card: d?.card, depositorAddr: d?.depositor, claimed: !!d?.claimed }; }),
    perCard: p.sold ? p.sold.perCard : null,
    buyOpensAt: p.listing ? p.listing.at + BUY_DELAY : null,
    defaultBelowFloor: belowFloor(p.params.target, p),
    deadlock: { LIST: deadlocked(p, 'LIST') },
    proposals: p.proposals.map(x => ({ ...x, ...tally(p, x) })),
    eligible: p.eligible ?? (p.eligible = eligibleCount(p.params.filters)),
    floorEth: floorFor(p).eth,
    floor: floorFor(p),
    listingEth: p.listing ? priceEth(p.listing, p) : null,
  };
}
const card = (c, depositor) => c && ({ id: c.id, colors: c.colors, print: c.print, register: c.register, shifted: c.shifted, shift: c.shift, weight: c.weight, eights: c.eights, tier: c.tier, marks: c.marks, rank: c.rank, paidAt: c.paidAt, owner: c.owner, depositor });

// ---- svg cache ----
// Credit art from the art contract's own svg() (a read call on mainnet); cached on disk locally and on the CDN in production.
const svgMem = new Map();
async function svg(id) {
  if (svgMem.has(id)) return svgMem.get(id);
  const f = path.join(DATA, 'svg', id + '.svg');
  try { const b = fs.readFileSync(f, 'utf8'); svgMem.set(id, b); return b; } catch {}
  const c = byId.get(id);
  const s = await chain.readContract({ address: ART, abi: artAbi, functionName: 'svg', args: [c.seedHex, BigInt(c.paidAt)] });
  if (svgMem.size > 2000) svgMem.delete(svgMem.keys().next().value);
  svgMem.set(id, s);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); } catch {} // read-only on Vercel
  return s;
}

// ---- Credit Card image: what the ERC-721's on-chain tokenURI would draw ----
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// The Statement as one SVG group: 80 Credit SVGs nested in the 8×10 grid (4:5, 8% margin, as jack.art lays it out).
// Cached per party and order. The real card would draw from the Statement contract's own image instead.
const statementCache = new Map();
async function statementGroup(p, x, y, w, cardCredit) {
  const order = p.order || deposited(p);
  const key = p.id + ':' + order.join(',');
  if (!statementCache.has(key)) {
    const h = w * 5 / 4, pad = w * 0.08, cw = (w - pad * 2) / 8, ch = (h - pad * 2) / 10, s = Math.min(cw, ch);
    const cells = await Promise.all(order.map(async (id, i) => {
      const inner = String(await svg(id)).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      return `<svg x="${(pad + (i % 8) * cw + (cw - s) / 2).toFixed(2)}" y="${(pad + Math.floor(i / 8) * ch + (ch - s) / 2).toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" viewBox="0 0 320 320" shape-rendering="crispEdges">${inner}</svg>`;
    }));
    statementCache.set(key, { body: `<rect width="${w}" height="${h}" fill="#fff" stroke="#e3e3e3"/>${cells.join('')}`, pad, cw, ch, h });
    if (statementCache.size > 200) statementCache.delete(statementCache.keys().next().value);
  }
  const g = statementCache.get(key);
  const i = order.indexOf(cardCredit);
  return { g, i };
}
async function cardSvg(p, d) {
  const art = Buffer.from(String(await svg(d.id))).toString('base64');
  // Once the Credits are burned, the card shows the Statement they became, with this card's Credit marked.
  let picture = `<image x="40" y="90" width="360" height="360" href="data:image/svg+xml;base64,${art}"/><rect x="40" y="90" width="360" height="360" fill="none" stroke="#e3e3e3"/>`;
  if (p.assembled) {
    const W = 288, X = 76, Y = 90;
    const { g, i } = await statementGroup(p, X, Y, W, d.id);
    const mark = i >= 0 ? `<rect x="${(X + g.pad + (i % 8) * g.cw - 1).toFixed(2)}" y="${(Y + g.pad + Math.floor(i / 8) * g.ch - 1).toFixed(2)}" width="${(g.cw + 2).toFixed(2)}" height="${(g.ch + 2).toFixed(2)}" fill="none" stroke="#111" stroke-width="1.5"/><rect x="${(X + g.pad + (i % 8) * g.cw).toFixed(2)}" y="${(Y + g.pad + (Math.floor(i / 8) + 1) * g.ch + 1).toFixed(2)}" width="${g.cw.toFixed(2)}" height="3" fill="#FFD100"/>` : '';
    picture = `<g transform="translate(${X} ${Y})">${g.body}</g>${mark}`;
  }
  const st = status(p);
  const order = p.order || deposited(p);
  const slot = order.indexOf(d.id);
  const pos = slot >= 0 ? `ROW ${Math.floor(slot / 8) + 1} · COL ${(slot % 8) + 1}` : 'UNPLACED';
  const line = st === 'SOLD' ? (d.claimed ? 'REDEEMED' : `CLAIM ${p.sold.perCard.toFixed(4)} ETH`) : st === 'ASSEMBLED' ? `STATEMENT ${p.assembled.number}` : st === 'EXPIRED' ? 'REDEEM FOR CREDIT' : st === 'FULL' ? 'ARRANGING' : `${p.deposits.length}/80 FILLED`;
  const t = (x, y, text, size = 18, weight = 400, fill = '#111') => `<text x="${x}" y="${y}" font-family="SF Mono, Menlo, monospace" font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing=".04em">${xml(text)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 856 540" width="856" height="540">
<rect width="856" height="540" fill="#fff"/><rect x=".5" y=".5" width="855" height="539" fill="none" stroke="#111"/>
${picture}
${t(40, 60, 'CREDIT CARD', 22, 700)}${t(816, 60, 'NO. ' + String(d.card).padStart(6, '0'), 18, 400, '#929292').replace('<text', '<text text-anchor="end"')}
${t(440, 120, p.name.toUpperCase().slice(0, 30), 20, 700)}
${t(440, 160, 'CREDIT #' + d.id, 18)}
${t(440, 192, pos, 18, 400, '#929292')}
${t(440, 224, '1 OF 80 · 1 VOTE · 1/80 OF SALE', 16, 400, '#929292')}
${t(440, 300, line, 22, 700)}
${t(440, 332, st, 16, 400, '#929292')}
<rect x="440" y="410" width="22" height="22" fill="#00B5E2"/><rect x="466" y="410" width="22" height="22" fill="#E4007C"/><rect x="492" y="410" width="22" height="22" fill="#FFD100"/><rect x="518" y="410" width="22" height="22" fill="#111"/>
${t(816, 428, 'STATEMENT MAKER', 16, 400, '#929292').replace('<text', '<text text-anchor="end"')}
</svg>`;
}

// ---- demo seed: real Credits from real holders, marked DEMO ----
function seedDemo() {
  if (state.parties.length) return;
  const pick = (f, n, perHolderMax) => {
    const out = [];
    for (const [addr, ids] of [...holders].sort((a, b) => b[1].length - a[1].length)) {
      const ok = ids.filter(id => matches(byId.get(id), f)).slice(0, perHolderMax);
      for (const id of ok) { if (out.length < n) out.push({ address: addr, depositor: addr, card: state.nextCard++, id, at: Date.now() - Math.random() * 864e5 }); }
      if (out.length >= n) break;
    }
    return out;
  };
  const mk = (id, name, params, n, per) => {
    const deposits = pick(params.filters, n, per);
    return { id, name, demo: true, hosts: [deposits[0].address], createdAt: Date.now() - 2 * 864e5, deadline: Date.now() + 8 * 864e5, params, deposits, order: null, arranger: null, proposals: [], chat: [] };
  };
  const a = mk('eights', 'Two Eights Or More', { minDeposit: 1, voteHours: 48, arrangement: { preset: 'Eights' }, target: { mode: 'floorPct', value: 40 }, filters: { eights: [2, 3, 4, 5] } }, 51, 6);
  const b = mk('cyan', 'Cyan Plate Only', { minDeposit: 2, voteHours: 48, arrangement: { preset: 'Ink' }, target: { mode: 'fixed', value: 3 }, filters: { colors: ['C'] } }, 23, 4);
  const c = mk('slip', 'Misregistered', { minDeposit: 1, voteHours: 48, arrangement: { preset: 'Manual' }, target: { mode: 'floorEth', value: 0.5 }, filters: { print: ['Slip', 'Drift', 'Skew', 'Loose', 'Nudge'] } }, 80, 5);
  const snap = q => Object.fromEntries(members(q).map(m => [m.address, m.count]));
  const votesUpTo = (q, cap, skip = []) => { const v = {}; let w = 0; for (const m of members(q)) { if (skip.includes(m.address) || w + m.count > cap) continue; v[m.address] = true; w += m.count; } return v; };
  const T = Date.now();
  const ms = members(c);
  c.fullAt = T - 3 * 864e5;
  const v3 = votesUpTo(c, 50, [ms[9].address]); v3[ms[9].address] = false;
  c.proposals.push({ id: 1, type: 'LIST', args: { mode: 'floorPct', value: -20 }, by: ms[2].address, at: T - 10 * 36e5, endsAt: T + 38 * 36e5, snapshot: snap(c), votes: v3 });
  c.proposals.push({ id: 2, type: 'LIST', args: { mode: 'floorPct', value: 15 }, by: ms[0].address, at: T - 50 * 36e5, endsAt: T - 2 * 36e5, snapshot: snap(c), votes: votesUpTo(c, 48) });
  c.chat.push({ address: ms[0].address, text: 'full. i will hand-arrange: drift and loose along the bottom. price at floor +15% passed, anyone can execute it.', at: T - 35e5 });
  c.chat.push({ address: ms[9].address, text: 'voted no on -20%. not selling below floor.', at: T - 20e5 });
  a.chat.push({ address: a.hosts[0], text: 'twos and up only. 29 slots left.', at: T - 50e5 });
  // An assembled, listed party so the buy and claim flow can be seen.
  const k = mk('black', 'Black Plate Only', { minDeposit: 1, voteHours: 48, arrangement: { preset: 'Ink' }, target: { mode: 'fixed', value: 3 }, filters: { colors: ['K'] } }, 80, 5);
  k.fullAt = T - 6 * 864e5;
  k.order = deposited(k).map(id => byId.get(id)).sort((x, y) => x.marks - y.marks).map(x => x.id);
  k.assembled = { by: members(k)[2].address, at: T - 2 * 864e5, number: 1 };
  k.proposals.push({ id: 1, type: 'LIST', args: { mode: 'fixed', value: 3 }, by: k.hosts[0], at: T - 44 * 36e5, endsAt: T - 20 * 36e5, snapshot: snap(k), votes: votesUpTo(k, 47), executed: true, executedBy: members(k)[1].address });
  k.listing = { mode: 'fixed', value: 3, startEth: 3, at: T - 19 * 36e5, source: 'vote' };
  k.orderSource = 'Ink';
  k.deadline = T + 10 * 864e5;
  // Two more assembled parties so the buyer gallery shows a listing and a sale.
  const y = mk('yellow', 'Yellow Plate Only', { minDeposit: 1, voteHours: 48, arrangement: { preset: 'Weight' }, target: { mode: 'floorPct', value: 30 }, filters: { colors: ['Y'] } }, 80, 5);
  y.fullAt = T - 4 * 864e5; y.order = defaultOrder(y); y.orderSource = 'Weight';
  y.assembled = { by: y.hosts[0], at: T - 3 * 864e5, number: 2 };
  y.listing = { mode: 'floorPct', value: 30, startEth: priceEth({ mode: 'floorPct', value: 30 }, y), at: T - 60 * 36e5, source: 'default' };
  y.deadline = T + 10 * 864e5; y.description = 'Yellow only, sparse to extreme.';
  const mg = mk('magenta', 'Magenta Plate Only', { minDeposit: 1, voteHours: 48, arrangement: { preset: 'Rarity' }, target: { mode: 'fixed', value: 2.9 }, filters: { colors: ['M'] } }, 80, 5);
  mg.fullAt = T - 7 * 864e5; mg.order = defaultOrder(mg); mg.orderSource = 'Rarity';
  mg.assembled = { by: mg.hosts[0], at: T - 6 * 864e5, number: 3 };
  mg.listing = { mode: 'fixed', value: 2.9, startEth: 2.9, at: T - 5 * 864e5, source: 'default' };
  mg.sold = { buyer: '0x00000000000000000000000000000000000b0b0b', price: 2.9, royalty: 0, fee: 0.029, perCard: 2.9 * 0.99 / SLOTS, at: T - 3 * 864e5 };
  mg.deadline = T + 10 * 864e5; mg.description = 'Magenta only, rarest first.';
  a.description = 'Only Credits with two or more eights in the transaction ID. Arranged by eights, most first.';
  b.description = 'Cyan plate only. One colour, eighty ways. Light to dark.';
  c.description = 'Every print that slipped, drifted, skewed or came loose. Registration errors as the subject.';
  k.description = 'Black plate only, sparse to dense.';
  // In production, demo parties must not attribute invented votes or chat to real people: swap in synthetic addresses.
  if (!DEV) {
    const map = new Map(); const fake = a => { if (!map.has(a)) map.set(a, '0x' + (map.size + 1).toString(16).padStart(40, '0')); return map.get(a); };
    for (const q of [a, b, c, k, y, mg]) {
      q.hosts = q.hosts.map(fake);
      q.deposits.forEach(d => { d.address = fake(d.address); d.depositor = fake(d.depositor); });
      if (q.arranger) q.arranger = fake(q.arranger);
      q.chat.forEach(m => { m.address = fake(m.address); });
      for (const pr of q.proposals) {
        pr.by = fake(pr.by); if (pr.executedBy) pr.executedBy = fake(pr.executedBy);
        if (pr.args?.address) pr.args.address = fake(pr.args.address);
        pr.votes = Object.fromEntries(Object.entries(pr.votes).map(([x, v]) => [fake(x), v]));
        pr.snapshot = Object.fromEntries(Object.entries(pr.snapshot || {}).map(([x, v]) => [fake(x), v]));
      }
      if (q.assembled) q.assembled.by = fake(q.assembled.by);
    }
  }
  state.parties = [a, b, c, k, y, mg];
}

// ---- http ----
const json = (res, code, body) => { res.writeHead(code, { ...SECURITY, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
// JSON bodies only, capped at 64 KB.
const body = req => new Promise((ok, fail) => {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) { req.resume?.(); return fail(new HttpError(415, 'content-type must be application/json')); }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return fail(new HttpError(413, 'request too large'));
  // Vercel pre-parses JSON bodies onto req.body; the local server reads the stream.
  if (req.body !== undefined) {
    try { const v = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body; return ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
    catch { return fail(new HttpError(400, 'bad json')); }
  }
  let s = '', size = 0;
  req.on('data', d => { size += d.length; if (size > MAX_BODY) { fail(new HttpError(413, 'request too large')); req.destroy(); } else s += d; });
  req.on('end', () => { try { const v = JSON.parse(s || '{}'); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(new HttpError(400, 'bad json')); } });
});
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
const termsOk = a => state.terms?.[a]?.version === TERMS_VERSION;
const find = id => state.parties.find(p => p.id === id);
const addr = a => String(a || '').toLowerCase();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Parties are for Credit holders: a wallet may see and use them if it holds a Credit or a Credit Card.
const holdsCard = who => state.parties.some(q => q.deposits.some(d => d.address === who && !d.claimed));
const canParty = who => !!who && (holders.has(who) || holdsCard(who));
const STORE_ONLY = 'Statements made by a party can only be sold on Statement Maker, at the party’s own price. They cannot be listed, offered or auctioned on OpenSea or any other marketplace.';

// Shared by party creation and deposits: count, live ownership, not already in a party, meets the party's filters.
async function checkDeposit(p, who, rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds.slice(0, SLOTS) : []).map(Number))];
  const remaining = SLOTS - p.deposits.length;
  const min = Math.min(p.params.minDeposit, remaining);
  if (ids.length < min) return { error: `minimum deposit is ${min}` };
  if (ids.length > remaining) return { error: `only ${remaining} slots left` };
  const live = await liveOwners(ids).catch(() => null);
  if (!live) return { error: 'could not read ownership from the chain, try again', code: 503 };
  for (const id of ids) if (byId.has(id) && live.get(id) !== byId.get(id).owner) moveCredit(id, live.get(id));
  const taken = new Set(state.parties.flatMap(deposited));
  for (const id of ids) {
    const cr = byId.get(id);
    if (!cr || cr.owner !== who) return { error: `#${id} is not held by this wallet` };
    if (taken.has(id)) return { error: `#${id} is already in a party` };
    if (!matches(cr, p.params.filters)) return { error: `#${id} does not meet this party's filters` };
  }
  return { ids };
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  // Vercel rewrites /api/* to /api/index?__path=*; restore the original path.
  if (u.searchParams.has('__path')) { u.pathname = '/api/' + u.searchParams.get('__path'); u.searchParams.delete('__path'); }
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST') {
      // Same-origin POSTs only (with SameSite=Strict cookies this blocks cross-site requests).
      const o = req.headers.origin;
      if (o && new URL(o).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
    }
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
      res.writeHead(200, { ...SECURITY, 'content-security-policy': 'sandbox', 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable' });
      return res.end(await svg(id));
    }
    if (a === 'stats') {
      const bal = [...holders.values()].map(v => v.length);
      return json(res, 200, {
        block, credits: byId.size, holders: holders.size, maxStatements: Math.floor(byId.size / SLOTS),
        soloStatements: bal.reduce((s, n) => s + Math.floor(n / SLOTS), 0),
        scattered: bal.filter(n => n < SLOTS).reduce((s, n) => s + n, 0),
        ranges: { id: [1, byId.size], rank: [1, byId.size], marks: MARKS, minDeposit: [1, SLOTS], days: [1, 60] },
        dev: DEV, syncedBlock, floor: floor.credit, floorLatest: floorInfo('latest').credit, floorAvg: floorInfo('avg24h'), freq: Object.fromEntries(TRAITS.map(k => [k, Object.fromEntries(freq[k])])),
      });
    }
    if (a === 'terms' && req.method === 'GET') return json(res, 200, { version: TERMS_VERSION, accepted: state.terms?.[addr(b)]?.version === TERMS_VERSION });
    if (a === 'auth' && b === 'me') { const who = sessionOf(req); return json(res, 200, { address: who, terms: !!who && termsOk(who), canParty: canParty(who), storeOnly: STORE_ONLY, version: TERMS_VERSION }); }
    if (a === 'auth' && b === 'nonce' && req.method === 'POST') {
      const x = await body(req);
      let address; try { address = getAddress(String(x.address || '')); } catch { return json(res, 400, { error: 'bad address' }); }
      const host = String(req.headers.host || ''), origin = `${DEV ? 'http' : 'https'}://${host}`;
      const n = crypto.randomBytes(12).toString('hex'), exp = Date.now() + 10 * 6e4;
      const message = siweMessage(host, origin, address, n);
      // The challenge is self-verifying: the server signs (address, nonce, expiry, message) and keeps nothing until use.
      const nonce = `${n}.${exp}.${mac([address, n, exp, crypto.createHash('sha256').update(message).digest('hex')].join('|'))}`;
      return json(res, 200, { nonce, message });
    }
    if (a === 'auth' && b === 'verify' && req.method === 'POST') {
      const x = await body(req);
      const [nid, exp, tag] = String(x.nonce || '').split('.');
      const message = String(x.message || '');
      const addrLine = message.split('\n')[1] || '';
      let n = null;
      try {
        const want = mac([getAddress(addrLine), nid, exp, crypto.createHash('sha256').update(message).digest('hex')].join('|'));
        if (tag && tag.length === want.length && crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(want)) && Number(exp) > Date.now()) n = { address: getAddress(addrLine), message };
      } catch {}
      if (!n || !(await (await store()).useNonce(nid, Number(exp)))) return json(res, 400, { error: 'sign-in expired, try again' });
      if (!/^0x[0-9a-fA-F]+$/.test(String(x.signature || ''))) return json(res, 400, { error: 'bad signature' });
      // verifyMessage covers plain wallets and smart-contract wallets (EIP-1271 / 6492).
      const ok = await chain.verifyMessage({ address: n.address, message: n.message, signature: x.signature }).catch(() => false);
      if (!ok) return json(res, 401, { error: 'signature does not match' });
      const who = n.address.toLowerCase();
      (state.terms ||= {})[who] = { version: TERMS_VERSION, at: now(), message: n.message, signature: x.signature };
      save(); startSession(res, who);
      return json(res, 200, { address: who, terms: true });
    }
    if (a === 'auth' && b === 'logout' && req.method === 'POST') {
      res.setHeader('set-cookie', 'sm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { address: null });
    }
    if (DEV && a === 'auth' && b === 'dev' && req.method === 'POST') {
      // Prototype only: sign in as a simulated wallet without a signature. Not registered in production.
      const x = await body(req);
      const who = addr(x.address);
      if (!isAddr(who)) return json(res, 400, { error: 'bad address' });
      if (x.accept !== true) return json(res, 400, { error: 'terms must be accepted' });
      (state.terms ||= {})[who] = { version: TERMS_VERSION, at: now(), simulated: true };
      save(); startSession(res, who);
      return json(res, 200, { address: who, terms: true });
    }
    if (a === 'card' && b) {
      const n = Number(String(b).replace(/\.svg$/, ''));
      const p = state.parties.find(q => q.deposits.some(d => d.card === n));
      if (!p) return json(res, 404, { error: 'no card' });
      res.writeHead(200, { ...SECURITY, 'content-security-policy': 'sandbox', 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
      return res.end(await cardSvg(p, p.deposits.find(d => d.card === n)));
    }
    if (a === 'cards' && b) {
      const who = addr(b);
      const out = [];
      for (const p of state.parties) for (const d of p.deposits) if (d.address === who) out.push({ card: d.card, party: p.id, name: p.name, credit: d.id, status: status(p), claimed: !!d.claimed });
      return json(res, 200, out);
    }
    if (a === 'version') return json(res, 200, { build: BUILD });
    if (a === 'gas') return json(res, 200, { ...gas, units: GAS });
    if (DEV && a === 'dev' && b === 'advance' && req.method === 'POST') {
      const x = await body(req);
      state.clockOffset = (state.clockOffset || 0) + (int(x.hours, 0, 24 * 30) || 0) * 36e5;
      save(); return json(res, 200, { now: now() });
    }
    if (a === 'holders') return json(res, 200, [...holders].sort((x, y) => y[1].length - x[1].length).slice(0, 40).map(([address, ids]) => ({ address, count: ids.length })));
    // Gate: parties, party pages (until a Statement is made), wallet tools and eligibility need a Credit or Credit Card.
    {
      const gated = (a === 'wallet') || (a === 'eligible') || (a === 'parties' && !b) || (a === 'parties' && b && c !== 'buy' && !(find(b)?.assembled && !c && req.method === 'GET'));
      if (gated && !canParty(sessionOf(req))) return json(res, 403, { error: 'hold a Credit to use parties', gate: 'credit' });
    }
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
      const raw = await body(req);
      const f = cleanFilters(raw);
      const list = [...byId.values()].filter(c => matches(c, f));
      const n = int(raw.sampleSize, 1, SLOTS) || 16;
      const owners = new Set(list.map(c => c.owner));
      return json(res, 200, { count: list.length, owners: owners.size, statements: Math.floor(list.length / SLOTS), sample: (raw.random ? list.sort(() => Math.random() - 0.5) : list.sort((x, y) => x.rank - y.rank)).slice(0, n).map(c => card(c)) });
    }
    if (a === 'statements') return json(res, 200, state.parties.filter(q => q.assembled).sort((x, y) => x.assembled.number - y.assembled.number).map(view));
    if (a === 'parties' && !b && req.method === 'GET') {
      const limit = int(u.searchParams.get('limit'), 1, 100) || 60, offset = int(u.searchParams.get('offset'), 0, 1e6) || 0;
      res.setHeader('x-total-count', String(state.parties.length));
      return json(res, 200, state.parties.slice(offset, offset + limit).map(view));
    }
    if (a === 'parties' && !b && req.method === 'POST') {
      const x = await body(req);
      const host = sessionOf(req);
      if (!host) return json(res, 401, { error: 'connect a wallet first' });
      if (!termsOk(host)) return json(res, 403, { error: 'accept the terms first' });
      if (!holders.has(host)) return json(res, 400, { error: 'host must hold at least one Credit' });
      if (state.parties.filter(q => q.hosts[0] === host && ['OPEN', 'FULL'].includes(status(q))).length >= 3) return json(res, 429, { error: 'a host can run at most 3 open parties' });
      const target = cleanTarget(x.target);
      if (!target) return json(res, 400, { error: 'target price is out of range' });
      const days = int(x.days, 1, 60); if (!days) return json(res, 400, { error: 'deadline must be 1–60 days' });
      const minDeposit = int(x.minDeposit, 1, SLOTS); if (!minDeposit) return json(res, 400, { error: 'minimum deposit must be 1–80' });
      const filters = cleanFilters(x.filters);
      const name = String(x.name || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
      const description = String(x.description || '').replace(/\r/g, '').trim().slice(0, 1000);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) + '-' + crypto.randomUUID().slice(0, 8);
      if (x.storeOnly !== true) return json(res, 400, { error: 'confirm that the Statement can only be sold on Statement Maker' });
      const p = { id, name, description, hosts: [host], createdAt: now(), deadline: now() + days * 864e5, params: { voteHours: WINDOWS.includes(Number(x.voteHours)) ? Number(x.voteHours) : 48, minDeposit, target, filters, arrangement: cleanArrangement(x.arrangement), floorMode: FLOOR_MODES.includes(x.floorMode) ? x.floorMode : 'avg24h' }, eligible: eligibleCount(filters), deposits: [], order: null, arranger: null, proposals: [], chat: [] };
      // The host opens the party with their own deposit: at least the minimum, all meeting the party's filters.
      const dep = await checkDeposit(p, host, x.ids);
      if (dep.error) return json(res, dep.code || 400, { error: 'your opening deposit: ' + dep.error });
      dep.ids.forEach(cid => p.deposits.push({ address: host, depositor: host, card: state.nextCard++, id: cid, at: now() }));
      if (p.deposits.length === SLOTS) p.fullAt = now();
      state.parties.unshift(p); save();
      return json(res, 200, view(p));
    }
    const p = a === 'parties' && find(b);
    if (a === 'parties' && !p) return json(res, 404, { error: 'no party' });
    if (p && !c) return json(res, 200, view(p));
    if (p && req.method === 'POST') {
      const x = await body(req);
      const who = sessionOf(req);
      if (!who) return json(res, 401, { error: 'connect a wallet first' });
      if (!termsOk(who)) return json(res, 403, { error: 'accept the terms first' });
      const st = status(p);
      if (c === 'deposit') {
        if (st !== 'OPEN') return json(res, 400, { error: 'party is ' + st });
        if (x.storeOnly !== true) return json(res, 400, { error: 'confirm that the Statement can only be sold on Statement Maker' });
        const dep = await checkDeposit(p, who, x.ids);
        if (dep.error) return json(res, dep.code || 400, { error: dep.error });
        const ids = dep.ids;
        ids.forEach(id => p.deposits.push({ address: who, depositor: who, card: state.nextCard++, id, at: now() }));
        // At 80 the host's default arrangement applies at once; card holders can vote a different one.
        if (p.deposits.length === SLOTS) p.fullAt = now();
        save(); return json(res, 200, view(p));
      }
      if (c === 'withdraw') {
        if (st !== 'OPEN' && st !== 'EXPIRED') return json(res, 400, { error: 'withdrawals are closed once a party is full' });
        // The card's holder withdraws that card's Credit (burning the card), whoever deposited it.
        const only = Array.isArray(x.ids) ? new Set(x.ids.slice(0, SLOTS).map(Number)) : null;
        p.deposits = p.deposits.filter(d => !(d.address === who && (!only || only.has(d.id))));
        save(); return json(res, 200, view(p));
      }
      if (c === 'chat') {
        const isMember = p.deposits.some(d => d.address === who) || p.hosts.includes(who);
        if (!isMember) return json(res, 403, { error: 'only Credit Card holders and hosts can post' });
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
        // Only prices are voted on. Arrangement is a party setting; the host is the only arranger.
        const allowed = st === 'FULL' ? ['LIST'] : ['LIST', 'CANCEL_LISTING'];
        if (!allowed.includes(x.type)) return json(res, 400, { error: `${String(x.type).slice(0, 40)} not allowed while ${st}` });
        if (p.proposals.filter(q => q.by === who && !tally(p, q).closed).length >= 3) return json(res, 429, { error: 'at most 3 open proposals per member' });
        if (x.type !== 'LIST') x.args = {};
        if (x.type === 'LIST') {
          // Any price may be proposed, including below the floor. Only a vote sets it.
          const t = cleanTarget(x.args);
          if (!t) return json(res, 400, { error: 'price is out of range' });
          if (!(priceEth(t, p) > 0)) return json(res, 400, { error: 'that price is at or below 0 ETH' });
          x.args = t;
        }
        const at = now();
        p.proposals.push({ id: p.proposals.length + 1, type: x.type, args: x.args || {}, by: who, at, endsAt: at + windowMs(x.hours, p), override: deadlocked(p, x.type), snapshot: Object.fromEntries(members(p).map(m => [m.address, m.count])), votes: { [who]: true } });
        save(); return json(res, 200, view(p));
      }
      if (c === 'vote') {
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!(prop.snapshot ? prop.snapshot[who] > 0 : p.deposits.some(d => d.address === who))) return json(res, 403, { error: 'only addresses holding Credit Cards when this proposal opened can vote' });
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
        const RUNS_IN = { LIST: ['FULL', 'ASSEMBLED'], CANCEL_LISTING: ['ASSEMBLED'] };
        if (!RUNS_IN[prop.type]?.includes(st)) return json(res, 400, { error: `${prop.type} cannot run while ${st}` });
        prop.executed = true; prop.executedBy = who;
        if (prop.type === 'LIST') p.listing = { ...prop.args, startEth: priceEth(prop.args, p), at: now(), source: 'vote' };
        if (prop.type === 'CANCEL_LISTING') p.listing = null;
        // Executing one proposal supersedes every other pending proposal of the same kind (no stale re-runs).
        for (const q of p.proposals) if (q !== prop && !q.executed && kindOf(q.type) === kindOf(prop.type)) q.superseded = true;
        save(); return json(res, 200, view(p));
      }
      if (c === 'assemble') {
        // One step: the arrangement is fixed and the 80 are burned together. Simulated until the Statement contract is public.
        // Auto arrangement: any card holder may burn; the order comes from the party setting at that moment.
        // Manual arrangement: only a host may burn, sending the hand-made order with the call.
        if (!p.deposits.some(d => d.address === who) && !p.hosts.includes(who)) return json(res, 403, { error: 'members only' });
        if (st !== 'FULL') return json(res, 400, { error: 'party is ' + st });
        let order, source;
        if (p.params.arrangement?.preset === 'Manual') {
          if (!p.hosts.includes(who)) return json(res, 403, { error: 'this party is arranged by hand: only the host can burn it' });
          order = Array.isArray(x.order) ? x.order.slice(0, SLOTS + 1).map(Number) : [];
          if (!validOrder(p, order)) return json(res, 400, { error: 'order must contain each of the 80 Credits once' });
          source = 'Manual';
        } else { order = defaultOrder(p); source = p.params.arrangement?.preset || 'Deposit'; }
        p.order = order; p.orderSource = source;
        p.assembled = { by: who, at: now(), number: state.parties.filter(q => q.assembled).length + 1 };
        // The host's default price goes live at assembly unless card holders already voted a price.
        if (!p.listing) p.listing = { ...p.params.target, startEth: priceEth(p.params.target, p), at: now(), source: 'default' };
        save(); return json(res, 200, view(p));
      }
      if (c === 'return') {
        // After expiry any member may push every Credit back to whoever holds its card.
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        if (st !== 'EXPIRED') return json(res, 400, { error: 'party has not expired' });
        p.returned = { by: who, at: now(), count: p.deposits.length, to: Object.fromEntries(p.deposits.map(d => [d.card, d.address])) };
        p.deposits = [];
        save(); return json(res, 200, view(p));
      }
      if (c === 'transfer') {
        // Credit Cards are ERC-721s: the holder can send one anywhere; the new holder gets its vote, Credit and proceeds.
        const d = p.deposits.find(q => q.card === Number(x.card));
        if (!d) return json(res, 404, { error: 'no such card' });
        if (d.address !== who) return json(res, 403, { error: 'only the holder can send this card' });
        if (d.claimed) return json(res, 400, { error: 'this card was redeemed' });
        const to = addr(x.to);
        if (!isAddr(to) || to === ZERO) return json(res, 400, { error: 'bad recipient' });
        d.address = to; (d.history ||= []).push({ from: who, to, at: now() });
        save(); return json(res, 200, view(p));
      }
      if (c === 'buy') {
        // Simulated sale at the party's approved ask. Royalty is unknown until the Statement contract ships (0 here).
        if (st !== 'ASSEMBLED') return json(res, 400, { error: 'party is ' + st });
        if (!p.listing) return json(res, 400, { error: 'not listed' });
        if (now() < p.listing.at + BUY_DELAY) return json(res, 400, { error: `buying opens ${Math.ceil((p.listing.at + BUY_DELAY - now()) / 36e5)}h after the price went live` });
        const price = priceEth(p.listing, p);
        if (!(price > 0)) return json(res, 400, { error: 'no price available' });
        const royalty = 0, fee = price * 0.01;
        p.sold = { buyer: who, price, royalty, fee, perCard: (price - royalty - fee) / SLOTS, at: now() };
        save(); return json(res, 200, view(p));
      }
      if (c === 'claim') {
        // Proceeds are claimed per card by its current holder; the card is burned on claim.
        if (st !== 'SOLD') return json(res, 400, { error: 'nothing to claim yet' });
        const mine = p.deposits.filter(d => d.address === who && !d.claimed && (!Array.isArray(x.cards) || x.cards.map(Number).includes(d.card)));
        if (!mine.length) return json(res, 400, { error: 'no unclaimed cards held by this wallet' });
        mine.forEach(d => { d.claimed = { to: who, eth: p.sold.perCard, at: now() }; });
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
        if ('arrangement' in q) next.arrangement = cleanArrangement(q.arrangement);
        if ('floorMode' in q) { if (!FLOOR_MODES.includes(q.floorMode)) return json(res, 400, { error: 'floor must be avg24h or latest' }); next.floorMode = q.floorMode; }
        if ('description' in x) p.description = String(x.description || '').replace(/\r/g, '').trim().slice(0, 1000);
        if ('name' in x) p.name = String(x.name || p.name).replace(/\s+/g, ' ').trim().slice(0, 60) || p.name;
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
}

// Buffers a response so a POST's changes are committed before anything is sent; 4xx/5xx roll back.
class Captured {
  constructor() { this.code = 200; this.headers = {}; this.body = ''; }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  writeHead(code, h = {}) { this.code = code; for (const [k, v] of Object.entries(h)) this.setHeader(k, v); }
  end(b = '') { this.body = b; }
  flush(res) { res.writeHead(this.code, this.headers); res.end(this.body); }
}

let ready;
async function init() {
  const st = await store();
  await st.withState(s => als.run(s, () => { migrate(); seedDemo(); }));
}

export async function handle(req, res) {
  try {
    ready ||= init();
    await ready;
    await Promise.all([loadFloors(), loadOwners()]);
    maybeRefreshGas();
    const st = await store();
    if (req.method === 'POST') {
      const cap = new Captured();
      try {
        await st.withState(s => als.run(s, async () => {
          migrate();
          await route(req, cap);
          if (cap.code >= 400) throw Object.assign(new Error('rollback'), { rollback: true });
        }));
      } catch (e) { if (!e.rollback) throw e; }
      return cap.flush(res);
    }
    const s = await st.readState();
    await als.run(s, async () => { migrate(); await route(req, res); });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server error' })); }
  }
}

export const jobs = { refreshFloor, syncTransfers };
export { block };
