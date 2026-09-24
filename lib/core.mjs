// Statement Maker core: request handler + jobs. Runs under the local server (server.mjs) and on Vercel (api/index.mjs).
// No contracts yet: parties live in the store (lib/store.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ART, artAbi } from '../scripts/evm.mjs';
import { store } from './store.mjs';
import { createPublicClient, http as viemHttp, getAddress, parseAbi, keccak256, encodePacked, ContractFunctionRevertedError } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const DEV = process.env.NODE_ENV !== 'production'; // dev clock only outside production
const MAX_BODY = 64 * 1024;
// Build id: changes whenever the served front end changes, so open tabs can notice a deploy and reload.
let BUILD = 'dev';
try { BUILD = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public/app.js'))).update(fs.readFileSync(path.join(ROOT, 'public/style.css'))).update(fs.readFileSync(path.join(ROOT, 'public/wallets.js'))).digest('hex').slice(0, 12); } catch {}
const SLOTS = 80;
const ZERO = '0x0000000000000000000000000000000000000000';
// Launch phase (only the four Minute parties) and full launch have their own terms and rules, each with its own
// version, so acceptances are tracked separately. The Rules agreement lives on the wallet's terms record (rec.rules).
const TERMS_FULL = '2026-09-24.8', TERMS_LAUNCH = '2026-09-24.L9', RULES_FULL = '2026-09-24.9', RULES_LAUNCH = '2026-09-24.L10';
const termsVersion = () => (openingUnlocked() ? TERMS_FULL : TERMS_LAUNCH);
const rulesVersion = () => (openingUnlocked() ? RULES_FULL : RULES_LAUNCH);
const VOTE_WINDOW = 48 * 36e5;
const WINDOWS = [1, 24, 48, 72, 168]; // allowed voting windows, hours
const EXEC_WINDOW = 7 * 864e5;
// Deadlock escape: after 3 NO-blocked proposals of a kind, or 30 days without one executing, 2/3 (54 cards) passes it despite NO.
const DEADLOCK_FAILS = 3, DEADLOCK_DAYS = 30, OVERRIDE = Math.ceil(80 * 2 / 3); // a passed proposal lapses if nobody executes it within 7 days
const windowMs = (h, p) => (WINDOWS.includes(Number(h)) ? Number(h) : (p.params.voteHours || 48)) * 36e5;
// Measured on a mainnet fork, each call as its own transaction (forge --isolate, 2026-09-24 site audit), or estimated;
// used to show costs next to actions. assemble (the burn): paid gas (after refunds), cold, per preset, measured with a mock
// Statement contract (test/gas/Cap.t.sol, Breakdown.t.sol); Jack's real Statement mint is unknown until it is published:
// Deposit/Number/Time 3.95–3.97M, Manual 3.98M, Random 4.04M, Print/Weight/Eights/Ink 4.10–4.12M, Colors 4.11M, Rarity 4.16M.
// withdraw/returnCredit: redeeming one card, 173k–400k (more the earlier its Credit sits in the order). propose 220k,
// vote 71k, claim 83k. deposit: about 190–220k gas per Credit (estimate).
const GAS = { deposit: { min: 190000, max: 220000 }, withdraw: { min: 173000, max: 400000 }, propose: 220000, vote: 71000, execute: 80000, raiseAsk: 90000, assemble: { min: 3_950_000, max: 4_160_000, byPreset: { Deposit: [3_950_000, 3_970_000], Number: [3_950_000, 3_970_000], Time: [3_950_000, 3_970_000], Manual: 3_980_000, Random: 4_040_000, Print: [4_100_000, 4_120_000], Weight: [4_100_000, 4_120_000], Eights: [4_100_000, 4_120_000], Ink: [4_100_000, 4_120_000], Colors: 4_110_000, Rarity: 4_160_000 } }, returnCredit: { min: 173000, max: 400000 }, bid: { min: 60000, max: 100000 }, settle: { min: 150000, max: 250000 }, buy: { min: 150000, max: 250000 }, claim: 83000 };
// Estimates, not measurements (the auction is not in any contract yet, so bid and settle are estimated from the storage
// writes and transfers they need).
const GAS_EST = ['deposit', 'execute', 'raiseAsk', 'bid', 'settle', 'buy'];

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
// ccipRead off: ENS lookups and signature checks never follow an offchain-lookup (EIP-3668) URL a contract hands back,
// so a name or a smart-wallet signature cannot make the server fetch an arbitrary URL.
const chain = createPublicClient({ chain: mainnet, transport: viemHttp(RPC, { timeout: 8_000, retryCount: 1 }), ccipRead: false });
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
    // A cold instance starts at the bundled snapshot block: continue from the saved block instead of re-scanning.
    const saved = await (await store()).ownersBlock();
    if (saved > syncedBlock) syncedBlock = saved;
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
// A revert (a burned or nonexistent Credit) is a real answer: ZERO. Any other failure (network, timeout, rate limit) means
// ownership is unknown, so the whole read fails and callers answer 503 without changing anything.
async function liveOwners(ids) {
  const r = await Promise.all(ids.map(id => chain.readContract({ address: CREDITS, abi: ownerAbi, functionName: 'ownerOf', args: [BigInt(id)] }).then(a => a.toLowerCase(), e => {
    if (e?.walk?.(x => x instanceof ContractFunctionRevertedError)) return ZERO;
    throw e;
  })));
  return new Map(ids.map((id, i) => [id, r[i]]));
}

// ---- ENS: primary names for display, verified by forward resolution; cached in memory and in the store for 24 h ----
const ENS_TTL = 24 * 36e5, ENS_BATCH = 100;
const ensMem = new Map(); // address -> { name, at }
const ensFresh = r => r && Date.now() - r.at < ENS_TTL;
// name, null (no primary name, or it does not resolve back), or undefined (RPC error: not cached).
async function resolveEns(a) {
  try {
    const n = await chain.getEnsName({ address: a });
    if (!n || n.length > 100) return null;
    const back = await chain.getEnsAddress({ name: normalize(n) });
    return back?.toLowerCase() === a ? n : null;
  } catch { return undefined; }
}
async function ensNames(addrs) {
  const out = {}, need = [];
  for (const a of addrs) { const m = ensMem.get(a); if (ensFresh(m)) out[a] = m.name; else need.push(a); }
  if (!need.length) return out;
  const st = await store();
  for (const r of await st.ensGet(need).catch(() => [])) if (ensFresh(r)) { ensMem.set(r.address, { name: r.name, at: r.at }); out[r.address] = r.name; }
  const miss = need.filter(a => !(a in out)), saved = [];
  // Sixteen at a time, and never more than 6 s in all: what is not resolved by then is left out (the client shows the address).
  const work = (async () => {
    for (let i = 0; i < miss.length; i += 16) await Promise.all(miss.slice(i, i + 16).map(async a => {
      const name = await resolveEns(a);
      if (name === undefined) return;
      const r = { address: a, name, at: Date.now() };
      ensMem.set(a, r); saved.push(r); out[a] = name;
    }));
  })();
  await Promise.race([work, new Promise(ok => setTimeout(ok, 6000))]);
  if (ensMem.size > 50_000) ensMem.clear();
  if (saved.length) await st.ensSave(saved.splice(0)).catch(() => {});
  return out;
}
// Forward lookup for profile URLs (#/u/name.eth); null when the name does not resolve, undefined when the lookup failed
// or took longer than 6 s (not cached).
const ensAddrMem = new Map();
async function ensAddress(name) {
  let n; try { n = normalize(name); } catch { return null; }
  const m = ensAddrMem.get(n); if (ensFresh(m)) return m.address;
  const a = await withTimeout(chain.getEnsAddress({ name: n }), 6000).then(x => x?.toLowerCase() || null, () => undefined);
  if (a !== undefined) { ensAddrMem.set(n, { address: a, at: Date.now() }); if (ensAddrMem.size > 10_000) ensAddrMem.clear(); }
  return a;
}
// Addresses the site knows: Credit holders, and anyone in a party (hosts, depositors, card holders, bidders, owners,
// sellers, chat, the log). ENS names are looked up and saved only for these.
function siteAddrs() {
  const s = new Set(), add = a => { if (typeof a === 'string' && isAddr(a)) s.add(a); };
  for (const q of state.parties) {
    q.hosts.forEach(add); add(q.owner); add(q.resale?.seller); add(q.sold?.buyer);
    for (const d of q.deposits) { add(d.address); add(d.depositor); add(d.claimed?.to); }
    for (const b of q.auction?.bids || []) add(b.bidder);
    for (const t of q.trades || []) { add(t.to); add(t.from); }
    for (const m of q.chat || []) add(m.address);
    for (const e of q.history || []) { add(e.a); add(e.to); add(e.from); add(e.by); add(e.winner); for (const it of e.items || []) add(it.to); }
  }
  return s;
}

// ---- sign-in: EIP-4361 message whose statement is the terms acceptance; session cookie after verification ----
// Sessions and sign-in challenges are HMAC-signed values (no server memory); used nonces are recorded in the store.
const SECRET = process.env.SESSION_SECRET || (DEV ? crypto.randomBytes(32).toString('hex') : null);
if (!SECRET) throw new Error('SESSION_SECRET is required in production');
const SESSION_MS = 7 * 864e5;
const mac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => { try { return [k, decodeURIComponent(v.join('='))]; } catch { return [k, '']; } }));
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
const termsStatement = () => `I accept the Statement Maker terms and conditions, version ${termsVersion()}. ${openingUnlocked()
  ? 'I understand that deposits lock at 80, that assembly burns my Credits permanently, that a single no vote can block a sale, and that Credit Cards may be worth nothing.'
  : 'I understand that deposits lock at 80, that the burn destroys my Credits permanently, that the Statement sells only by auction on Statement Maker, and that Credit Cards may be worth nothing.'}`;
function siweMessage(host, origin, address, nonce) {
  return `${host} wants you to sign in with your Ethereum account:\n${address}\n\n${termsStatement()}\n\nURI: ${origin}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
}

// ---- OpenSea listings for the Statement collection (no rake; shown alongside ours, bought on OpenSea) ----
// Needs OPENSEA_API_KEY and STATEMENT_SLUG. Field names are read defensively (snake or camel case).
let osCache = { at: 0, items: [], error: null };
const openseaStatus = () => !process.env.OPENSEA_API_KEY ? 'no api key' : !process.env.STATEMENT_SLUG ? 'collection not known yet' : osCache.error || 'ok';
async function openseaListings() {
  const key = process.env.OPENSEA_API_KEY, slug = process.env.STATEMENT_SLUG;
  if (!key || !slug) return [];
  if (Date.now() - osCache.at < 60_000) return osCache.items;
  osCache.at = Date.now();
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/listings/collection/${encodeURIComponent(slug)}/best?limit=100`, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok) throw new Error((j.errors || [r.status]).join(', '));
    osCache.items = (j.listings || []).map(l => {
      const params = l.protocol_data?.parameters || {};
      const item = (params.offer || [])[0] || {};
      const tokenId = String(item.identifierOrCriteria ?? item.identifier_or_criteria ?? '');
      const cur = l.price?.current || {};
      const priceEth = Number(cur.value) / 10 ** Number(cur.decimals ?? 18);
      const contract = item.token || '';
      return { source: 'opensea', id: l.order_hash, number: tokenId, name: 'Statement ' + tokenId, priceEth, opensAt: 0, seller: params.offerer || '',
        url: contract && tokenId ? `https://opensea.io/assets/ethereum/${contract}/${tokenId}` : `https://opensea.io/collection/${slug}` };
    }).filter(x => x.priceEth > 0);
    osCache.error = null;
  } catch (e) { osCache.error = String(e.message || e).slice(0, 120); }
  return osCache.items;
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
  const r = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, { headers: process.env.OPENSEA_API_KEY ? { 'x-api-key': process.env.OPENSEA_API_KEY } : {}, signal: AbortSignal.timeout(8000) });
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
const FLOOR_STALE_MS = 2 * 36e5; // a latest reading older than this counts as no reading
// Source: the Statement collection's floor when readings exist, otherwise 80 × the Credits floor.
// No usable reading (none at all, none in the last 24 hours, or a latest reading over 2 hours old): nulls, never a throw.
function floorInfo(mode = 'avg24h') {
  const none = source => ({ credit: null, eth: null, hours: 0, samples: 0, mode, source });
  if (!floorHist.length) return none('credits');
  const useStatement = floorHist.at(-1).statement > 0;
  const val = x => (useStatement ? x.statement : x.credit * SLOTS);
  const source = useStatement ? 'statements' : 'credits';
  if (mode === 'latest') { const l = floorHist.at(-1); return Date.now() - l.at > FLOOR_STALE_MS ? none(source) : { credit: l.credit, eth: val(l), hours: 0, samples: 1, at: l.at, mode, source }; }
  const xs = floorHist.filter(x => x.at > Date.now() - 864e5 && (!useStatement || x.statement > 0));
  if (!xs.length) return none(source);
  const eth = xs.reduce((a, x) => a + val(x), 0) / xs.length;
  return { credit: xs.reduce((a, x) => a + x.credit, 0) / xs.length, eth, hours: +((Date.now() - xs[0].at) / 36e5).toFixed(1), samples: xs.length, mode, source };
}
const floorFor = p => floorInfo(p?.params?.floorMode || 'avg24h');
const floor = { get credit() { return floorInfo('avg24h').credit; } };
let gas = { gwei: null, ethUsd: null };
let gasFailAt = 0; // a failed reading is not retried by GET /api/gas for 60 s
async function refreshGas() {
  try {
    const r = await fetch('https://ethereum-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}', signal: AbortSignal.timeout(8000) });
    gas.gwei = parseInt((await r.json()).result, 16) / 1e9;
    const q = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(8000) });
    gas.ethUsd = Number((await q.json()).data.amount);
    if (!(gas.gwei > 0 && gas.ethUsd > 0)) throw new Error('bad reading');
    gasFailAt = 0;
  } catch { gasFailAt = Date.now(); }
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
  // Listings stored before askWei: the ask is the one computed when the price went live (startEth), as Party.ask is fixed then.
  for (const p of state.parties) if (p.assembled && p.listing && p.listing.askWei == null) { const w = decUnits(p.listing.startEth, 18, false); if (w > 0n) p.listing.askWei = w.toString(); }
  // Append-only per-party history (deposits, redemptions, returns, claims); parties stored before it have none.
  for (const p of state.parties) if (!Array.isArray(p.history)) p.history = [];
  for (const p of state.parties) if (p.sold && !p.owner) { p.owner = p.sold.buyer; p.trades ||= [{ kind: 'party', from: p.id, to: p.sold.buyer, price: p.sold.price, at: p.sold.at }]; }
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
  // Exact decimal in (ETH to 1 wei, percent to 1 basis point), checked against the contract's bounds (priceOk).
  const mode = ['fixed', 'floorEth', 'floorPct'].includes(t?.mode) ? t.mode : null;
  if (!mode) return null;
  const v = decUnits(t.value, mode === 'floorPct' ? 2 : 18, true);
  if (v == null || !priceOk(mode, v)) return null;
  return { mode, value: mode === 'floorPct' ? Number(v) / 100 : weiEth(v), units: v.toString() };
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
  // Party: Time == ascending token id (on the sealed collection payment times never decrease with id; checked over all
  // 122,154 Credits), so it is verified as strictly ascending ids.
  Time: cs => [...cs].sort((a, b) => a.id - b.id),
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
  // Default: Time (mint order). 'Manual' means the host orders the 80 by hand in the same step as the burn, and must
  // state at creation the metric they will order by (null here when missing: the caller rejects it).
  const preset = a?.preset === 'Manual' || Object.hasOwn(PRESETS, a?.preset) ? a.preset : 'Time';
  if (preset === 'Manual') { const metric = String(a?.metric || '').replace(/\s+/g, ' ').trim().slice(0, 200); return metric.length >= 3 ? { preset, metric } : null; }
  return preset === 'Random' ? { preset, seed: int(a?.seed, 1, 999999) || 1 + Math.floor(Math.random() * 999999) } : { preset };
}
const defaultOrder = p => { const a = p.params.arrangement || { preset: 'Deposit' }; return (PRESETS[a.preset] || PRESETS.Deposit)(p.deposits.map(d => byId.get(d.id)), a.seed).map(c => c.id); };
// The wait before buying opens is voted with each price (host default at creation, 0-72 hours, 1 by default).
// Party._delayOk: a whole number of hours, 0..72, and at least 1 for a floor-relative price. Invalid values are refused.
const delayOk = (mode, h) => Number.isInteger(h) && h >= 0 && h <= 72 && (mode === 'fixed' || h > 0);
const DELAY_ERR = mode => (mode === 'fixed' ? 'buy wait must be a whole number of hours, 0–72' : 'buy wait must be a whole number of hours, 1–72, for a floor-based price');
// Party.FILL_GRACE: filling always leaves at least 2 days to burn (the deadline moves out if it is sooner).
const FILL_GRACE_MS = 2 * 864e5;
const markFull = p => { p.fullAt = now(); p.deadline = Math.max(p.deadline, now() + FILL_GRACE_MS); };
// Site limits on proposals: 12 per member per party in 24 hours; closed proposals kept per party (see pruneProposals).
const PROPOSALS_PER_DAY = 12, PROPOSALS_KEEP = 200;
const buyableAt = l => l ? (l.buyableAt ?? l.at + 24 * 36e5) : null;
const eligibleCount = f => { let n = 0; for (const c of byId.values()) if (matches(c, f)) n++; return n; };
const isAddr = a => /^0x[0-9a-f]{40}$/.test(a);
// A stored order is valid only if it is exactly the party's current 80 deposits.
const validOrder = (p, order) => Array.isArray(order) && order.length === SLOTS && new Set(order).size === SLOTS && order.every(id => p.deposits.some(d => d.id === id)) && p.deposits.length === SLOTS;
const deposited = p => p.deposits.map(d => d.id);
// Demo parties hold real Credit ids under invented members: they never count as taking a Credit, so real owners can
// always deposit them (e.g. into the Minute house parties). In production demo parties are read-only.
const holding = p => (p.demo ? [] : deposited(p));
const isManual = p => p.params.arrangement?.preset === 'Manual';
// A card holder: holds an unclaimed Credit Card of this party. Hosting alone gives no member rights.
const holdsCardIn = (p, who) => !!who && p.deposits.some(d => d.address === who && !d.claimed);
// Manual parties: if the host has not burned within 1 day of the party (last) filling, any card holder burns in Time order.
const MANUAL_GRACE_MS = 864e5;
const fallbackAt = p => (isManual(p) && status(p) === 'FULL' && p.fullAt ? p.fullAt + MANUAL_GRACE_MS : null);
const members = p => {
  const m = new Map();
  for (const d of p.deposits) m.set(d.address, (m.get(d.address) || 0) + 1);
  return [...m].map(([address, count]) => ({ address, count, host: p.hosts.includes(address) })).sort((a, b) => b.count - a.count);
};
// Append-only party history: { t: 'deposit' | 'redeem' | 'return' | 'claim', ... , at }. Capped per party so the state
// document stays small (deposit/redeem churn could otherwise grow it without bound).
const HISTORY_MAX = 1000;
const logEvent = (p, e) => { (p.history ||= []).push({ ...e, at: now() }); if (p.history.length > HISTORY_MAX) p.history = p.history.slice(-HISTORY_MAX); };
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
  // A price below the floor needs 75% of cards (60 of 80); everything else needs a majority (41). Judged at execution
  // against the current floor reading, in wei (Party.needFor). A price that cannot resolve fails execution (priceError).
  const r = prop.type === 'LIST' ? resolvePrice(prop.args, p) : null;
  const below = !!r?.below, priceError = r?.error || null;
  const need = below ? Math.ceil(SLOTS * 0.75) : Math.floor(SLOTS / 2) + 1;
  const passing = prop.override ? yes >= Math.max(need, OVERRIDE) : yes >= need && no === 0;
  const execBy = endsAt + EXEC_WINDOW;
  const lapsed = closed && passing && !prop.executed && now() > execBy;
  return { yes, no, need: prop.override ? Math.max(need, OVERRIDE) : need, override: !!prop.override, below, passing, endsAt, closed, execBy, lapsed, priceError, executable: closed && passing && !prop.executed && !lapsed && !isSuperseded(p, prop) && !priceError };
}
// Party.priceEpoch: executing any price decision (flagged on the other proposals at execution) and the burn itself
// supersede every proposal made before them.
const isSuperseded = (p, q) => !q.executed && (!!q.superseded || (p.assembled?.at != null && q.at < p.assembled.at));
// Party.lastPriceExecutedAt; null until a price decision executes. Proposals stored before executedAt use their close time.
const lastExecAt = p => p.proposals.reduce((m, q) => (q.executed ? Math.max(m, q.executedAt ?? q.endsAt ?? q.at) : m), 0) || null;
// Party.countBlocked: only a closed, current-epoch price proposal (not a cancel) that reached 41 YES, was stopped by NO,
// and was not itself under the deadlock rule. Anyone may record it; nothing is counted until someone does.
const canCountBlocked = (p, q, t = tally(p, q)) => !q.blockedCounted && q.type === 'LIST' && !q.executed && t.closed && t.no > 0 && !q.override && t.yes >= Math.floor(SLOTS / 2) + 1 && !isSuperseded(p, q);
const countBlocked = (p, q) => (canCountBlocked(p, q) ? ((q.blockedCounted = { at: now() }), true) : false);
// Counted blocks since the last executed price decision (executing one resets Party.blockedPriceProposals; the burn does not).
const blockedCount = p => p.proposals.filter(q => q.blockedCounted && !q.superseded).length;
const kindOf = t => (t === 'CANCEL_LISTING' ? 'LIST' : t);
// Keeps the state document bounded: closed proposals that no rule reads any more are dropped, oldest first, beyond the
// last PROPOSALS_KEEP. Always kept: open ones, executed ones (lastExecAt), counted blocks still in force (blockedCount),
// ones that can still be counted (canCountBlocked), passed ones still inside their execute window, and the burn's
// candidates (burnPrice judges them). The log keeps a record of every proposal.
function pruneProposals(p) {
  const live = (q, t) => !isSuperseded(p, q) && now() <= t.execBy && (q.override ? t.yes >= OVERRIDE : t.no === 0 && t.yes >= Math.floor(SLOTS / 2) + 1);
  const cand = new Set(burnCandidates(p));
  const drop = p.proposals.filter(q => { const t = tally(p, q); return t.closed && !q.executed && !(q.blockedCounted && !q.superseded) && !canCountBlocked(p, q, t) && !live(q, t) && !cand.has(q.id); });
  if (drop.length <= PROPOSALS_KEEP) return;
  const gone = new Set(drop.slice(0, drop.length - PROPOSALS_KEEP));
  p.proposals = p.proposals.filter(q => !gone.has(q));
  p.proposalsPruned = (p.proposalsPruned || 0) + gone.size;
}
function deadlocked(p, type) {
  // Party._deadlocked: 3 counted blocks, or 30 days since the last executed price decision (else the burn, else FULL).
  // One rule for prices and cancels alike (`type` is kept for callers).
  const since = lastExecAt(p) ?? p.assembled?.at ?? p.fullAt;
  return blockedCount(p) >= DEADLOCK_FAILS || (since != null && now() - since > DEADLOCK_DAYS * 864e5);
}
// Party.BURN_CANDIDATES / _passedIds (re-audit M-1): a price proposal that first reaches 41 YES before the burn is recorded
// once (q.candidate), in that order; executing any price decision starts a new epoch and a new list. The burn judges only
// the latest 8 of the current list. Parties stored before the list existed use their current-epoch LISTs at 41+ YES.
const BURN_CANDIDATES = 8, PASS_YES = Math.floor(SLOTS / 2) + 1;
const burnCandidates = p => (p.burnCandidates || p.proposals.filter(q => q.type === 'LIST' && !q.executed && !isSuperseded(p, q) && tally(p, q).yes >= PASS_YES).map(q => q.id)).slice(-BURN_CANDIDATES);
const noteCandidate = (p, q) => { if (p.assembled || q.type !== 'LIST' || q.candidate || q.executed || isSuperseded(p, q) || tally(p, q).yes < PASS_YES) return; q.candidate = true; p.burnCandidates = [...burnCandidates(p).filter(id => id !== q.id), q.id].slice(-BURN_CANDIDATES); };
// The LIST executed while FULL (Party._pendingId): its listing records the proposal; older state finds the last one executed.
const pendingProposal = p => { if (p.assembled || !p.listing || p.listing.source !== 'vote') return null; const id = p.listing.proposal; return (id != null ? p.proposals.find(q => q.id === id) : p.proposals.filter(q => q.type === 'LIST' && q.executed && !q.atBurn).sort((x, y) => (x.executedAt ?? 0) - (y.executedAt ?? 0)).at(-1)) || null; };
// Party._passesHere: whether a LIST passes with its final tally at the current floor reading, as execute() judges it
// (below the floor 60 YES, deadlock rule 54, any NO blocks unless under the deadlock rule). One that cannot pass at any
// floor is { ok: false }; one that needs the reading to be judged and has none is { error: 'floor needed' }.
function passesHere(p, q) {
  const t = tally(p, q);
  if ((t.no > 0 && !q.override) || t.yes < PASS_YES) return { ok: false };
  if (t.priceError) return { error: t.priceError };
  if (t.passing) return { ok: true };
  return floorWeiOf(floorFor(p)) == null ? { error: 'floor needed' } : { ok: false };
}
// The price that goes live at the burn, as Party.assemble picks it (_burnPrice: Pashov H2, re-audit M-1, M-2). Every
// price voted while FULL is judged again at the burn's floor reading with its final tally. First the newest (highest id)
// candidate among the latest 8 that is closed, inside its 7-day execute window, not executed, and passes here (applied as
// if executed); judged newest-recorded first, so a candidate that needs a missing reading refuses the burn ("floor
// needed") before an older one is looked at. Else the price executed while FULL, if it passes here. Else the host
// default. { q, pending, spec, wait } or { error } (a PRICE_ERRORS key). The burn applies at least 1 hour of wait.
function burnPrice(p) {
  const ids = burnCandidates(p);
  let found = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    const q = p.proposals.find(x => x.id === ids[i]);
    if (!q || (found && q.id < found.id) || q.executed) continue;
    const t = tally(p, q);
    if (!t.closed || now() > t.execBy) continue;
    const r = passesHere(p, q);
    if (r.error) return { error: r.error };
    if (r.ok) found = q;
  }
  let pending = false;
  if (!found) { const q = pendingProposal(p); if (q) { const r = passesHere(p, q); if (r.error) return { error: r.error }; if (r.ok) (found = q), (pending = true); } }
  if (found) return { q: found, pending, spec: { ...found.args, source: 'vote', proposal: found.id }, wait: found.args.buyDelayHours ?? 1 };
  const spec = { ...p.params.target, buyDelayHours: p.params.buyDelayHours ?? 1, source: 'default' };
  return { q: null, pending, spec, wait: spec.buyDelayHours };
}
// Party.assemble: every price that goes live at the burn waits at least 1 hour before buying opens (a 0-hour wait → 1).
const burnWaitHours = h => Math.max(1, Number(h) || 0);
// ---- price math in wei: mirrors Party.sol (_checkPrice, _floor, _resolveWith, _clampMin, needFor, execute) ----
// A target keeps `value` (ETH, or percent for floorPct; a Number, for display and for state stored before `units`) and
// `units`: the contract's PriceSpec.value as a decimal integer string (wei for fixed/floorEth, basis points for floorPct).
// All comparisons run on BigInt wei; ETH Numbers/strings are produced only at the display edge. Never put a BigInt in JSON.
const WEI_MAX_PRICE = 10n ** 24n, WEI_MAX_FLOOR = 10n ** 30n, BPS = 10000n, BPS_MAX = 1000000n, WEI_E18 = 10n ** 18n;
const WEI_MIN_ASK = 1n; // the contract's minAskWei; site parties have no host minimum, so 1 wei (never binds)
// Decimal (Number or string: "1.5", "-2", "1e-7") scaled by 10^dec. null when malformed, or (exact) finer than 10^-dec.
const decUnits = (x, dec, exact) => {
  const s = typeof x === 'number' ? (Number.isFinite(x) ? String(x) : '') : typeof x === 'string' && x.length <= 80 ? x : '';
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,3}))?\s*$/i.exec(s);
  if (!m || !(m[2] || m[3])) return null;
  const n = BigInt((m[2] || '') + (m[3] || '') || '0'), shift = dec - (m[3] || '').length + Number(m[4] || 0);
  let v;
  if (shift >= 0) v = n * 10n ** BigInt(shift);
  else { const d = 10n ** BigInt(-shift); if (exact && n % d) return null; v = n / d; }
  return m[1] === '-' ? -v : v;
};
// BigInt wei → exact ETH decimal string, and → Number ETH (display only).
const weiStr = w => { const a = w < 0n ? -w : w, f = (a % WEI_E18).toString().padStart(18, '0').replace(/0+$/, ''); return (w < 0n ? '-' : '') + (a / WEI_E18) + (f ? '.' + f : ''); };
const weiEth = w => (w == null ? null : Number(weiStr(w)));
// Party._checkPrice: Fixed 0 < v <= 1e24 wei; FloorPct -10000 < v <= 1,000,000 bps; FloorDelta |v| <= 1e24 wei.
const priceOk = (mode, v) => mode === 'fixed' ? v > 0n && v <= WEI_MAX_PRICE : mode === 'floorPct' ? v > -BPS && v <= BPS_MAX : v >= -WEI_MAX_PRICE && v <= WEI_MAX_PRICE;
// The contract's PriceSpec.value for a target. State stored before `units` existed derives it from `value`.
const specOf = t => (t?.units != null && /^-?\d{1,80}$/.test(String(t.units)) ? BigInt(t.units) : decUnits(t?.value, t?.mode === 'floorPct' ? 2 : 18, false));
// The floor reading in wei, as the floor signer signs it (ETH rounded to 1e-6). null = no reading.
const floorWeiOf = f => (f?.wei != null ? BigInt(f.wei) : Number.isFinite(f?.eth) ? BigInt(Math.round(f.eth * 1e6)) * 10n ** 12n : null);
const minAskWei = p => (/^\d{1,80}$/.test(String(p?.params?.minAskWei ?? '')) && BigInt(p.params.minAskWei) > 0n ? BigInt(p.params.minAskWei) : WEI_MIN_ASK);
// What Party.execute does with a LIST price and the party's current floor reading.
// { wei, floorWei, below, error }; error is the contract's revert reason: 'price' (out of range), 'no floor reading'
// (floor-relative price, no signed floor), 'floor' (reading 0 or above 1e30 wei).
// A fixed price with no floor reading executes without one and counts as below the floor (60 YES), as on-chain.
// Pashov M3: a floor-relative result <= 0 (floor at or below a floor-minus discount) resolves to 0 and is clamped up to
// the minimum ask (1 wei on the site), so it goes live there and counts as below the floor (60 YES); it never blocks.
function resolvePrice(t, p) {
  const v = specOf(t), f = floorWeiOf(floorFor(p));
  const out = (wei, below, error) => ({ wei, floorWei: f, below, error });
  if (v == null || !['fixed', 'floorPct', 'floorEth'].includes(t?.mode)) return out(null, false, 'price');
  if (t.mode === 'fixed' && f == null) return out(v, true, null);
  if (f == null) return out(null, false, 'no floor reading');
  if (f === 0n || f > WEI_MAX_FLOOR) return out(null, false, 'floor');
  if (t.mode === 'fixed') return out(v, v < f, null);
  const r = t.mode === 'floorPct' ? f * (BPS + v) / BPS : f + v; // BigInt division truncates toward zero, as int256
  const w = r < minAskWei(p) ? minAskWei(p) : r; // _resolveWith (<= 0 → 0) then _clampMin
  return out(w, w < f, null);
}
// Price in wei for display and sale (a fixed price needs no floor); null when it cannot resolve now.
const priceWei = (t, p) => (t?.mode === 'fixed' ? specOf(t) : resolvePrice(t, p).wei);
const priceEth = (t, p) => weiEth(priceWei(t, p));
const PRICE_ERRORS = { price: 'price is out of range', 'no floor reading': 'no floor reading yet', floor: 'the floor reading is out of range', 'floor needed': 'a price voted while full must be judged at the burn’s floor, and there is no floor reading yet' };
// Shown as "below floor" only against an actual reading.
const belowFloor = (t, p) => { const r = resolvePrice(t, p); return r.below && r.floorWei != null; };
const targetEth = p => priceEth(p.params.target, p);
// The live ask (Party.ask): fixed in wei when the price goes live (the burn, or a vote executed after it) and changed only
// by a vote or raiseAsk; it never follows a falling floor. A price voted while FULL has no ask until the burn and
// previews at the current floor.
const listingWei = (l, p) => (l?.askWei != null ? BigInt(l.askWei) : priceWei(l, p));
const listingEth = (l, p) => weiEth(listingWei(l, p));
// A listing as it goes live: the spec plus the ask resolved now (null when it cannot resolve: Party reverts).
const goLive = (t, p, extra = {}) => { const w = priceWei(t, p); return w == null ? null : { ...t, askWei: w.toString(), startEth: weiEth(w), at: now(), ...extra }; };
// ---- end price math
// ---- the four Minute parties sell by English auction (hosted parties keep the fixed ask and price votes) ----
// Reserve: 100 × the Credits floor reading at the burn (the party's floor mode), stored in wei. No timer until the first
// bid; then 24 hours, and a bid in the last 5 minutes moves the end to 5 minutes after that bid (server time). First bid
// >= reserve, each next bid >= high bid + 0.1 ETH. An outbid bidder is refunded (simulated in the preview; recorded in
// the log). After the end anyone settles: the Statement goes to the high bidder and the price splits as a sale. There is
// no end and no fallback before the first bid.
const AUCTION_MS = 24 * 36e5, AUCTION_EXTEND_MS = 5 * 6e4, AUCTION_STEP = 10n ** 17n, AUCTION_FLOOR_X = 100n;
// Largest bid accepted: 10,000 ETH in preview, and never so high that the next bid (+0.1 ETH) would pass the price cap.
const BID_MAX_WEI = (() => { const a = 10_000n * WEI_E18, b = WEI_MAX_PRICE - AUCTION_STEP; return a < b ? a : b; })();
// Opening bid: 100 × the Credits floor reading, rounded to 1e-6 ETH first (as the floor signer signs it), in wei.
const openingWei = cf => (cf > 0 ? BigInt(Math.round(cf * 1e6)) * 10n ** 12n * AUCTION_FLOOR_X : null);
// Sale split as Party.buy: 1% fee, the rest in 80 equal shares, rounding dust to the fee. Wei strings plus ETH for display.
const saleSplit = w => { const feeW = w / 100n, share = (w - feeW) / BigInt(SLOTS), fee = w - share * BigInt(SLOTS);
  return { price: weiEth(w), priceWei: w.toString(), fee: weiEth(fee), feeWei: fee.toString(), perCard: weiEth(share), perCardWei: share.toString(), royalty: 0 }; };
const withTimeout = (pr, ms) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms).unref?.())]);
// The auction has no end until its first bid; then it ends 24 h later (extended by late bids).
const auctionDue = a => (a.endsAt != null ? a.endsAt : Infinity);
const auctionLive = p => !!p.auction && !p.auction.settled;
const highBid = a => a.bids.at(-1) || null;
const minNextWei = a => { const h = highBid(a); return h ? BigInt(h.wei) + AUCTION_STEP : BigInt(a.reserveWei); };
const auctionView = p => {
  const a = p.auction; if (!a) return null;
  const h = highBid(a), t = now();
  return { reserveWei: a.reserveWei, reserveEth: weiEth(BigInt(a.reserveWei)), creditFloorEth: a.creditFloorEth, startAt: a.startAt, endsAt: a.endsAt,
    ended: t >= auctionDue(a), settled: a.settled || null, high: h ? { bidder: h.bidder, eth: h.eth, wei: h.wei, at: h.at } : null,
    minNextWei: minNextWei(a).toString(), minNextEth: weiEth(minNextWei(a)), stepEth: weiEth(AUCTION_STEP), extendMinutes: AUCTION_EXTEND_MS / 6e4,
    bids: [...a.bids].reverse().slice(0, 100).map(b => ({ bidder: b.bidder, eth: b.eth, at: b.at, refunded: b.refunded || null, extended: !!b.extended })) };
};
// Party.raiseAsk: a floor-relative ask may rise to the current floor reading; null when it would not.
const raisedAsk = p => { if (status(p) !== 'ASSEMBLED' || !p.listing || p.listing.mode === 'fixed') return null; const w = priceWei(p.listing, p); return w != null && w > listingWei(p.listing, p) ? w : null; };
function view(full) {
  // History stays server-side: profiles read it (lib/core.mjs users route); party pages do not ship it.
  const { history, ...p } = full;
  // Until the burn, show the order the party's arrangement setting would produce.
  const order = p.order || (p.deposits.length === SLOTS ? defaultOrder(p) : deposited(p));
  return {
    ...p, now: now(), manual: isManual(p), status: status(p), members: members(p), targetEth: targetEth(p), fallbackAt: fallbackAt(p),
    credits: order.map(id => { const d = p.deposits.find(x => x.id === id); return { ...card(byId.get(id), d?.address), card: d?.card, depositorAddr: d?.depositor, claimed: !!d?.claimed }; }),
    perCard: p.sold ? p.sold.perCard : null,
    buyOpensAt: buyableAt(p.listing),
    defaultBelowFloor: belowFloor(p.params.target, p),
    // Before a hosted party's burn: the price the burn would put live now, at the current floor reading (burnPrice), and
    // its wait (at least 1 hour). A price executed while FULL is pending: it goes live only if it still passes at the burn.
    pendingPrice: status(full) === 'FULL' && pendingProposal(full) ? { proposal: pendingProposal(full).id, live: !!burnPrice(full).pending } : null,
    burnPrice: status(full) === 'FULL' && !p.house ? (() => { const bp = burnPrice(full); return bp.error ? { error: PRICE_ERRORS[bp.error] || bp.error } : { source: bp.pending ? 'executed' : bp.q ? 'vote' : 'default', proposal: bp.q?.id ?? null, priceEth: priceEth(bp.spec, full), below: belowFloor(bp.spec, full), waitHours: burnWaitHours(bp.wait) }; })() : null,
    deadlock: { LIST: deadlocked(p, 'LIST'), blocked: blockedCount(p), since: lastExecAt(p) ?? p.assembled?.at ?? p.fullAt ?? null },
    proposals: p.proposals.map(x => { const t = tally(p, x); return { ...x, ...t, superseded: isSuperseded(p, x), countable: canCountBlocked(p, x, t), priceEth: x.type === 'LIST' ? priceEth(x.args, p) : null }; }),
    eligible: full.eligible ?? (full.eligible = eligibleCount(p.params.filters)),
    floorEth: floorFor(p).eth,
    floor: floorFor(p),
    listingEth: p.listing ? listingEth(p.listing, p) : null,
    raiseAskEth: raisedAsk(p) != null ? weiEth(raisedAsk(p)) : null,
    auction: auctionView(p),
    // A Minute party before its burn: the opening bid the server would set now (same rounding as the burn).
    openingNowEth: p.house && !p.assembled ? weiEth(openingWei(floorFor(p).credit)) : null,
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

// ---- the four mint minutes with exactly 80 Credits (found 2026-09-23, confirmed by Jack Butcher 2026-09-24) ----
// Each runs without a host: settings are fixed, the arrangement is Time (a preset), so any card holder can burn at 80.
const MINUTES = [['13:49', 21098], ['15:05', 25998], ['15:28', 27664], ['16:22', 32714]];
// Launch rule: only the four Minute parties exist until one of their Statements has been made and sold at auction (its
// auction settled with a winner); then anyone holding a Credit may start one. The launch rules stay in force through that
// first auction.
const openingUnlocked = () => state.parties.some(q => q.house && q.assembled && q.sold);
const minuteDesc = (t, a) => `The ${SLOTS} Credits bought in the minute of ${t} UTC on September 21, 2026: #${a}–#${a + SLOTS - 1}. One of four minutes of the mint with exactly ${SLOTS}. Only these ${SLOTS} can be deposited. Any card holder can burn once all ${SLOTS} are in.`;
function seedMinutes() {
  for (const [t, a] of MINUTES) {
    const id = 'minute-' + t.replace(':', '');
    const have = state.parties.find(q => q.id === id);
    if (have) {
      if (have.house && !have.deposits.some(d => !d.demo) && have.hosts.length === 0) have.description = have.description.replace(/No host yet: the first depositor becomes the host\.|No host: settings are fixed, and any card holder can burn once all 80 are in\./, `Any card holder can burn once all ${SLOTS} are in.`);
      // The minute is when the 80 were bought in the mint (paidAt), not minted: replace the earlier wording if unchanged.
      if (have.house && have.description === `The ${SLOTS} Credits minted in the minute of ${t} UTC on September 21, 2026: #${a}–#${a + SLOTS - 1}. One of four mint minutes with exactly ${SLOTS}. Only these ${SLOTS} can be deposited. Any card holder can burn once all ${SLOTS} are in.`) have.description = minuteDesc(t, a);
      continue;
    }
    const filters = { idMin: a, idMax: a + SLOTS - 1 };
    state.parties.unshift({
      id, name: `Minute ${t} UTC`, house: true,
      description: minuteDesc(t, a),
      hosts: [], createdAt: now(), deadline: now() + 60 * 864e5,
      params: { buyDelayHours: 1, voteHours: 48, minDeposit: 1, target: cleanTarget({ mode: 'floorPct', value: '0' }), filters, arrangement: { preset: 'Time' }, floorMode: 'avg24h' },
      eligible: eligibleCount(filters), deposits: [], order: null, arranger: null, proposals: [], chat: [],
    });
  }
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
  mg.owner = mg.sold.buyer; mg.trades = [{ kind: 'party', from: mg.id, to: mg.sold.buyer, price: 2.9, at: mg.sold.at }];
  mg.resale = { seller: mg.sold.buyer, priceEth: 3.4, at: T - 864e5 }; // a holder relisting it in the gallery
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
  // The size is checked on the body itself too: a chunked request has no content-length.
  if (req.body !== undefined) {
    try {
      const raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body ?? {}) ?? '';
      if (Buffer.byteLength(raw) > MAX_BODY) return fail(new HttpError(413, 'request too large'));
      const v = typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(raw || '{}');
      return ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    } catch { return fail(new HttpError(400, 'bad json')); }
  }
  let s = '', size = 0;
  req.on('data', d => { size += d.length; if (size > MAX_BODY) { fail(new HttpError(413, 'request too large')); req.destroy(); } else s += d; });
  req.on('end', () => { try { const v = JSON.parse(s || '{}'); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(new HttpError(400, 'bad json')); } });
});
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
// Terms acceptances live in their own table; the request's session address is looked up once per request.
const reqTerms = new AsyncLocalStorage();
const termsOk = a => !!a && reqTerms.getStore()?.address === a && reqTerms.getStore()?.version === termsVersion();
const rulesOk = a => !!a && reqTerms.getStore()?.address === a && reqTerms.getStore()?.rules === rulesVersion();
// A wallet that accepted the launch terms and rules keeps acting on the four Minute parties after the site opens to
// all parties (their auctions can run across the switch); everything else needs the current versions.
const launchOk = a => !!a && reqTerms.getStore()?.address === a && (termsOk(a) || reqTerms.getStore()?.version === TERMS_LAUNCH) && (rulesOk(a) || reqTerms.getStore()?.rules === RULES_LAUNCH);
const termsOkFor = (a, p) => termsOk(a) || (!!p?.house && launchOk(a));
const rulesOkFor = (a, p) => rulesOk(a) || (!!p?.house && launchOk(a));
const RULES_ERR = { error: 'agree to the Rules first (Rules page)', gate: 'rules' };
const find = id => state.parties.find(p => p.id === id);
const addr = a => String(a || '').toLowerCase();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Parties are for Credit holders: a wallet may see and use them if it holds a Credit or a Credit Card.
const holdsCard = who => state.parties.some(q => q.deposits.some(d => d.address === who && !d.claimed));
const canParty = who => !!who && (holders.has(who) || holdsCard(who));
const STORE_ONLY = 'A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. After the sale, the buyer owns it and may resell it anywhere.';

// Shared by party creation and deposits: count, live ownership, not already in a party, meets the party's filters.
// `pre`: ownership read from the chain before the write lock was taken (handle); null when that read failed (503);
// read here only if it is missing. Owners that differ from the snapshot come back as `moves`, applied to the in-memory
// holder map only after the request commits (handle), so a rejected request changes nothing.
// One deposit (or the opening deposit) moves at most 40 Credits: opening with 80 in one transaction measured 14.92M gas,
// too near the 16,777,216 per-transaction cap. The rest goes in a second step. Minimum deposits are capped to match.
const MAX_DEPOSIT_TX = 40;
const DEPOSIT_CAP_ERR = `up to ${MAX_DEPOSIT_TX} Credits per transaction; deposit the rest in a second step`;
async function checkDeposit(p, who, rawIds, pre) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds.slice(0, SLOTS) : []).map(Number))];
  const remaining = SLOTS - p.deposits.length;
  const min = Math.min(p.params.minDeposit, remaining);
  if (ids.length < min) return { error: `minimum deposit is ${min}` };
  if (ids.length > remaining) return { error: `only ${remaining} slots left` };
  if (ids.length > MAX_DEPOSIT_TX) return { error: DEPOSIT_CAP_ERR };
  const known = ids.filter(id => byId.has(id));
  const live = pre === null ? null : pre && known.every(id => pre.has(id)) ? pre : known.length ? await liveOwners(known).catch(() => null) : new Map();
  if (!live) return { error: 'could not read ownership from the chain, try again', code: 503 };
  const moves = known.filter(id => live.has(id) && live.get(id) !== byId.get(id).owner).map(id => [id, live.get(id)]);
  const ownerNow = id => (live.has(id) ? live.get(id) : byId.get(id).owner);
  const taken = new Set(state.parties.flatMap(holding));
  for (const id of ids) {
    const cr = byId.get(id);
    if (!cr || ownerNow(id) !== who) return { error: `#${id} is not held by this wallet`, moves };
    if (taken.has(id)) return { error: `#${id} is already in a party`, moves };
    if (!matches(cr, p.params.filters)) return { error: `#${id} does not meet this party's filters`, moves };
  }
  return { ids, moves };
}

// Open parties a wallet's un-deposited Credits qualify for (respecting the minimum deposit and the slots left).
function fitParties(who) {
  const inParty = new Set(state.parties.flatMap(holding));
  const mine = (holders.get(who) || []).map(id => byId.get(id)).filter(cr => !inParty.has(cr.id));
  const parties = state.parties.filter(q => status(q) === 'OPEN').map(q => {
    const fit = mine.filter(cr => matches(cr, q.params.filters));
    const left = SLOTS - q.deposits.length;
    return { id: q.id, name: q.name, house: !!q.house, filters: q.params.filters, target: q.params.target, filled: q.deposits.length, left, minDeposit: Math.min(q.params.minDeposit, left), fit: fit.length, sample: fit.slice(0, 8).map(cr => cr.id) };
  }).filter(q => q.fit > 0 && q.fit >= q.minDeposit).sort((x, y) => y.fit - x.fit);
  return { mine, parties };
}

// ---- party activity log: recorded events, plus what can be rebuilt from stored state for anything not recorded ----
// Rebuilt entries are deduplicated per object (proposal id, card, voter…), so no cutoff date is needed. Redemptions made
// before recording began left no trace and cannot be rebuilt; vote times were never stored (shown with the proposal time).
function activity(p) {
  const rec = p.history || [];
  const has = (t, f = () => true) => rec.some(e => e.t === t && f(e));
  // The four Minute parties have no opener: their log starts with the first deposit (no 'open' entry, stored or rebuilt).
  const out = rec.filter(e => !(p.house && e.t === 'open')).map(e => ({ ...e }));
  if (!p.house && !has('open')) out.push({ t: 'open', a: p.house ? null : p.hosts[0] || null, house: !!p.house, at: p.createdAt || 0, rebuilt: true });
  const recIds = new Set(rec.filter(e => e.t === 'deposit').flatMap(e => e.ids || []));
  const groups = new Map();
  for (const d of p.deposits) if (!recIds.has(d.id)) { const k = d.depositor + ':' + d.at; (groups.get(k) || groups.set(k, { t: 'deposit', a: d.depositor, ids: [], at: d.at, rebuilt: true }).get(k)).ids.push(d.id); }
  out.push(...groups.values());
  for (const d of p.deposits) for (const h of d.history || []) if (!has('transfer', e => e.card === d.card && e.at === h.at)) out.push({ t: 'transfer', a: h.from, card: d.card, credit: d.id, to: h.to, at: h.at, rebuilt: true });
  for (const q of p.proposals) {
    if (!has('propose', e => e.id === q.id)) out.push({ t: 'propose', a: q.by, id: q.id, type: q.type, args: q.args, priceEth: q.type === 'LIST' ? priceEth(q.args, p) : null, hours: ((q.endsAt || q.at + VOTE_WINDOW) - q.at) / 36e5, override: !!q.override, at: q.at, rebuilt: true });
    for (const [v, yes] of Object.entries(q.votes || {})) if (!has('vote', e => e.id === q.id && e.a === v)) out.push({ t: 'vote', a: v, id: q.id, yes, weight: q.snapshot?.[v] || 0, at: q.at, rebuilt: true, timeUnknown: v !== q.by });
    if (q.blockedCounted && !has('count', e => e.id === q.id)) out.push({ t: 'count', a: q.blockedCounted.by || null, id: q.id, at: q.blockedCounted.at, rebuilt: true });
    if (q.executed && !has('execute', e => e.id === q.id)) out.push({ t: 'execute', a: q.executedBy, id: q.id, type: q.type, at: q.executedAt ?? q.endsAt ?? q.at, rebuilt: true });
  }
  if (p.assembled && !has('assemble')) out.push({ t: 'assemble', a: p.assembled.by, number: p.assembled.number, arrangement: p.orderSource || null, askEth: p.listing?.startEth ?? null, at: p.assembled.at, rebuilt: true });
  if (p.listing?.raisedAt && !has('raise', e => e.at === p.listing.raisedAt)) out.push({ t: 'raise', a: null, askEth: p.listing.startEth, at: p.listing.raisedAt, rebuilt: true });
  if (p.sold && !has('buy') && !has('settle')) out.push({ t: 'buy', a: p.sold.buyer, number: p.assembled?.number, price: p.sold.price, fee: p.sold.fee, at: p.sold.at, rebuilt: true });
  const recCards = new Set(rec.filter(e => e.t === 'claim').flatMap(e => e.cards || []));
  const claims = new Map();
  for (const d of p.deposits) if (d.claimed && !recCards.has(d.card)) { const k = d.claimed.to + ':' + d.claimed.at; const g = claims.get(k) || claims.set(k, { t: 'claim', a: d.claimed.to, cards: [], eth: d.claimed.eth, at: d.claimed.at, rebuilt: true }).get(k); g.cards.push(d.card); }
  out.push(...claims.values());
  if (p.returned && !has('return')) out.push({ t: 'return', a: p.returned.by, count: p.returned.count, at: p.returned.at, rebuilt: true });
  for (const tr of p.trades || []) if (tr.kind === 'holder' && !has('resale', e => e.at === tr.at)) out.push({ t: 'resale', a: tr.to, from: tr.from, number: p.assembled?.number, price: tr.price, fee: tr.fee, at: tr.at, rebuilt: true });
  if (p.resale && !has('list', e => e.at === p.resale.at)) out.push({ t: 'list', a: p.resale.seller, number: p.assembled?.number, priceEth: p.resale.priceEth, at: p.resale.at, rebuilt: true });
  // Newest first; at equal times the causal order (open, deposit, propose, vote…) reads top-down reversed.
  const rank = { open: 0, deposit: 1, params: 2, host: 2, transfer: 3, redeem: 4, propose: 5, vote: 6, count: 7, execute: 8, assemble: 9, raise: 10, bid: 10, refund: 10.2, extend: 10.3, settle: 11, buy: 11, claim: 12, return: 13, list: 14, unlist: 15, resale: 16 };
  return out.sort((x, y) => y.at - x.at || (rank[y.t] ?? 0) - (rank[x.t] ?? 0));
}

// ---- user profiles: a user is a wallet address ----
// Public: Statements it owns (and its holder listings) and the Statements it was part of. Behind the party gate
// (canParty, as /api/wallet): its Credits, Credit Cards, redeemed Credits and the open parties it could join.
const PROFILE_CREDITS = 120, PROFILE_CARDS = 200, PROFILE_ROWS = 100;
const slimStatement = q => ({ id: q.id, name: q.name, demo: !!q.demo, assembled: { number: q.assembled.number, at: q.assembled.at }, status: status(q), owner: q.owner || null,
  sold: q.sold ? { price: q.sold.price, at: q.sold.at } : null, resale: q.resale ? { priceEth: q.resale.priceEth, seller: q.resale.seller, at: q.resale.at } : null,
  listingEth: !q.sold && q.listing ? listingEth(q.listing, q) : null,
  credits: (q.order || deposited(q)).map(id => ({ id, depositor: q.deposits.find(d => d.id === id)?.depositor })) });
function profileCredits(who, offset = 0, limit = PROFILE_CREDITS) {
  const where = new Map();
  for (const q of state.parties) if (!q.demo) for (const d of q.deposits) where.set(d.id, q);
  const list = (holders.get(who) || []).map(id => byId.get(id)).sort((x, y) => x.rank - y.rank);
  return {
    total: list.length, inParties: list.filter(c => where.has(c.id)).length, offset,
    items: list.slice(offset, offset + limit).map(c => { const q = where.get(c.id); return { id: c.id, colors: c.colors, print: c.register || c.print, weight: c.weight, eights: c.eights, rank: c.rank, party: q ? { id: q.id, name: q.name, status: status(q) } : null }; }),
  };
}
const cardState = (q, d) => d.claimed ? 'claimed' : ({ SOLD: 'claimable', ASSEMBLED: 'statement made', FULL: 'locked' }[status(q)] || 'redeemable');
function profile(who, open) {
  const owned = state.parties.filter(q => q.assembled && q.sold && q.owner === who).map(slimStatement);
  const past = [];
  for (const q of state.parties) {
    if (!q.assembled) continue;
    const dep = q.deposits.filter(d => d.depositor === who).length, held = q.deposits.filter(d => d.address === who && !d.claimed); // claimed cards are burned
    const claimed = q.deposits.filter(d => d.claimed?.to === who);
    if (!dep && !held.length && !claimed.length) continue;
    past.push({ id: q.id, name: q.name, demo: !!q.demo, number: q.assembled.number, status: status(q), soldPrice: q.sold?.price ?? null, perCard: q.sold?.perCard ?? null,
      deposited: dep, held: held.length, claimed: claimed.length, claimedEth: claimed.reduce((s, d) => s + (d.claimed.eth || 0), 0), claimable: q.sold ? held.length : 0 });
  }
  past.sort((x, y) => y.number - x.number);
  const out = { address: who, open, statements: owned, past: past.slice(0, PROFILE_ROWS), pastTotal: past.length };
  if (!open) return out;
  const cards = [];
  for (const q of state.parties) for (const d of q.deposits) if (d.address === who) cards.push({ card: d.card, credit: d.id, party: q.id, name: q.name, number: q.assembled?.number ?? null, status: cardState(q, d), perCard: q.sold && !d.claimed ? q.sold.perCard : null });
  const order = { claimable: 0, redeemable: 1, locked: 2, 'statement made': 3, claimed: 4 };
  cards.sort((x, y) => order[x.status] - order[y.status] || y.card - x.card);
  const redeemed = [];
  for (const q of state.parties) for (const e of q.history || []) {
    if (e.t === 'redeem' && e.a === who) for (const id of e.ids || []) redeemed.push({ id, party: q.id, name: q.name, kind: 'redeemed', at: e.at });
    if (e.t === 'return') for (const it of e.items || []) if (it.to === who) redeemed.push({ id: it.id, party: q.id, name: q.name, kind: 'returned', at: e.at });
  }
  redeemed.sort((x, y) => y.at - x.at);
  const { mine, parties } = fitParties(who);
  return { ...out, credits: profileCredits(who), cards: { total: cards.length, items: cards.slice(0, PROFILE_CARDS) }, redeemed: { total: redeemed.length, items: redeemed.slice(0, PROFILE_ROWS) }, couldJoin: { free: mine.length, total: parties.length, parties: parties.slice(0, 24) } };
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  // Vercel rewrites /api/* to /api/index?__path=*; restore the original path.
  if (u.searchParams.has('__path')) {
    const ap = u.searchParams.get('__path');
    if (!/^[a-z0-9_.\/-]{0,200}$/i.test(ap) || ap.includes('..')) return json(res, 404, { error: 'unknown route' });
    u.pathname = '/api/' + ap; u.searchParams.delete('__path');
  }
  if (req.url.startsWith('/api/') && u.pathname.includes('..')) return json(res, 404, { error: 'unknown route' });
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST') {
      // Same-origin POSTs only (with SameSite=Strict cookies this blocks cross-site requests).
      const o = req.headers.origin;
      // An Origin that does not parse (e.g. "null") is treated as cross-origin.
      if (o != null) { let h = null; try { h = new URL(o).host; } catch {} if (!h || h !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' }); }
    }
    if (seg[0] !== 'api') {
      const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
      if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { ...SECURITY, 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
    const [, a, b, c] = seg;
    // Launch phase: everything for after the first Statement's sale is absent, not just hidden (party list and creation, other
    // parties, profiles, Credit lookups, wallet tools, holder lists).
    if (!openingUnlocked() && !DEV && (['wallet', 'users', 'eligible', 'holders'].includes(a) || (a === 'parties' && (!b || !find(b)?.house)))) return json(res, 404, { error: 'unknown route' });
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
        ranges: { id: [1, byId.size], rank: [1, byId.size], marks: MARKS, minDeposit: [1, MAX_DEPOSIT_TX], maxDepositTx: MAX_DEPOSIT_TX, days: [1, 60] },
        dev: DEV, syncedBlock, partiesUnlocked: openingUnlocked(), launchDeadline: state.parties.filter(q => q.house).reduce((m, q) => Math.min(m, q.deadline), Infinity) === Infinity ? null : state.parties.filter(q => q.house).reduce((m, q) => Math.min(m, q.deadline), Infinity), floor: floor.credit, floorLatest: floorInfo('latest').credit, floorAvg: floorInfo('avg24h'), freq: Object.fromEntries(TRAITS.map(k => [k, Object.fromEntries(freq[k])])),
      });
    }
    if (a === 'terms' && req.method === 'GET') return json(res, 200, { version: termsVersion(), accepted: (await (await store()).getTerms(addr(b)))?.version === termsVersion() });
    if (a === 'auth' && b === 'me') { const who = sessionOf(req); return json(res, 200, { address: who, terms: !!who && termsOk(who), rules: rulesOk(who), house: launchOk(who), rulesVersion: rulesVersion(), canParty: canParty(who), storeOnly: STORE_ONLY, version: termsVersion() }); }
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
      if (!/^0x[0-9a-fA-F]{130,4096}$/.test(String(x.signature || ''))) return json(res, 400, { error: 'bad signature' });
      // verifyMessage covers plain wallets and smart-contract wallets (EIP-1271 / 6492).
      const ok = await chain.verifyMessage({ address: n.address, message: n.message, signature: x.signature }).catch(() => false);
      if (!ok) return json(res, 401, { error: 'signature does not match' });
      const who = n.address.toLowerCase();
      const prevV = await (await store()).getTerms(who);
      await (await store()).saveTerms(who, { version: termsVersion(), at: now(), message: n.message, signature: x.signature, ...(prevV?.rules ? { rules: prevV.rules } : {}), ...(prevV?.version && prevV.version !== termsVersion() ? { earlier: [...(prevV.earlier || []), { version: prevV.version, at: prevV.at, message: prevV.message, signature: prevV.signature }].slice(-5) } : prevV?.earlier ? { earlier: prevV.earlier } : {}) });
      startSession(res, who);
      return json(res, 200, { address: who, terms: true });
    }
    if (a === 'rules' && !b && req.method === 'POST') {
      // Records (or withdraws) the signed-in wallet's agreement to the current Rules.
      const x = await body(req), who = sessionOf(req);
      if (!who) return json(res, 401, { error: 'connect a wallet first' });
      if (!termsOk(who)) return json(res, 403, { error: 'accept the terms first' });
      const st = await store(), rec = await st.getTerms(who);
      if (!rec) return json(res, 403, { error: 'accept the terms first' });
      if (x.accept === true) rec.rules = { version: rulesVersion(), at: Date.now() }; else delete rec.rules;
      await st.saveTerms(who, rec);
      return json(res, 200, { rules: x.accept === true, version: rulesVersion() });
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
      const prevD = await (await store()).getTerms(who);
      await (await store()).saveTerms(who, { version: termsVersion(), at: now(), simulated: true, ...(prevD?.rules ? { rules: prevD.rules } : {}), ...(x.rules === true ? { rules: { version: rulesVersion(), at: now() } } : {}) });
      startSession(res, who);
      return json(res, 200, { address: who, terms: true });
    }
    if (a === 'card' && b) {
      const n = Number(String(b).replace(/\.svg$/, ''));
      const p = state.parties.find(q => q.deposits.some(d => d.card === n));
      if (!p) return json(res, 404, { error: 'no card' });
      if (!p.assembled && !canParty(sessionOf(req))) return json(res, 403, { error: 'hold a Credit to use parties', gate: 'credit' });
      res.writeHead(200, { ...SECURITY, 'content-security-policy': 'sandbox', 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
      return res.end(await cardSvg(p, p.deposits.find(d => d.card === n)));
    }
    if (a === 'cards' && b) {
      if (!canParty(sessionOf(req))) return json(res, 403, { error: 'hold a Credit to use parties', gate: 'credit' });
      const who = addr(b);
      const out = [];
      for (const p of state.parties) for (const d of p.deposits) if (d.address === who) out.push({ card: d.card, party: p.id, name: p.name, credit: d.id, status: status(p), claimed: !!d.claimed });
      return json(res, 200, out);
    }
    if (a === 'version') return json(res, 200, { build: BUILD });
    // Public front-end config. WalletConnect stays hidden in the wallet picker until a Reown project id is set.
    if (a === 'config') return json(res, 200, { walletConnectProjectId: /^[0-9a-f]{32}$/i.test(process.env.WALLETCONNECT_PROJECT_ID || process.env.REOWN_PROJECT_ID || '') ? (process.env.WALLETCONNECT_PROJECT_ID || process.env.REOWN_PROJECT_ID) : null });
    if (a === 'ens' && b === 'resolve' && req.method === 'GET') {
      // Forward lookup: GET /api/ens/resolve?name=name.eth → { address } (null when it does not resolve). Public; cached
      // 24 h per name (ensAddress); 30 lookups a minute per client.
      const name = String(u.searchParams.get('name') || '').trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) || name.length > 100) return json(res, 400, { error: 'not an ENS name' });
      if (!rateOk(req, 'ens', 30)) return json(res, 429, { error: 'too many lookups, try again in a minute' });
      const address = await ensAddress(name);
      if (address === undefined) return json(res, 503, { error: 'ENS lookup failed, try again' });
      res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
      return json(res, 200, { name, address });
    }
    if (a === 'ens' && req.method === 'GET') {
      // Batch primary-name lookup for display: GET /api/ens?a=0x…,0x… (at most 100). Public: ENS names are public.
      // Rate-limited, and only for addresses the site knows (others are left out: the client shows the address).
      if (!rateOk(req, 'ensb', 60)) return json(res, 429, { error: 'too many lookups, try again in a minute' });
      const known = siteAddrs();
      const asked = [...new Set(String(u.searchParams.get('a') || '').toLowerCase().split(',').filter(isAddr))].slice(0, ENS_BATCH);
      const list = asked.filter(x => holders.has(x) || known.has(x));
      res.setHeader('cache-control', 'private, max-age=300');
      return json(res, 200, { names: list.length ? await withTimeout(ensNames(list), 7000).catch(() => ({})) : {}, skipped: asked.filter(x => !list.includes(x)) });
    }
    if (DEV && a === 'dev' && b === 'fork' && req.method === 'POST') {
      // Dev only: forwards JSON-RPC to a local Sepolia fork (anvil on :8545) so the Sepolia page can be rehearsed.
      const x = await body(req);
      const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(x) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(await r.text());
    }
    if (a === 'sepolia' && b === 'floor') {
      // Sepolia only: signs the current floor for the test factory so price votes can execute. Needs SEPOLIA_FLOOR_KEY.
      const key = process.env.SEPOLIA_FLOOR_KEY, factoryAddr = process.env.SEPOLIA_FACTORY;
      if (!key || !factoryAddr) return json(res, 404, { error: 'not configured' });
      const mode = u.searchParams.get('mode') === '1' ? 1 : 0;
      const f = floorInfo(mode === 1 ? 'latest' : 'avg24h');
      if (!f.eth) return json(res, 503, { error: 'no floor reading yet' });
      const floorWei = floorWeiOf(f);
      // Dev fork rehearsals may pass the fork's clock (?at=) since the fork's time can run ahead of real time.
      const issuedAt = BigInt((DEV && Number(u.searchParams.get('at'))) || Math.floor(Date.now() / 1000)) - 5n;
      const { privateKeyToAccount } = await import('viem/accounts');
      const sig = await privateKeyToAccount(key).signTypedData({
        domain: { name: 'Statement Maker', version: '1', chainId: 11155111, verifyingContract: factoryAddr },
        types: { Floor: [{ name: 'floorWei', type: 'uint256' }, { name: 'mode', type: 'uint8' }, { name: 'issuedAt', type: 'uint64' }] },
        primaryType: 'Floor', message: { floorWei, mode, issuedAt },
      });
      res.setHeader('cache-control', 'no-store');
      return json(res, 200, { floorWei: floorWei.toString(), issuedAt: issuedAt.toString(), mode, sig });
    }
    if (a === 'gas') {
      // A fresh instance has no reading yet: wait for one (at most 4 s) so the first page load can show dollars.
      if (!(gas.gwei > 0 && gas.ethUsd > 0) && Date.now() - gasFailAt > 60_000) { gasAt = Date.now(); await Promise.race([refreshGas(), new Promise(ok => setTimeout(ok, 4000))]); }
      return json(res, 200, { ...gas, units: GAS, estimated: GAS_EST });
    }
    if (DEV && a === 'dev' && b === 'advance' && req.method === 'POST') {
      const x = await body(req);
      state.clockOffset = (state.clockOffset || 0) + (int(x.hours, 0, 24 * 30) || 0) * 36e5;
      save(); return json(res, 200, { now: now() });
    }
    if (a === 'holders') return json(res, 200, [...holders].sort((x, y) => y[1].length - x[1].length).slice(0, 40).map(([address, ids]) => ({ address, count: ids.length })));
    // Launch phase (public): the four Minute parties, every one of their 320 Credits with its current owner (the snapshot plus
    // the transfer sync), whether it is deposited and who holds its Credit Card. Cells are in Time order (the burn order);
    // after a burn, in the burned order. Addresses are listed once in `addrs`; cells refer to them by index.
    if (a === 'launch' && !b && req.method === 'GET') {
      const addrs = [], ix = new Map();
      const at = x => { if (!x || x === ZERO) return -1; if (!ix.has(x)) { ix.set(x, addrs.length); addrs.push(x); } return ix.get(x); };
      const minutes = MINUTES.map(([t, from]) => {
        const q = find('minute-' + t.replace(':', ''));
        const dep = new Map((q?.deposits || []).map(d => [d.id, d]));
        const order = q?.order || PRESETS.Time(Array.from({ length: SLOTS }, (_, i) => byId.get(from + i)).filter(Boolean)).map(x => x.id);
        const cells = order.map(id => { const d = dep.get(id), o = at(byId.get(id)?.owner); return d ? { id, o, d: true, h: at(d.address) } : { id, o }; });
        return { party: q?.id || null, time: t, from, to: from + SLOTS - 1, status: q ? status(q) : null, filled: dep.size,
          holders: new Set(cells.map(x => (x.d ? x.h : x.o)).filter(i => i >= 0)).size,
          assembled: q?.assembled ? { number: q.assembled.number, at: q.assembled.at } : null,
          auction: q?.auction ? (({ reserveEth, high, endsAt, ended, settled }) => ({ reserveEth, highEth: high?.eth ?? null, endsAt, ended, settled: !!settled }))(auctionView(q)) : null, cells };
      });
      res.setHeader('cache-control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
      return json(res, 200, { unlocked: openingUnlocked(), syncedBlock, addrs, minutes });
    }
    // Gate: parties, party pages (until a Statement is made), wallet tools and eligibility need a Credit or Credit Card.
    // Launch phase: the four Minute party pages are public (reading only; depositing still needs to own the Credit).
    {
      const houseOpen = a === 'parties' && b && !c && req.method === 'GET' && !!find(b)?.house && !openingUnlocked();
      const gated = !houseOpen && ((a === 'wallet') || (a === 'eligible') || (a === 'parties' && !b) || (a === 'parties' && b && !['buy', 'bid', 'settle', 'log', 'claimFor', 'return'].includes(c) && !(find(b)?.assembled && !c && req.method === 'GET')));
      // A party's host passes for that party (a Manual host burns even without holding Credits).
      const sw = sessionOf(req);
      if (gated && !canParty(sw) && !(a === 'parties' && b && sw && find(b)?.hosts.includes(sw))) return json(res, 403, { error: 'hold a Credit to use parties', gate: 'credit' });
      if (gated && !rulesOkFor(sw, a === 'parties' && b ? find(b) : null)) return json(res, 403, RULES_ERR);
    }
    if (a === 'users' && b && req.method === 'GET') {
      let who = addr(b), name = null;
      if (!isAddr(who) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(who) && who.length <= 100) { name = who; who = await ensAddress(who); if (who === undefined) return json(res, 503, { error: 'ENS lookup failed, try again' }); if (!who) return json(res, 404, { error: 'that name does not resolve to an address' }); }
      if (!isAddr(who)) return json(res, 400, { error: 'bad address' });
      const open = canParty(sessionOf(req)) && rulesOk(sessionOf(req));
      if (c === 'credits') {
        if (!open) return json(res, 403, { error: 'hold a Credit to use parties', gate: 'credit' });
        return json(res, 200, profileCredits(who, int(u.searchParams.get('offset'), 0, 1e6) || 0, int(u.searchParams.get('limit'), 1, PROFILE_CREDITS) || PROFILE_CREDITS));
      }
      if (c) return json(res, 404, { error: 'unknown route' });
      return json(res, 200, { ...profile(who, open), name });
    }
    if (a === 'wallet' && c === 'fit') {
      // Starting points for a wallet: open parties its Credits qualify for, and party ideas built from what it holds.
      const who = addr(b);
      const { mine, parties } = fitParties(who);
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
      const inParty = new Set(state.parties.flatMap(holding));
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
    // One feed of everything for sale, same shape for every source: party asks, running auctions, holder listings, OpenSea.
    // An auction's priceEth is its high bid, or its opening bid before the first bid (bid: false; no timer yet).
    if (a === 'market' && req.method === 'GET') {
      const items = [];
      for (const q of state.parties.filter(q => q.assembled)) {
        const v = view(q);
        if (auctionLive(q)) { const av = v.auction; items.push({ source: 'auction', demo: !!q.demo, id: q.id, number: q.assembled.number, name: q.name, priceEth: av.high ? av.high.eth : av.reserveEth, bid: !!av.high, bids: q.auction.bids.length, endsAt: av.endsAt, ended: av.ended, opensAt: q.auction.startAt, seller: 'Auction', minute: q.house ? q.id.replace(/^minute-/, '') : null }); }
        if (!q.sold && q.listing && v.listingEth) items.push({ source: 'party', demo: !!q.demo, id: q.id, number: q.assembled.number, name: q.name, priceEth: v.listingEth, opensAt: v.buyOpensAt, seller: 'Party' });
        if (q.sold && q.resale) items.push({ source: 'holder', demo: !!q.demo, id: q.id, number: q.assembled.number, name: q.name, priceEth: q.resale.priceEth, opensAt: q.resale.at, seller: q.resale.seller });
      }
      for (const o of await openseaListings()) items.push(o);
      items.sort((x, y) => x.priceEth - y.priceEth);
      return json(res, 200, { items, sources: { opensea: openseaStatus() } });
    }
    if (a === 'statements' && b && req.method === 'POST') {
      // Holder listings: the owner of a sold Statement lists it at a fixed price; 1% fee on sale.
      const x = await body(req);
      const who = sessionOf(req);
      if (!who) return json(res, 401, { error: 'connect a wallet first' });
      if (!termsOk(who)) return json(res, 403, { error: 'accept the terms first' });
      if (!rulesOk(who)) return json(res, 403, RULES_ERR);
      const q = find(b);
      if (!q || !q.sold) return json(res, 404, { error: 'no such Statement for sale by a holder' });
      if (q.demo && !DEV) return json(res, 403, { error: 'demo Statement: shown for illustration, no actions' });
      if (c === 'list') {
        if (!openingUnlocked()) return json(res, 403, { error: 'listing is not open' });
        if (q.owner !== who) return json(res, 403, { error: 'only the owner can list it' });
        const priceEth = Number(x.priceEth);
        if (!(priceEth > 0 && priceEth < 1e6)) return json(res, 400, { error: 'price must be above 0 ETH' });
        q.resale = { seller: who, priceEth, at: now() };
        logEvent(q, { t: 'list', a: who, number: q.assembled.number, priceEth });
        save(); return json(res, 200, view(q));
      }
      if (c === 'unlist') {
        if (!q.resale || q.resale.seller !== who) return json(res, 403, { error: 'only the seller can cancel' });
        q.resale = null; logEvent(q, { t: 'unlist', a: who, number: q.assembled.number }); save(); return json(res, 200, view(q));
      }
      if (c === 'buy') {
        if (!q.resale || q.owner !== q.resale.seller) return json(res, 400, { error: 'not for sale' });
        if (who === q.resale.seller) return json(res, 400, { error: 'that is your own listing' });
        if (!(Number(x.maxPriceEth) >= q.resale.priceEth)) return json(res, 400, { error: 'the price changed; review it and try again' });
        const price = q.resale.priceEth;
        q.trades.push({ kind: 'holder', from: q.resale.seller, to: who, price, fee: price * 0.01, at: now() });
        logEvent(q, { t: 'resale', a: who, from: q.resale.seller, number: q.assembled.number, price, fee: price * 0.01 });
        q.owner = who; q.resale = null;
        save(); return json(res, 200, view(q));
      }
      return json(res, 404, { error: 'unknown route' });
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
      if (!rulesOk(host)) return json(res, 403, RULES_ERR);
      if (!openingUnlocked()) return json(res, 403, { error: 'starting a party opens once one of the four Minute Statements has been made and sold at auction', gate: 'launch' });
      if (!holders.has(host)) return json(res, 400, { error: 'host must hold at least one Credit' });
      if (state.parties.filter(q => q.hosts[0] === host && ['OPEN', 'FULL'].includes(status(q))).length >= 3) return json(res, 429, { error: 'a host can run at most 3 open parties' });
      const target = cleanTarget(x.target);
      if (!target) return json(res, 400, { error: 'target price is out of range' });
      const days = int(x.days, 1, 60); if (!days) return json(res, 400, { error: 'deadline must be 1–60 days' });
      const minDeposit = int(x.minDeposit, 1, MAX_DEPOSIT_TX); if (!minDeposit) return json(res, 400, { error: `minimum deposit must be 1–${MAX_DEPOSIT_TX} (one transaction deposits up to ${MAX_DEPOSIT_TX})` });
      const filters = cleanFilters(x.filters);
      const name = String(x.name || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
      const description = String(x.description || '').replace(/\r/g, '').trim().slice(0, 1000);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) + '-' + crypto.randomUUID().slice(0, 8);
      if (x.storeOnly !== true) return json(res, 400, { error: 'confirm that the Statement can only be sold on Statement Maker' });
      const arrangement = cleanArrangement(x.arrangement);
      if (!arrangement) return json(res, 400, { error: 'Manual arrangement: state the metric you will order the 80 by (at least 3 characters)' });
      const buyDelayHours = x.buyDelayHours == null ? 1 : Number(x.buyDelayHours);
      if (!delayOk(target.mode, buyDelayHours)) return json(res, 400, { error: DELAY_ERR(target.mode) });
      const p = { id, name, description, hosts: [host], createdAt: now(), deadline: now() + days * 864e5, params: { buyDelayHours, voteHours: WINDOWS.includes(Number(x.voteHours)) ? Number(x.voteHours) : 48, minDeposit, target, filters, arrangement, floorMode: FLOOR_MODES.includes(x.floorMode) ? x.floorMode : 'avg24h' }, eligible: eligibleCount(filters), deposits: [], order: null, arranger: null, proposals: [], chat: [] };
      // The host opens the party with their own deposit: at least the minimum, all meeting the party's filters.
      const dep = await checkDeposit(p, host, x.ids, req.preOwners);
      req.ownerMoves = dep.moves;
      if (dep.error) return json(res, dep.code || 400, { error: 'your opening deposit: ' + dep.error });
      dep.ids.forEach(cid => p.deposits.push({ address: host, depositor: host, card: state.nextCard++, id: cid, at: now() }));
      logEvent(p, { t: 'open', a: host });
      logEvent(p, { t: 'deposit', a: host, ids: dep.ids });
      if (p.deposits.length === SLOTS) markFull(p);
      state.parties.unshift(p); save();
      return json(res, 200, view(p));
    }
    const p = a === 'parties' && find(b);
    if (a === 'parties' && !p) return json(res, 404, { error: 'no party' });
    if (p && !c) return json(res, 200, view(p));
    if (p && c === 'log' && req.method === 'GET') {
      // Public: the party's activity, newest first, paged (the one exception to the party gate).
      const all = activity(p), limit = int(u.searchParams.get('limit'), 1, 100) || 50, offset = int(u.searchParams.get('offset'), 0, 1e6) || 0;
      return json(res, 200, { total: all.length, offset, items: all.slice(offset, offset + limit) });
    }
    if (p && req.method === 'POST') {
      if (p.demo && !DEV) return json(res, 403, { error: 'demo party: shown for illustration, no actions' });
      const x = await body(req);
      const who = sessionOf(req);
      if (!who) return json(res, 401, { error: 'connect a wallet first' });
      if (!termsOkFor(who, p)) return json(res, 403, { error: 'accept the terms first' });
      if (!rulesOkFor(who, p)) return json(res, 403, RULES_ERR);
      const st = status(p);
      if (c === 'deposit') {
        if (st !== 'OPEN') return json(res, 400, { error: 'party is ' + st });
        if (x.storeOnly !== true) return json(res, 400, { error: 'confirm that the Statement can only be sold on Statement Maker' });
        const dep = await checkDeposit(p, who, x.ids, req.preOwners);
        req.ownerMoves = dep.moves;
        if (dep.error) return json(res, dep.code || 400, { error: dep.error });
        const ids = dep.ids;
        ids.forEach(id => p.deposits.push({ address: who, depositor: who, card: state.nextCard++, id, at: now() }));
        logEvent(p, { t: 'deposit', a: who, ids });
        if (!p.hosts.length && !p.house) p.hosts = [who]; // a party opened without a host: the first depositor hosts it (house parties stay hostless)
        // At 80 the host's default arrangement applies at once; card holders can vote a different one.
        if (p.deposits.length === SLOTS) markFull(p);
        save(); return json(res, 200, view(p));
      }
      if (c === 'withdraw') {
        if (st !== 'OPEN' && st !== 'EXPIRED') return json(res, 400, { error: 'withdrawals are closed once a party is full' });
        // The card's holder withdraws that card's Credit (burning the card), whoever deposited it.
        const only = Array.isArray(x.ids) ? new Set(x.ids.slice(0, SLOTS).map(Number)) : null;
        const out = p.deposits.filter(d => d.address === who && (!only || only.has(d.id)));
        p.deposits = p.deposits.filter(d => !out.includes(d));
        if (out.length) logEvent(p, { t: 'redeem', a: who, ids: out.map(d => d.id), cards: out.map(d => d.card) });
        save(); return json(res, 200, view(p));
      }
      if (c === 'chat') {
        if (!holdsCardIn(p, who)) return json(res, 403, { error: 'only Credit Card holders can post' });
        const text = String(x.text || '').trim().slice(0, 500);
        const last = [...p.chat].reverse().find(m => m.address === who);
        if (last && now() - last.at < 3000) return json(res, 429, { error: 'slow down' });
        if (text) p.chat.push({ address: who, text, at: now() });
        if (p.chat.length > 1000) p.chat = p.chat.slice(-1000);
        save(); return json(res, 200, view(p));
      }
      if (c === 'propose') {
        if (st !== 'FULL' && st !== 'ASSEMBLED') return json(res, 400, { error: 'proposals open once the party is full' });
        if (p.house && (st === 'FULL' || auctionLive(p))) return json(res, 400, { error: 'this party sells by auction: no price votes' });
        // Party.propose (Pashov L4): no proposal in the block that filled slot 80 (block.number <= fullBlock): its vote
        // snapshot (block - 1) would miss the last depositors' cards. Mainnet block timestamps are whole seconds and
        // strictly increase block to block, so "in the fill block" is exactly "at the fill's timestamp": the site refuses
        // a proposal in the same whole second as the fill (its fullAt), the closest its clock comes to a block.
        if (p.fullAt != null && Math.floor(now() / 1000) <= Math.floor(p.fullAt / 1000)) return json(res, 400, { error: 'the party just filled: proposals open from the next block' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'Credit Card holders only' });
        // Only prices are voted on. Arrangement is a party setting; the host is the only arranger.
        const allowed = st === 'FULL' ? ['LIST'] : ['LIST', 'CANCEL_LISTING'];
        if (!allowed.includes(x.type)) return json(res, 400, { error: `${String(x.type).slice(0, 40)} not allowed while ${st}` });
        if (x.type === 'CANCEL_LISTING' && !p.listing) return json(res, 400, { error: 'not listed: there is no listing to cancel' });
        if (p.proposals.filter(q => q.by === who && !tally(p, q).closed).length >= 3) return json(res, 429, { error: 'at most 3 open proposals per member' });
        const at = now(), recent = ((p.proposeTimes ||= {})[who] || []).filter(t => t > at - 864e5);
        if (recent.length >= PROPOSALS_PER_DAY) return json(res, 429, { error: `at most ${PROPOSALS_PER_DAY} proposals per member in 24 hours` });
        if (x.type !== 'LIST') x.args = {};
        if (x.type === 'LIST') {
          // Any price may be proposed, including below the floor. Only a vote sets it.
          const t = cleanTarget(x.args);
          if (!t) return json(res, 400, { error: 'price is out of range' });
          // Like Party.propose: only the range and the buy wait are checked here. A price that needs a floor reading that
          // is missing is accepted and fails at execution; one that resolves to 0 or less goes live at the minimum ask.
          const bd = x.buyDelayHours == null ? (p.params.buyDelayHours ?? 1) : Number(x.buyDelayHours);
          if (!delayOk(t.mode, bd)) return json(res, 400, { error: DELAY_ERR(t.mode) });
          x.args = { ...t, buyDelayHours: bd };
        }
        // Ids stay unique after old proposals are pruned. A vote to cancel the listing always runs 24 hours (Party.propose).
        const pid = Math.max(p.propSeq || 0, 0, ...p.proposals.map(q => q.id)) + 1;
        p.propSeq = pid;
        p.proposeTimes[who] = [...recent, at];
        for (const k of Object.keys(p.proposeTimes)) if (!p.proposeTimes[k].some(t => t > at - 864e5)) delete p.proposeTimes[k];
        p.proposals.push({ id: pid, type: x.type, args: x.args || {}, by: who, at, endsAt: at + (x.type === 'CANCEL_LISTING' ? 24 * 36e5 : windowMs(x.hours, p)), override: deadlocked(p, x.type), snapshot: Object.fromEntries(members(p).map(m => [m.address, m.count])), votes: { [who]: true } });
        const np = p.proposals.at(-1);
        noteCandidate(p, np); // Party._vote: the proposer's own YES may already reach 41
        pruneProposals(p);
        logEvent(p, { t: 'propose', a: who, id: np.id, type: np.type, args: np.args, priceEth: np.type === 'LIST' ? priceEth(np.args, p) : null, hours: (np.endsAt - np.at) / 36e5, override: !!np.override });
        logEvent(p, { t: 'vote', a: who, id: np.id, yes: true, weight: np.snapshot[who] || 0 });
        save(); return json(res, 200, view(p));
      }
      if (c === 'vote') {
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!(prop.snapshot ? prop.snapshot[who] > 0 : p.deposits.some(d => d.address === who))) return json(res, 403, { error: 'only addresses holding Credit Cards when this proposal opened can vote' });
        if (tally(p, prop).closed) return json(res, 400, { error: 'voting has closed' });
        prop.votes[who] = !!x.yes;
        noteCandidate(p, prop); // Party._vote: recorded once when it first reaches 41 YES before the burn
        logEvent(p, { t: 'vote', a: who, id: prop.id, yes: !!x.yes, weight: prop.snapshot?.[who] || 0 });
        save(); return json(res, 200, view(p));
      }
      if (c === 'countBlocked') {
        // Party.countBlocked: anyone records a closed proposal that reached 41 YES and was stopped by NO.
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!countBlocked(p, prop)) return json(res, 400, { error: 'not blocked: only a closed price proposal with 41+ yes stopped by a no counts, once' });
        prop.blockedCounted.by = who;
        logEvent(p, { t: 'count', a: who, id: prop.id });
        save(); return json(res, 200, view(p));
      }
      if (c === 'raiseAsk') {
        // Party.raiseAsk: anyone lifts a floor-relative ask to the current floor reading; it never falls.
        const w = raisedAsk(p);
        if (w == null) return json(res, 400, { error: st !== 'ASSEMBLED' || !p.listing || p.listing.mode === 'fixed' ? 'the ask is fixed' : 'not higher: the ask only rises with the floor' });
        p.listing.askWei = w.toString(); p.listing.startEth = weiEth(w); p.listing.raisedAt = now();
        logEvent(p, { t: 'raise', a: who, askEth: weiEth(w) });
        save(); return json(res, 200, view(p));
      }
      if (c === 'execute') {
        // Any member may execute a proposal once its window has closed with YES > 40 and no NO.
        const prop = p.proposals.find(q => q.id === Number(x.proposal));
        if (!prop) return json(res, 404, { error: 'no proposal' });
        if (!p.deposits.some(d => d.address === who)) return json(res, 403, { error: 'members only' });
        const t = tally(p, prop);
        if (!t.executable) return json(res, 400, { error: prop.executed ? 'already executed' : isSuperseded(p, prop) ? 'superseded by a later decision' : !t.closed ? 'voting is still open' : t.lapsed ? 'lapsed: not executed within 7 days' : t.priceError ? PRICE_ERRORS[t.priceError] : 'did not pass' });
        const RUNS_IN = { LIST: ['FULL', 'ASSEMBLED'], CANCEL_LISTING: ['ASSEMBLED'] };
        if (!RUNS_IN[prop.type]?.includes(st)) return json(res, 400, { error: `${prop.type} cannot run while ${st}` });
        prop.executed = true; prop.executedBy = who; prop.executedAt = now();
        // A price executed while FULL is pending: it goes live at the burn only if it still passes at the burn's floor
        // reading (burnPrice, resolved then); one executed after the burn is live now, its ask
        // fixed at this floor reading. Its own wait applies.
        if (prop.type === 'LIST') p.listing = st === 'ASSEMBLED'
          ? goLive(prop.args, p, { buyableAt: now() + (prop.args.buyDelayHours ?? 1) * 36e5, source: 'vote' })
          : { ...prop.args, startEth: priceEth(prop.args, p), at: now(), buyableAt: null, source: 'vote', proposal: prop.id };
        p.burnCandidates = []; // Party.execute: ++priceEpoch, so the burn's candidate list starts again
        if (prop.type === 'CANCEL_LISTING') p.listing = null;
        logEvent(p, { t: 'execute', a: who, id: prop.id, type: prop.type, askEth: p.listing ? listingEth(p.listing, p) : null });
        // Executing one proposal supersedes every other pending proposal of the same kind (no stale re-runs).
        for (const q of p.proposals) if (q !== prop && !q.executed && kindOf(q.type) === kindOf(prop.type)) q.superseded = true;
        save(); return json(res, 200, view(p));
      }
      if (c === 'assemble') {
        // One step: the arrangement is fixed and the 80 are burned together. Simulated until the Statement contract is public.
        // Auto arrangement: any card holder may burn; the order comes from the party setting at that moment.
        // Manual arrangement: only a host may burn, sending the hand-made order with the call.
        // Presets: once all 80 are in, any card holder burns; the order is the preset's at this moment.
        // Manual: only the host burns, with a hand-made order; 1 day after the party filled, any card holder may burn
        // in Time order instead, so a host cannot stall it.
        if (st !== 'FULL') return json(res, 400, { error: 'party is ' + st });
        let order, source, fallback = false;
        if (isManual(p)) {
          // Party.assemble: within MANUAL_GRACE of filling only the host burns, with any order of the 80. After it the host
          // has no say: any card holder (the host too, only as a holder) burns in Time order.
          const fb = fallbackAt(p);
          if (fb == null || now() <= fb) {
            if (!p.hosts.includes(who)) return json(res, 403, { error: `this party is arranged by hand: only the host can burn it until ${new Date(fb).toISOString().slice(0, 16).replace('T', ' ')} UTC, then any card holder can burn in Time order` });
            order = Array.isArray(x.order) ? x.order.slice(0, SLOTS + 1).map(Number) : [];
            if (!validOrder(p, order)) return json(res, 400, { error: 'order must contain each of the 80 Credits once' });
            source = 'Manual';
          } else {
            if (!holdsCardIn(p, who)) return json(res, 403, { error: 'Credit Card holders only: the host’s 1 day has passed, so any card holder burns in Time order' });
            order = PRESETS.Time(p.deposits.map(d => byId.get(d.id))).map(c => c.id); source = 'Time'; fallback = true;
          }
        } else {
          if (!holdsCardIn(p, who)) return json(res, 403, { error: 'Credit Card holders only' });
          order = defaultOrder(p); source = p.params.arrangement?.preset || 'Deposit';
        }
        // The price that goes live (burnPrice, Party._burnPrice): every price voted while FULL judged again at this floor
        // reading. The newest passing candidate, applied as if executed; else the price executed while FULL if it still
        // passes; else the host default. Its ask is resolved now, at
        // this floor reading, and stays fixed; buying opens at least 1 hour after the burn. A floor-relative price with no
        // floor reading blocks the burn (Party reverts). A Minute party starts its auction instead: reserve = 100 × the
        // Credits floor reading now (no reading, no burn).
        let live = null, auction = null, voted = null;
        if (p.house) {
          const cf = floorFor(p).credit;
          if (!(cf > 0)) return json(res, 400, { error: 'no Credits floor reading yet: the auction reserve cannot be set' });
          const reserve = openingWei(cf);
          auction = { reserveWei: reserve.toString(), creditFloorEth: cf, floorMode: p.params.floorMode || 'avg24h', startAt: now(), endsAt: null, bids: [] };
        } else {
          const bp = burnPrice(p);
          if (bp.error) return json(res, 400, { error: PRICE_ERRORS[bp.error] || 'price cannot resolve' });
          live = goLive(bp.spec, p, { buyableAt: now() + burnWaitHours(bp.wait) * 36e5 });
          if (!live) return json(res, 400, { error: PRICE_ERRORS[resolvePrice(bp.spec, p).error] || 'price cannot resolve' });
          voted = bp.q;
        }
        if (voted && !voted.executed) {
          // Applied as if executed (Party emits Executed): it counts as the last price decision, and every other price
          // proposal is superseded (the counted-block tally resets, as execute does).
          voted.executed = true; voted.executedBy = who; voted.executedAt = now(); voted.atBurn = true;
          for (const q of p.proposals) if (q !== voted && !q.executed && kindOf(q.type) === 'LIST') q.superseded = true;
          logEvent(p, { t: 'execute', a: who, id: voted.id, type: 'LIST', atBurn: true, askEth: live.startEth });
        }
        p.order = order; p.orderSource = source; if (fallback) p.orderFallback = true;
        p.assembled = { by: who, at: now(), number: state.parties.filter(q => q.assembled).length + 1 };
        if (auction) { p.auction = auction; p.listing = null; } else p.listing = live;
        logEvent(p, { t: 'assemble', a: who, number: p.assembled.number, arrangement: source, ...(fallback ? { fallback: true } : {}), askEth: live ? live.startEth : null, ...(auction ? { reserveEth: weiEth(BigInt(auction.reserveWei)) } : {}) });
        save(); return json(res, 200, view(p));
      }
      if (c === 'host') {
        // The host hands hosting to another address (Party.transferHost).
        if (!p.hosts.includes(who)) return json(res, 403, { error: 'hosts only' });
        const to = addr(x.to);
        if (!isAddr(to) || to === ZERO) return json(res, 400, { error: 'bad address' });
        if (to === who) return json(res, 400, { error: 'already the host' });
        p.hosts = [to];
        logEvent(p, { t: 'host', a: who, to });
        save(); return json(res, 200, view(p));
      }
      if (c === 'return') {
        // Party.redeemFor: after expiry anyone may push every Credit back to whoever holds its card.
        if (st !== 'EXPIRED') return json(res, 400, { error: 'party has not expired' });
        p.returned = { by: who, at: now(), count: p.deposits.length, to: Object.fromEntries(p.deposits.map(d => [d.card, d.address])) };
        logEvent(p, { t: 'return', a: who, items: p.deposits.map(d => ({ id: d.id, card: d.card, to: d.address })) });
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
        logEvent(p, { t: 'transfer', a: who, card: d.card, credit: d.id, to });
        save(); return json(res, 200, view(p));
      }
      if (c === 'bid') {
        // English auction bid (Minute parties). Amount in ETH as a decimal string, checked in wei.
        if (!p.auction) return json(res, 400, { error: 'this party is not auctioning' });
        const au = p.auction;
        if (au.settled) return json(res, 400, { error: 'the auction is settled' });
        if (now() >= auctionDue(au)) return json(res, 400, { error: 'the auction has ended' });
        const w = decUnits(typeof x.amount === 'number' ? String(x.amount) : x.amount, 18, true);
        if (w == null || w <= 0n) return json(res, 400, { error: 'bid must be a positive ETH amount, at most 18 decimals' });
        if (w > BID_MAX_WEI) return json(res, 400, { error: `the largest bid accepted is ${weiStr(BID_MAX_WEI).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ETH` });
        const min = minNextWei(au), h = highBid(au);
        if (w < min) return json(res, 400, { error: `${h ? 'minimum bid is the high bid + 0.1 ETH' : 'first bid must meet the reserve'}: ${weiStr(min)} ETH` });
        if (h && h.bidder === who) return json(res, 400, { error: 'you are already the high bidder' });
        // A bid must be backed: the wallet's mainnet ETH balance (read before the write lock, in handle) must cover it.
        if (req.bidBalance == null) return json(res, 503, { error: 'could not read your ETH balance from the chain, try again' });
        if (BigInt(req.bidBalance) < w) return json(res, 400, { error: `this wallet holds ${weiStr(BigInt(req.bidBalance))} ETH on Ethereum, less than the bid` });
        const t = now();
        if (h) { h.refunded = t; logEvent(p, { t: 'refund', a: h.bidder, eth: h.eth }); }
        const bid = { bidder: who, wei: w.toString(), eth: weiEth(w), at: t };
        au.bids.push(bid);
        // The first bid starts the 24-hour timer.
        if (au.endsAt == null) au.endsAt = t + AUCTION_MS;
        logEvent(p, { t: 'bid', a: who, eth: bid.eth, ...(au.bids.length === 1 ? { endsAt: au.endsAt } : {}) });
        if (au.endsAt - t < AUCTION_EXTEND_MS) { au.endsAt = t + AUCTION_EXTEND_MS; bid.extended = true; logEvent(p, { t: 'extend', a: null, endsAt: au.endsAt }); }
        if (au.bids.length > 1000) au.bids = au.bids.slice(-1000);
        save(); return json(res, 200, view(p));
      }
      if (c === 'settle') {
        // Anyone settles after the end: the Statement goes to the high bidder at the high bid. With no bids there is no
        // end (the timer starts at the first bid), so there is nothing to settle.
        if (!p.auction) return json(res, 400, { error: 'this party is not auctioning' });
        const au = p.auction;
        if (au.settled) return json(res, 400, { error: 'already settled' });
        const h = highBid(au);
        if (!h) return json(res, 400, { error: 'no bids yet' });
        if (now() < auctionDue(au)) return json(res, 400, { error: 'the auction has not ended' });
        p.sold = { buyer: h.bidder, ...saleSplit(BigInt(h.wei)), at: now(), auction: true };
        p.owner = h.bidder;
        (p.trades ||= []).push({ kind: 'party', from: p.id, to: h.bidder, price: p.sold.price, at: now() });
        au.settled = { at: now(), by: who, winner: h.bidder, eth: p.sold.price };
        logEvent(p, { t: 'settle', a: who, winner: h.bidder, number: p.assembled.number, price: p.sold.price, fee: p.sold.fee });
        save(); return json(res, 200, view(p));
      }
      if (c === 'buy') {
        if (auctionLive(p)) return json(res, 400, { error: 'this Statement is being auctioned' });
        // Simulated sale at the party's approved ask.
        if (st !== 'ASSEMBLED') return json(res, 400, { error: 'party is ' + st });
        if (!p.listing) return json(res, 400, { error: 'not listed' });
        if (now() < buyableAt(p.listing)) return json(res, 400, { error: `buying opens in ${Math.ceil((buyableAt(p.listing) - now()) / 6e4)} min` });
        const w = listingWei(p.listing, p);
        if (!(w > 0n)) return json(res, 400, { error: 'no price available' });
        // Split in wei (wei strings stored next to ETH Numbers for display).
        p.sold = { buyer: who, ...saleSplit(w), at: now() };
        p.owner = who;
        (p.trades ||= []).push({ kind: 'party', from: p.id, to: who, price: p.sold.price, at: now() });
        logEvent(p, { t: 'buy', a: who, number: p.assembled.number, price: p.sold.price, fee: p.sold.fee });
        save(); return json(res, 200, view(p));
      }
      if (c === 'claim') {
        // Proceeds are claimed per card by its current holder; the card is burned on claim.
        if (st !== 'SOLD') return json(res, 400, { error: 'nothing to claim yet' });
        const pick = Array.isArray(x.cards) ? new Set(x.cards.slice(0, SLOTS).map(Number)) : null;
        const mine = p.deposits.filter(d => d.address === who && !d.claimed && (!pick || pick.has(d.card)));
        if (!mine.length) return json(res, 400, { error: 'no unclaimed cards held by this wallet' });
        mine.forEach(d => { d.claimed = { to: who, eth: p.sold.perCard, ...(p.sold.perCardWei ? { wei: p.sold.perCardWei } : {}), at: now() }; });
        logEvent(p, { t: 'claim', a: who, cards: mine.map(d => d.card), eth: p.sold.perCard });
        save(); return json(res, 200, view(p));
      }
      if (c === 'claimFor') {
        // Party.claimFor: anyone pushes the shares of the given cards (all unclaimed cards when none are given) to each
        // card's current holder. Like the contract, one card that is not an unclaimed card of this party fails the call.
        if (st !== 'SOLD') return json(res, 400, { error: 'nothing to claim yet' });
        const nums = Array.isArray(x.cards) ? [...new Set(x.cards.slice(0, SLOTS).map(Number))] : null;
        const list = nums ? nums.map(n => p.deposits.find(d => d.card === n)) : p.deposits.filter(d => !d.claimed);
        if (!list.length) return json(res, 400, { error: 'no unclaimed cards' });
        if (list.some(d => !d || d.claimed)) return json(res, 400, { error: 'every card must be an unclaimed Credit Card of this party' });
        const t = now(), by = new Map();
        for (const d of list) { d.claimed = { to: d.address, eth: p.sold.perCard, ...(p.sold.perCardWei ? { wei: p.sold.perCardWei } : {}), at: t, by: who }; (by.get(d.address) || by.set(d.address, []).get(d.address)).push(d.card); }
        for (const [holder, cards] of by) logEvent(p, { t: 'claim', a: holder, cards, eth: p.sold.perCard, by: who });
        save(); return json(res, 200, view(p));
      }
      if (c === 'params') {
        if (!p.hosts.includes(who)) return json(res, 403, { error: 'hosts only' });
        if (st !== 'OPEN') return json(res, 400, { error: 'params lock when the party fills' });
        // Depositors accepted these defaults: once anyone but the host has deposited, they can no longer change.
        if (p.deposits.some(d => !p.hosts.includes(d.depositor))) return json(res, 400, { error: 'settings are locked once others have deposited' });
        const q = x.params && typeof x.params === 'object' ? x.params : {};
        const next = { ...p.params };
        if ('minDeposit' in q) { const n = int(q.minDeposit, 1, MAX_DEPOSIT_TX); if (!n) return json(res, 400, { error: `minimum deposit must be 1–${MAX_DEPOSIT_TX} (one transaction deposits up to ${MAX_DEPOSIT_TX})` }); next.minDeposit = n; }
        if ('target' in q) { const t = cleanTarget(q.target); if (!t) return json(res, 400, { error: 'target price is out of range' }); next.target = t; }
        if ('filters' in q) next.filters = cleanFilters(q.filters);
        if ('arrangement' in q) { next.arrangement = cleanArrangement(q.arrangement); if (!next.arrangement) return json(res, 400, { error: 'Manual arrangement: state the metric you will order the 80 by (at least 3 characters)' }); }
        if ('floorMode' in q) { if (!FLOOR_MODES.includes(q.floorMode)) return json(res, 400, { error: 'floor must be avg24h or latest' }); next.floorMode = q.floorMode; }
        if ('description' in x) p.description = String(x.description || '').replace(/\r/g, '').trim().slice(0, 1000);
        if ('name' in x) p.name = String(x.name || p.name).replace(/\s+/g, ' ').trim().slice(0, 60) || p.name;
        if ('voteHours' in q) { if (!WINDOWS.includes(Number(q.voteHours))) return json(res, 400, { error: 'vote window must be 1, 24, 48, 72 or 168 hours' }); next.voteHours = Number(q.voteHours); }
        if (!delayOk(next.target.mode, next.buyDelayHours ?? 1)) return json(res, 400, { error: `a floor-based price needs a buy wait of at least 1 hour (this party's is ${Number(next.buyDelayHours)})` });
        const breaks = p.deposits.filter(d => !matches(byId.get(d.id), next.filters));
        if (breaks.length) return json(res, 400, { error: `would disqualify ${breaks.length} deposited Credit(s)` });
        const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(p.params[k])).concat('name' in x ? ['name'] : [], 'description' in x ? ['description'] : []);
        p.params = next; p.eligible = eligibleCount(next.filters);
        logEvent(p, { t: 'params', a: who, keys: changed });
        save(); return json(res, 200, view(p));
      }
    }
    json(res, 404, { error: 'unknown route' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.code, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'server error' });
  }
}

// The gates route() applies before a deposit or party creation reaches checkDeposit (launch gate, party gate, terms,
// rules, status); used by handle to skip the on-chain ownership read for a request that would be refused anyway.
function depositGatesOk(path, who) {
  const m = /^parties\/([^/]+)\/deposit$/.exec(path);
  if (!m) return termsOk(who) && rulesOk(who) && openingUnlocked() && holders.has(who);
  const p = find(m[1]);
  if (!p || (p.demo && !DEV)) return false;
  if (!openingUnlocked() && !DEV && !p.house) return false;
  if (!canParty(who) && !p.hosts.includes(who)) return false;
  return termsOkFor(who, p) && rulesOkFor(who, p) && status(p) === 'OPEN';
}

// Buffers a response so a POST's changes are committed before anything is sent; 4xx/5xx roll back.
// Sign-in rate limit: 20 requests per minute per client address, per instance.
const hits = new Map();
function rateOk(req, kind = 'auth', max = 20) {
  const ip = kind + ':' + String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const t = Date.now(), h = (hits.get(ip) || []).filter(x => t - x < 60_000);
  h.push(t); hits.set(ip, h);
  if (hits.size > 10_000) hits.clear();
  return h.length <= max;
}

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
  await st.withState(async s => {
    // One-time move of terms records out of the shared state document.
    if (s.terms) { for (const [a, rec] of Object.entries(s.terms)) await st.saveTerms(a, rec); delete s.terms; }
    // Demo parties exist only in local development; production drops any stored ones (they held invented sales).
    als.run(s, () => { migrate(); if (DEV) seedDemo(); else state.parties = state.parties.filter(q => !q.demo); seedMinutes(); });
  });
}

export async function handle(req, res) {
  try {
    ready ||= init();
    await ready;
    await Promise.all([loadFloors(), loadOwners()]);
    maybeRefreshGas();
    const st = await store();
    // Per-request terms for the session address only (terms records are not part of the shared state).
    const who = sessionOf(req);
    const t = who ? await st.getTerms(who) : null;
    const tctx = { address: who, version: t?.version, rules: t?.rules?.version };
    const path = (() => { try { const u = new URL(req.url, 'http://x'); return u.searchParams.get('__path') ?? u.pathname.replace(/^\/api\//, ''); } catch { return ''; } })();
    if (req.method === 'POST' && /^auth\//.test(path) && !rateOk(req)) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"too many sign-in attempts, try again in a minute"}'); }
    // POSTs that never change the shared state run without the global write lock.
    const lockFree = /^(auth\/|eligible$|dev\/fork$|rules$)/.test(path);
    // Deposits check ownership on-chain (up to 80 RPC reads). Read it before taking the write lock so a slow RPC never
    // stalls other writes; checkDeposit re-checks slots, taken Credits, filters and owners inside the lock. The read runs
    // only for a request that passes the route and launch gates first (on an unlocked copy of the state), and is rate-limited.
    if (req.method === 'POST' && who && /^parties(\/[^/]+\/deposit)?$/.test(path)) {
      if (!rateOk(req, 'deposit', 20)) return json(res, 429, { error: 'too many deposits, try again in a minute' });
      try { req.body = await body(req); } catch (e) { if (e instanceof HttpError) return json(res, e.code, { error: e.message }); throw e; }
      const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids.slice(0, SLOTS) : []).map(Number))].filter(id => byId.has(id));
      const s0 = ids.length ? await st.readState() : null;
      const pass = s0 && reqTerms.run(tctx, () => als.run(s0, () => { migrate(); return depositGatesOk(path, who); }));
      if (pass) req.preOwners = await liveOwners(ids).catch(() => null);
    }
    // Bids must be backed by the bidder's ETH balance on mainnet: read it before the write lock (6 s at most).
    if (req.method === 'POST' && who && /^parties\/[^/]+\/bid$/.test(path)) {
      if (!rateOk(req, 'bid', 30)) return json(res, 429, { error: 'too many bids, try again in a minute' });
      req.bidBalance = await withTimeout(chain.getBalance({ address: who }), 6000).then(String, () => null);
    }
    if (req.method === 'POST' && !lockFree) {
      const cap = new Captured();
      try {
        await st.withState(s => reqTerms.run(tctx, () => als.run(s, async () => {
          migrate();
          await route(req, cap);
          if (cap.code >= 400) throw Object.assign(new Error('rollback'), { rollback: true });
        })));
      } catch (e) { if (!e.rollback) throw e; }
      // Chain ownership seen by a deposit reaches the in-memory holder map only once the request has committed.
      if (cap.code < 400) for (const [id, to] of req.ownerMoves || []) moveCredit(id, to);
      return cap.flush(res);
    }
    const s = await st.readState();
    await reqTerms.run(tctx, () => als.run(s, async () => { migrate(); await route(req, res); }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server error' })); }
  }
}

export const jobs = { refreshFloor, syncTransfers };
export { block };
