// Statement Maker — front end. Hash routes, no framework.
import * as Wallets from '/wallets.js';
// All user-supplied strings go through esc() before render().
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const render = (el, s) => el.replaceChildren(document.createRange().createContextualFragment(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => a ? esc(String(a).slice(0, 6) + '…' + String(a).slice(-4)) : '—';
// ENS: every address is drawn as its short form with data-addr; primary names (resolved and verified server-side,
// GET /api/ens) replace the text when they arrive. Rendering never waits for them.
const isAddress = a => /^0x[0-9a-f]{40}$/.test(String(a));
const ensNames = new Map(); // address -> name | null
const ensAsked = new Set();
const nameOf = a => ensNames.get(a) || null;
const nameTag = a => isAddress(a) ? `<span data-addr="${a}">${nameOf(a) ? esc(nameOf(a)) : short(a)}</span>` : short(a);
// Every address shown on the site links to its profile (#/u/<address>).
const userLink = a => !isAddress(a) ? short(a) : launchPhase() ? `<span class="addr" data-addr="${a}">${nameOf(a) ? esc(nameOf(a)) : short(a)}</span>` : `<a class="addr" href="#/u/${a}" data-addr="${a}">${nameOf(a) ? esc(nameOf(a)) : short(a)}</a>`;
function applyNames() {
  document.querySelectorAll('[data-addr]').forEach(el => {
    const n = nameOf(el.dataset.addr);
    const text = (n || short(el.dataset.addr).replace('&hellip;', '…')) + (el.dataset.suffix || '');
    if (n && el.textContent !== text) { el.textContent = text; el.title = el.dataset.addr; }
  });
}
let ensTimer = null;
function queueNames() {
  clearTimeout(ensTimer);
  ensTimer = setTimeout(async () => {
    applyNames();
    const want = [...new Set([...document.querySelectorAll('[data-addr]')].map(el => el.dataset.addr))].filter(a => isAddress(a) && !ensAsked.has(a));
    for (let i = 0; i < want.length; i += 100) {
      const batch = want.slice(i, i + 100);
      batch.forEach(a => ensAsked.add(a));
      try { const r = await api('ens?a=' + batch.join(',')); for (const a of batch) if (a in r.names) ensNames.set(a, r.names[a]); else ensAsked.delete(a); } catch { batch.forEach(a => ensAsked.delete(a)); return; }
      applyNames();
    }
  }, 60);
}
new MutationObserver(queueNames).observe(document.body, { childList: true, subtree: true });
const eth = n => n == null ? '—' : (+n).toFixed(n >= 10 ? 1 : 3) + ' ETH';
// Exact enough for bids: up to 6 decimals, never rounded to 1 like eth() above 10 ETH.
const ethx = n => n == null ? '—' : (+n).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ETH';
const weiDec = w => { w = BigInt(w); const f = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return (w / 10n ** 18n) + (f ? '.' + f : ''); };
const clock = ms => { const t = Math.max(0, Math.floor(ms / 1e3)); return `${Math.floor(t / 3600)}h ${String(Math.floor(t / 60) % 60).padStart(2, '0')}m ${String(t % 60).padStart(2, '0')}s`; };
let auctionTick = null;
const svg = id => `/api/svg/${Number(id)}`;
const hrs = ms => ms <= 0 ? '0h' : ms < 36e5 ? Math.ceil(ms / 6e4) + 'm' : Math.ceil(ms / 36e5) + 'h';
const ago = t => { const s = (Date.now() - t) / 1e3; return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
const SLOTS = 80;
let launchBust = 0; // set by any write from this tab, so the next GET /api/launch skips the 30 s CDN copy
const api = async (path, body) => {
  if (body) launchBust = Date.now();
  const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
let stats = null;
let me = ''; // set from the server session (GET /api/auth/me), never from local state
let access = { canParty: false, storeOnly: '' };
const STORE_ONLY_TEXT = 'A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. After the sale, the buyer owns it and may resell it anywhere.';
const storeBanner = () => `<div class="store-only"><strong>Sold only on Statement Maker.</strong> ${STORE_ONLY_TEXT} Credit Cards can be traded anywhere; the Statement cannot.</div>`;

// ---------- wallet: sign-in with a wallet the user picks (EIP-6963 or WalletConnect); simulated wallets only in dev builds ----------
// The SIWE session must belong to the wallet's active account: switching accounts in the wallet signs out.
const CHAIN = 1;
let chainNow = CHAIN;
const meName = () => nameTag(me);
function fillActing() {
  const b = $('#acting');
  if (!b) return;
  b.textContent = me ? (nameOf(me) || me.slice(0, 6) + '…' + me.slice(-4)) : 'Connect wallet';
  if (me) b.dataset.addr = me; else delete b.dataset.addr; // the ENS name swaps in (queueNames)
  b.title = me ? 'Wallet: switch or disconnect' : 'Connect a wallet';
  b.classList.toggle('alert-m', !!me && chainNow !== CHAIN);
}
async function signOut() { try { await api('auth/logout', {}); } catch {} await setMe(''); }
// Dev builds list simulated wallets (top holders, or a pasted address) under the real ones.
async function devExtra() {
  if (!stats?.dev) return '';
  const top = await api('holders').catch(() => []);
  const seen = new Set();
  const sims = top.filter(o => o.address !== me && !seen.has(o.address) && seen.add(o.address)).slice(0, 12);
  return `<div class="panel" style="margin-top:24px"><h2>Simulated wallets (dev)</h2><div class="chips">${sims.map(o => `<button type="button" data-sim="${esc(o.address)}">${short(o.address)} · ${Number(o.count)}</button>`).join('')}<button type="button" data-sim="__paste">Paste address…</button></div></div>`;
}
async function connectWallet() {
  const extra = await devExtra();
  let sim = '';
  const r = await Wallets.pick({ chainId: CHAIN, title: 'Connect wallet', note: 'Ethereum mainnet · sign in only, no transaction', extra,
    bind: (root, close) => root.querySelectorAll('[data-sim]').forEach(b => b.onclick = () => {
      let v = b.dataset.sim;
      if (v === '__paste') v = (prompt('Wallet address') || '').trim().toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(v)) { sim = v; close(); }
    }) });
  if (sim) return openTermsModal(sim, 'sim');
  if (!r) return;
  if (me && r.account !== me) await signOut();
  if (r.account !== me) openTermsModal(r.account, 'wallet');
}
function walletPanel() {
  const w = Wallets.wallet();
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const ico = w?.icon ? `<img src="${esc(w.icon)}" alt="" width="24" height="24">` : '';
  render(root, `
  <div class="modal-back" id="wb">
   <div class="modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wt">
    <div class="modal-head"><h2 id="wt">Wallet</h2><span class="muted">Signed in</span></div>
    <div class="modal-body"><div class="rows">
     <div><span>Connected</span><strong>${userLink(me)}</strong></div>
     <div><span>Wallet</span><strong class="w-inline">${ico}${w ? esc(w.name) : stats?.dev ? 'Simulated (dev)' : 'Not connected in this tab'}</strong></div>
     ${w && chainNow !== CHAIN ? `<div><span>Network</span><strong class="alert-m">Chain ${Number(chainNow)} · this site reads Ethereum mainnet</strong></div>` : ''}
     <div><span>Parties</span><strong>${access?.canParty ? 'Allowed · holds a Credit or a Credit Card' : 'Holds 0 Credits · parties need a wallet holding a Credit'}</strong></div>
    </div></div>
    <div class="modal-foot"><div class="actions" style="align-items:center"><button class="cta" type="button" id="w-switch">Switch wallet</button><button type="button" id="w-off">Log out</button><button type="button" id="w-close">Close</button></div></div>
   </div>
  </div>`);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  $('#wb').addEventListener('click', e => { if (e.target.id === 'wb') close(); });
  $('#w-close').onclick = close;
  $('#w-switch').onclick = () => { close(); connectWallet(); };
  $('#w-off').onclick = async () => { close(); await Wallets.disconnect(); await signOut(); };
}
$('#acting').addEventListener('click', () => me ? walletPanel() : connectWallet());
// Account switched (or disconnected) inside the wallet: the old session no longer matches, so sign out.
Wallets.on('accounts', async ([a]) => {
  if (!me || a === me) return;
  await signOut();
  if (a) openTermsModal(a, 'wallet');
});
Wallets.on('chain', c => { chainNow = c; fillActing(); });
// A "Switch wallet" button placed anywhere in a page opens the picker.
app.addEventListener('click', e => { if (e.target.closest?.('[data-switch-wallet]')) connectWallet(); });
// View only (no wallet): every action shows this in place of its control.
const connectAct = '<p class="muted">Connect a wallet to act.</p><div class="actions"><button type="button" class="cta" data-switch-wallet style="margin:0">Connect wallet</button></div>';
const VIEW_KEY = 'sm-view-only';
const viewOnly = () => { try { return sessionStorage.getItem(VIEW_KEY) === '1'; } catch { return false; } };
const switchBtn = '<button type="button" class="cta" data-switch-wallet style="margin:0">Switch wallet</button>';
const navProfile = () => { const a = $('#nav-profile'); if (a) a.href = me ? '#/u/' + me : '#/u'; applyNav(); };
async function setMe(v) { me = v; try { const m = await api('auth/me'); access = m; } catch {} await syncRules(); navProfile(); fillActing(); route(); }

// ---------- ordering presets ----------
const COLOR_ORDER = ['C', 'M', 'Y', 'K', 'CM', 'CY', 'MY', 'CK', 'MK', 'YK', 'CMY', 'CMK', 'CYK', 'MYK', 'CMYK'];
const PRINT_ORDER = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHT_ORDER = ['sparse', 'lean', 'even', 'extreme'];
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const PRESETS = {
  Number: cs => [...cs].sort((a, b) => a.id - b.id),
  Time: cs => [...cs].sort((a, b) => a.paidAt - b.paidAt),
  Rarity: cs => [...cs].sort((a, b) => a.rank - b.rank),
  Colors: cs => [...cs].sort((a, b) => COLOR_ORDER.indexOf(a.colors) - COLOR_ORDER.indexOf(b.colors) || a.id - b.id),
  Print: cs => [...cs].sort((a, b) => PRINT_ORDER.indexOf(b.print) - PRINT_ORDER.indexOf(a.print) || a.id - b.id),
  Weight: cs => [...cs].sort((a, b) => WEIGHT_ORDER.indexOf(a.weight) - WEIGHT_ORDER.indexOf(b.weight) || a.marks - b.marks),
  Eights: cs => [...cs].sort((a, b) => b.eights - a.eights || a.id - b.id),
  Ink: cs => [...cs].sort((a, b) => a.marks - b.marks),
  Random: (cs, seed = Date.now() % 1e6) => { const r = rng(seed), o = [...cs]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } o.seed = seed; return o; },
};

// ---------- pieces ----------
function sheet(p, { interactive = false, order = null, selected = null } = {}) {
  const cs = order || p.credits;
  const cells = [];
  for (let i = 0; i < SLOTS; i++) {
    const c = cs[i];
    if (!c) { cells.push(`<span class="empty" aria-hidden="true"></span>`); continue; }
    const mine = me && c.depositor === me ? ' mine' : '';
    cells.push(interactive
      ? `<button type="button" data-i="${i}" data-id="${Number(c.id)}" class="${mine}" aria-pressed="${selected === c.id}" draggable="true" aria-label="Credit ${Number(c.id)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>`
      : `<span class="${mine}"><img src="${svg(c.id)}" alt="" loading="lazy"></span>`);
  }
  return `<div class="frame statement" id="sheet">${cells.join('')}</div>`;
}
const filled = p => `<div class="bar" aria-label="${p.credits.length} of 80"><i style="width:${p.credits.length / SLOTS * 100}%"></i></div>`;
function filterText(f = {}) {
  const parts = [];
  if (f.colors?.length) parts.push('Colors ' + f.colors.join('/'));
  if (f.print?.length) parts.push('Print ' + f.print.join('/'));
  if (f.weight?.length) parts.push('Weight ' + f.weight.join('/'));
  if (f.eights?.length) parts.push('Eights ' + f.eights.join('/'));
  if (f.rankMax) parts.push('Rarity top ' + Number(f.rankMax).toLocaleString());
  if (f.idMin || f.idMax) parts.push(`#${f.idMin || 1}–${f.idMax || '∞'}`);
  if (f.marksMin || f.marksMax) parts.push(`Ink ${f.marksMin || 0}–${f.marksMax || '∞'}`);
  if (f.shiftPlates?.length) parts.push(`${f.shiftOnly ? 'Only' : 'Shifted'} ${f.shiftPlates.join('')}`);
  if (f.shiftMin) parts.push(`Shift ≥ ${f.shiftMin}`);
  return esc(parts.join(' · ') || 'Any Credit');
}
const targetText = t => esc(t.mode === 'fixed' ? `${t.value} ETH` : t.mode === 'floorPct' ? `Floor + ${t.value}%` : `Floor + ${t.value} ETH`);
// Preview of a price at the current floor, in BigInt wei like the server (lib/core.mjs resolvePrice): the floor reading
// rounded to 1e-6 ETH, value as the contract's integer (wei, or basis points), int256-style truncation, 1 wei minimum.
const toUnits = (x, dec) => { const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,3}))?\s*$/i.exec(String(x ?? '')); if (!m || !(m[2] || m[3])) return null; const n = BigInt((m[2] || '') + (m[3] || '') || '0'), sh = dec - (m[3] || '').length + Number(m[4] || 0); const v = sh >= 0 ? n * 10n ** BigInt(sh) : n / 10n ** BigInt(-sh); return m[1] === '-' ? -v : v; };
const weiToEth = w => { const a = w < 0n ? -w : w, f = (a % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return Number((w < 0n ? '-' : '') + (a / 10n ** 18n) + (f ? '.' + f : '')); };
const priceOf = (t, floorEth) => {
  const v = toUnits(t.value, t.mode === 'floorPct' ? 2 : 18);
  if (v == null) return null;
  if (t.mode === 'fixed') return v > 0n ? weiToEth(v) : null;
  if (!Number.isFinite(floorEth) || floorEth <= 0) return null;
  const f = BigInt(Math.round(floorEth * 1e6)) * 10n ** 12n, r = t.mode === 'floorPct' ? f * (10000n + v) / 10000n : f + v;
  return r > 0n ? weiToEth(r) : null;
};
const priceLabel = t => esc(t.mode === 'fixed' ? `${t.value} ETH` : `Floor ${t.value < 0 ? '−' : '+'} ${Math.abs(t.value)}${t.mode === 'floorPct' ? '%' : ' ETH'}`);
const vsFloor = (eth, floorEth) => { if (eth == null || !floorEth) return ''; const d = (eth / floorEth - 1) * 100; return `<span class="${d < 0 ? 'blocked' : 'muted'}">${Math.abs(d).toFixed(0)}% ${d < 0 ? 'below' : 'above'} floor</span>`; };
let gasInfo = null;
const cost = key => { if (!gasInfo?.gwei || !gasInfo.units[key]) return ''; const e = gasInfo.units[key] * gasInfo.gwei / 1e9; return `<span class="faint">~${(gasInfo.units[key] / 1e6 >= 1 ? (gasInfo.units[key] / 1e6).toFixed(1) + 'M' : Math.round(gasInfo.units[key] / 1e3) + 'k')} gas · $${(e * gasInfo.ethUsd).toFixed(2)}</span>`; };
// Burning is the one heavy call: measured 5.8M–10.5M gas by preset (Rarity the most) before the Statement mint itself.
// With a preset known, its own figure; otherwise the range. Dollars from live gwei and ETH/USD (/api/gas) when available.
function burnAlert(preset) {
  const a = gasInfo?.units?.assemble && typeof gasInfo.units.assemble === 'object' ? gasInfo.units.assemble : { min: 5_800_000, max: 10_510_000, byPreset: { Rarity: 10_510_000, default: 6_080_000 } };
  const one = preset && preset !== 'Manual' ? (a.byPreset[preset] ?? a.byPreset.default) : null;
  const g = one ? [one, one] : [a.min, a.max];
  const units = one ? `about ${(one / 1e6).toFixed(1)}M gas` : `about ${Math.round(a.min / 1e6)}–${Math.round(a.max / 1e6)}M gas`;
  const usd = gw => { const [x, y] = g.map(v => '$' + Math.round(v * gw / 1e9 * gasInfo.ethUsd).toLocaleString()); return x === y ? x : `${x}–${y}`; };
  const money = gasInfo?.gwei && gasInfo?.ethUsd ? ` At today’s gas (${gasInfo.gwei.toFixed(1)} gwei) that is about ${usd(gasInfo.gwei)}; at 20 gwei, about ${usd(20)}.` : '';
  return `<span class="alert-c burn-gas">Burning 80 Credits into a Statement is gas-intensive: ${units} plus the Statement mint, paid entirely by whoever burns.${money} Set your wallet’s gas limit high enough (the per-transaction cap is 16.7M).</span>`;
}
const hint = t => `<div class="hint">${esc(t)}</div>`;
const n = x => Number(x).toLocaleString();
const floorNote = f => { if (!f || f.eth == null) return 'no reading yet'; const what = f.source === 'statements' ? 'Statement collection floor' : '80 × Credits floor (until Statements trade)'; return f.mode === 'latest' ? `${what}, latest` : `${what}, averaged over ${f.hours < 23.9 ? f.hours + 'h (building up to 24h)' : '24h'}`; };
const stateTag = s => `<span class="tag">${esc(s)}</span>`;
function matchesClient(c, f = {}) {
  if (f.colors?.length && !f.colors.includes(c.colors)) return false;
  if (f.print?.length && !f.print.includes(c.print)) return false;
  if (f.weight?.length && !f.weight.includes(c.weight)) return false;
  if (f.eights?.length && !f.eights.map(Number).includes(c.eights)) return false;
  if (f.rankMax && c.rank > f.rankMax) return false;
  if (f.idMin && c.id < f.idMin) return false;
  if (f.idMax && c.id > f.idMax) return false;
  if (f.marksMin && c.marks < f.marksMin) return false;
  if (f.marksMax && c.marks > f.marksMax) return false;
  if (f.shiftPlates?.length && !f.shiftPlates.every(pl => (c.shifted || '').includes(pl))) return false;
  if (f.shiftOnly && f.shiftPlates?.length && c.shifted !== 'CMYK'.split('').filter(pl => f.shiftPlates.includes(pl)).join('')) return false;
  if (f.shiftMin && (c.shift || 0) < f.shiftMin) return false;
  return true;
}

// ---------- pages ----------
async function pageParties() {
  const [parties] = await Promise.all([api('parties'), stats || api('stats').then(s => (stats = s))]);
  render(app, `
  <div class="intro"><div><h1>Eighty Credits make a Statement.</h1><p class="muted">Most holders have one. Parties pool them.</p></div><p class="muted">Synced to block ${(stats.syncedBlock || stats.block).toLocaleString()}</p></div>
  <div class="stats">
   <div><strong>${stats.credits.toLocaleString()}</strong><span>Credits</span></div>
   <div><strong>${stats.holders.toLocaleString()}</strong><span>Holders</span></div>
   <div><strong>${stats.soloStatements.toLocaleString()} / ${stats.maxStatements.toLocaleString()}</strong><span>Statements possible without a party</span></div>
   <div><strong>${stats.scattered.toLocaleString()}</strong><span>Credits in wallets under 80</span></div>
  </div>
  <div id="fit"></div>
  <div class="caption"><h2>Parties</h2><a href="#/new">Start a party →</a></div>
  <div class="parties">${parties.map(p => `
   <a class="party-card" href="#/party/${esc(p.id)}">
    ${sheet(p)}
    ${filled(p)}
    <div class="caption"><span><strong>${esc(p.name)}</strong></span><span>${p.credits.length}/80 ${stateTag(p.status)}</span></div>
    ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : ''}
    <div class="muted">${filterText(p.params.filters)} · ${targetText(p.params.target)}${p.demo ? ' · <span class="demo">Demo</span>' : ''}</div>
   </a>`).join('')}</div>`);
  if (me) renderFit();
}
// Two optional starting points once a wallet is connected: join a party that fits, or start one from what you hold.
async function renderFit() {
  const f = await api(`wallet/${me}/fit`);
  const el = $('#fit'); if (!el) return;
  const mini = ids => `<span class="mini">${ids.map(id => `<img src="${svg(id)}" alt="">`).join('')}</span>`;
  render(el, `
  <div class="fit">
   <details>
    <summary><h2><span class="dot y"></span>Parties your Credits fit</h2><span class="muted">${f.parties.length} part${f.parties.length === 1 ? 'y' : 'ies'} · ${f.held} Credits available</span></summary>
    ${f.parties.length ? `<div class="rows">${f.parties.map(q => `<div><span><a href="#/party/${esc(q.id)}">${esc(q.name)}</a> <span class="faint">${q.filled}/80 · min ${q.minDeposit}</span></span><strong>${mini(q.sample)} ${q.fit} qualify · <a href="#/party/${esc(q.id)}">Join →</a></strong></div>`).join('')}</div>`
      : '<p class="muted">No open party accepts your Credits right now.</p>'}
   </details>
   <details>
    <summary><h2>Start a party from your Credits</h2><span class="muted">${f.ideas.length} ideas</span></summary>
    <div class="rows">${f.ideas.map((i, k) => `<div><span>${esc(i.label)} <span class="faint">${n(i.mine)} yours · ${n(i.eligible)} exist</span></span><strong>${mini(i.sample)} <button type="button" data-idea="${k}">Start →</button></strong></div>`).join('')}</div>
   </details>
  </div>`);
  el.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => {
    const i = f.ideas[Number(b.dataset.idea)];
    draft = { name: i.label === 'Any Credit' ? '' : i.label, minDeposit: 1, days: 14, voteHours: 48, arrangement: { preset: 'Time' }, target: { mode: 'floorPct', value: 25 }, filters: { ...i.filters } };
    location.hash = '#/new';
  });
}

// ---------- party activity log (public) ----------
const idList = ids => { const l = (ids || []).map(Number); return l.slice(0, 10).map(i => '#' + i).join(', ') + (l.length > 10 ? ` +${l.length - 10}` : ''); };
const plural = (k, w) => `${Number(k)} ${w}${Number(k) === 1 ? '' : 's'}`;
function logLine(e) {
  const d = {
    open: () => e.house ? 'House party opened by Statement Maker' : 'Opened the party',
    deposit: () => `Deposited ${plural(e.ids?.length, 'Credit')} · ${idList(e.ids)}`,
    redeem: () => `Redeemed ${plural(e.ids?.length, 'Credit')} · ${idList(e.ids)}`,
    return: () => `Returned ${e.items ? e.items.length : Number(e.count)} Credits to their card holders`,
    transfer: () => `Sent Credit Card No. ${Number(e.card)} (Credit #${Number(e.credit)}) to ${userLink(e.to)}`,
    propose: () => e.type === 'LIST' ? `Proposed #${Number(e.id)}: sell for ${priceLabel(e.args || {})} · ${eth(e.priceEth)} · ${Number(e.hours)}h vote${e.args?.buyDelayHours != null ? ` · buy wait ${Number(e.args.buyDelayHours)}h` : ''}${e.override ? ' · deadlock rule' : ''}` : `Proposed #${Number(e.id)}: cancel the listing`,
    vote: () => `Voted ${e.yes ? 'yes' : 'no'} on #${Number(e.id)} · ${plural(e.weight, 'card')}${e.timeUnknown ? ' <span class="faint">· time not recorded</span>' : ''}`,
    count: () => `Counted #${Number(e.id)} as blocked`,
    execute: () => `Executed #${Number(e.id)}${e.askEth != null ? ' · ask ' + eth(e.askEth) : ''}`,
    assemble: () => `Burned the 80 · Statement ${Number(e.number)}${e.arrangement ? ' · ' + esc(e.arrangement === 'Manual' ? 'host’s order' : e.fallback ? 'Time order (host did not burn within 1 day)' : arrLabel({ preset: e.arrangement })) : ''}${e.askEth != null ? ' · ask ' + eth(e.askEth) : ''}${e.reserveEth != null ? ' · auction opening bid ' + ethx(e.reserveEth) : ''}`,
    raise: () => `Raised the ask to ${eth(e.askEth)}`,
    bid: () => `Bid ${ethx(e.eth)}${e.endsAt ? ' · first bid: the 24-hour timer started' : ''}`,
    refund: () => `Outbid: bid of ${ethx(e.eth)} refunded <span class="faint">· simulated</span>`,
    extend: () => `Bid in the last 5 minutes: end moved to ${esc(new Date(e.endsAt).toLocaleString())}`,
    settle: () => e.noBids ? `Closed the auction with no bids · now sells at the reserve, ${ethx(e.askEth)}` : `Settled the auction: Statement ${Number(e.number)} to ${userLink(e.winner)} for ${ethx(e.price)} · fee ${eth(e.fee)}`,
    buy: () => `Bought Statement ${Number(e.number)} for ${eth(e.price)} · fee ${eth(e.fee)}`,
    claim: () => `Claimed ${plural(e.cards?.length, 'card')} · ${eth((e.eth || 0) * (e.cards?.length || 0))}`,
    params: () => `Changed settings${e.keys?.length ? ': ' + esc(e.keys.join(', ')) : ''}`,
    list: () => `Listed Statement ${Number(e.number)} for ${eth(e.priceEth)}`,
    unlist: () => `Cancelled the listing of Statement ${Number(e.number)}`,
    host: () => `Handed hosting to ${userLink(e.to)}`,
    resale: () => `Bought Statement ${Number(e.number)} from ${userLink(e.from)} for ${eth(e.price)}`,
    order: () => `Posted the burn order${e.reviewEnds ? ' · review until ' + esc(new Date(e.reviewEnds).toLocaleString()) : ''}`,
    host: () => `Handed hosting to ${userLink(e.to)}`,
  }[e.t];
  return `<div><span>${e.at ? ago(e.at) + ' ago' : '—'} · ${e.a ? userLink(e.a) : 'Statement Maker'}</span><strong>${d ? d() : esc(e.t)}</strong></div>`;
}
async function logPanel(id, el) {
  let offset = 0;
  const draw = async () => {
    const r = await api(`parties/${encodeURIComponent(id)}/log?offset=${offset}&limit=50`);
    offset += r.items.length;
    const rows = el.querySelector('.rows');
    if (!rows) render(el, `<h2>Log · ${n(r.total)}</h2><p class="muted" style="margin-bottom:10px">Everything that happened in this party, newest first. Public.</p><div class="rows log"></div><div class="actions"><button type="button" class="more" hidden>Show more</button></div>`);
    el.querySelector('.rows').append(document.createRange().createContextualFragment(r.items.map(logLine).join('') || '<div><span>—</span><strong>Nothing yet.</strong></div>'));
    const more = el.querySelector('.more'); more.hidden = offset >= r.total; more.textContent = `Show more · ${n(r.total - offset)} left`; more.onclick = draw;
  };
  try { await draw(); } catch (e) { render(el, `<p class="error">${esc(e.message)}</p>`); }
}

const CARDS_KEY = 'sm-cards-open-';
const cardsOpen = id => { try { return localStorage.getItem(CARDS_KEY + id) === '1'; } catch { return false; } };
const setCardsOpen = (id, on) => { try { localStorage.setItem(CARDS_KEY + id, on ? '1' : '0'); } catch {} };
const freshUI = () => ({ mode: 'sheet', selected: null, order: null, preset: null, picks: new Set() });
let partyUI = freshUI();
// opts.root: render only the party's panels into that element (the Minute page embeds them under its own grid),
// leaving out the sheet, the deposit panel, the card holders table and the log, which the Minute page draws itself.
async function pageParty(id, opts = {}) {
  const root = opts.root || app, embed = !!opts.root;
  const p = await api('parties/' + encodeURIComponent(id));
  const isHost = p.hosts.includes(me), isMember = p.members.some(m => m.address === me);
  const canHandArrange = p.manual && isHost && p.status === 'FULL';
  const holder = !!me && p.credits.some(c => c.depositor === me && !c.claimed); // holds an unclaimed card of this party
  const fallbackOpen = p.manual && p.fallbackAt != null && p.now >= p.fallbackAt;
  const myTokens = p.members.find(m => m.address === me)?.count || 0;
  const myCards = me ? p.credits.filter(c => c.depositor === me).sort((a, b) => a.card - b.card) : [];
  const order = partyUI.mode === 'arrange' && partyUI.order ? partyUI.order : p.credits;
  const sel = order.find(c => c.id === partyUI.selected) || null;
  const wallet = !embed && me && p.status === 'OPEN' ? await api('wallet/' + me) : [];
  const remaining = SLOTS - p.credits.length, minDep = Math.min(p.params.minDeposit, remaining);
  const eligibleMine = wallet.filter(c => !c.deposited && matchesClient(c, p.params.filters));
  const liveCards = myCards.filter(c => !c.claimed);
  const pickList = [...eligibleMine, ...wallet.filter(c => !eligibleMine.includes(c))];
  const au = p.auction, auctionOn = !!p.house && (p.status === 'FULL' || (!!au && !au.settled));

  render(root, `
  ${embed ? '' : `<div class="intro"><div><h1>${esc(p.name)}</h1>${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}<p class="muted">${p.status === 'OPEN' ? `${remaining} slots open · closes in ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 864e5))} days` : p.status === 'FULL' ? (p.manual ? (fallbackOpen ? 'Full · host did not burn in time: any card holder can burn in Time order' : 'Full · host arranging by hand') : 'Full · any card holder can burn') : esc(p.status)}${p.demo ? ' · <span class="demo">Demo data</span>' : ''}</p></div><div style="text-align:right"><a href="#/" class="muted">← All parties</a>${stats?.dev ? `<div><button type="button" id="skip" class="faint" title="Prototype only: move the clock forward">Dev · skip 24h</button></div>` : ''}</div></div>
  ${storeBanner()}`}
  <div class="works${embed ? ' embed' : ''}">
   ${embed ? '' : `<section aria-label="Statement">
    ${sheet(p, { interactive: true, order, selected: partyUI.selected })}
    <div class="caption">
     <span>${partyUI.mode === 'arrange' ? 'Arranging' + (partyUI.preset ? ' · ' + esc(partyUI.preset) : '') : 'Statement'} · ${p.credits.length}/80</span>
     <div class="modes">
      <button type="button" data-mode="sheet" aria-pressed="${partyUI.mode === 'sheet'}">Sheet</button>
      ${canHandArrange ? `<button type="button" data-mode="arrange" aria-pressed="${partyUI.mode === 'arrange'}">Arrange</button>` : ''}
     </div>
    </div>
    ${partyUI.mode === 'arrange' && canHandArrange ? `
     <div class="panel">
      <p class="alert-c">Manual arrangement. Start from an auto-order if you like, then drag to swap. The order is fixed at the moment you burn.</p>
      <div class="modes" style="margin:10px 0">${Object.keys(PRESETS).map(k => `<button type="button" data-preset="${k}" aria-pressed="${(partyUI.preset || '').startsWith(k)}">${k}</button>`).join('')}</div>
     </div>` : ''}
    <div class="detail">${sel ? `<img src="${svg(sel.id)}" alt="Credit ${Number(sel.id)}"><div class="rows">
      <div><span>Credit</span><strong>#${Number(sel.id)}</strong></div>
      <div><span>Colors · Print</span><strong>${esc(sel.colors)} · ${esc(sel.register || sel.print)}</strong></div>
      <div><span>Weight · Eights</span><strong>${esc(sel.weight)} · ${Number(sel.eights)} (${esc(sel.tier)})</strong></div>
      <div><span>Rarity · Depositor</span><strong>#${sel.rank.toLocaleString()} · ${userLink(sel.depositor)}</strong></div></div>`
      : `<span class="faint">—</span><span class="muted">Select a Credit on the sheet.</span>`}</div>
   </section>`}

   <section>
    <div class="panel">
     <h2>Party</h2>
     <div class="rows">
      <div><span>Status</span><strong>${esc(p.status)}</strong></div>
      <div><span>Filled</span><strong>${p.credits.length} / 80</strong></div>
      <div style="border:0;padding:0">${filled(p)}</div>
      <div><span>Hosts</span><strong>${p.hosts.length ? p.hosts.map(h => userLink(h)).join(', ') : (p.house ? 'None: settings fixed' : 'None yet: the first depositor hosts')}</strong></div>
      <div><span>Eligible Credits</span><strong>${filterText(p.params.filters)} · ${p.eligible.toLocaleString()}</strong></div>
      <div><span>Vote window</span><strong>${Number(p.params.voteHours || 48)} hours default</strong></div>
      <div><span>Buy wait</span><strong>${Number(p.params.buyDelayHours ?? 1)} hour${(p.params.buyDelayHours ?? 1) === 1 ? '' : 's'} default</strong></div>
      <div><span>Minimum deposit</span><strong>${Number(p.params.minDeposit)}</strong></div>
      ${p.house ? `<div><span>Sale</span><strong>Auction · opening bid 100 × the Credits floor at the burn · 24 hours from the first bid</strong></div>` : ''}
      <div${p.house ? ' style="display:none"' : ''}><span>Default price</span><strong>${targetText(p.params.target)}${p.params.target.mode !== 'fixed' ? ' · now ' + eth(p.targetEth) : ''}${p.defaultBelowFloor ? ' · <span class="blocked">below floor</span>' : ''}</strong></div>
      <div><span>Arranged by</span><strong${p.manual ? ' class="alert-c"' : ''}>${p.manual ? 'Manual · the host’s metric below' : esc(arrLabel(p.params.arrangement)) + ' — ' + esc(arrDesc(p.params.arrangement))}${p.assembled && p.orderSource ? ' · burned with ' + esc(p.orderSource === 'Manual' ? 'the host’s order' : p.orderFallback ? 'Time order (host did not burn within 1 day)' : arrLabel({ preset: p.orderSource })) : ''}</strong></div>
      ${p.manual ? `<div class="rule-strong"><span class="alert-c">Host’s metric</span><strong class="alert-c">${esc(arrDesc(p.params.arrangement))}</strong></div>` : ''}
      <div><span>Defaults</span><strong class="muted">Set by the host and applied automatically. Card holders can vote a different price. The host can change settings only until someone else deposits${p.manual ? ', orders and burns this Manual party,' : ''} and can hand hosting on; without Credit Cards a host cannot vote, chat or burn${p.manual ? ' (except the Manual burn)' : ''}.</strong></div>
      <div><span>Floor · ${p.params.floorMode === 'latest' ? 'latest reading' : '24-hour average'}</span><strong>${eth(p.floorEth)} <span class="faint">${floorNote(p.floor)}</span></strong></div>
      ${p.listing ? `<div><span>Approved price</span><strong>${priceLabel(p.listing)} · ${eth(p.listingEth)} · ${vsFloor(p.listingEth, p.floorEth)}${p.raiseAskEth != null && me ? ` <button type="button" id="raise-ask" style="margin:0" title="A floor-relative ask can only rise, never fall">Raise to ${eth(p.raiseAskEth)}</button>` : ''}</strong></div>` : ''}
      <div><span>Sale split</span><strong>1% Statement Maker · the rest to the 80 Credit Cards</strong></div>
      ${isMember ? `<div><span>You</span><strong><span class="dot y"></span>${myTokens} of 80 Credit Cards</strong></div>` : ''}
      ${isHost ? `<div><span>Hand off hosting</span><strong><span class="actions" style="margin:0;justify-content:flex-end"><input id="host-to" placeholder="0x…" style="width:220px;border:0;border-bottom:1px solid var(--line)"><button type="button" id="host-go">Hand off</button></span></strong></div>` : ''}
     </div>
    </div>

    ${myCards.length ? `
    <div class="panel">
     <details class="cards-box" id="mycards" ${cardsOpen(p.id) ? 'open' : ''}>
      <summary><h2>Your Credit Cards · ${myCards.length}</h2><span class="muted">${myCards.length} card${myCards.length === 1 ? '' : 's'}${liveCards.length && (p.status === 'OPEN' || p.status === 'EXPIRED') ? ` · ${liveCards.length} redeemable` : ''}${liveCards.length && p.status === 'SOLD' ? ` · ${liveCards.length} claimable` : ''}</span></summary>
      <p class="muted" style="margin:6px 0 10px">One card per Credit. The card is the vote, the claim on its Credit before the Statement is made, and 1/80 of the sale. Whoever holds it has all three, and it can be transferred like any NFT.</p>
      <div class="cards" id="cards-list"></div>
      <div class="actions"><button type="button" id="cards-more" hidden></button></div>
     </details>
     ${liveCards.length && (p.status === 'OPEN' || p.status === 'EXPIRED') ? `<div class="actions"><button type="button" id="redeem-all">Redeem all my cards · ${liveCards.length}</button></div>` : ''}
     <div class="actions" id="send-row" hidden><span class="muted">Send card <span id="send-no"></span> to</span><input id="send-to" placeholder="0x…" style="width:340px;border:0;border-bottom:1px solid var(--line)"><button type="button" id="send-go">Send</button><button type="button" id="send-x">Cancel</button></div>
     ${p.status === 'SOLD' && myCards.some(c => !c.claimed) ? `<div class="actions"><button type="button" class="cta" id="claim-all">Claim all · ${eth(p.perCard * myCards.filter(c => !c.claimed).length)}</button></div>` : ''}
     <div class="error" id="card-err"></div>
    </div>` : ''}

    ${au ? `
    <div class="panel" id="auction"><h2>Auction</h2>
     <div class="rows">
      <div><span>Opening bid</span><strong>${ethx(au.reserveEth)} <span class="faint">100 × Credits floor ${ethx(au.creditFloorEth)} at the burn</span></strong></div>
      <div><span>High bid</span><strong>${au.high ? `${ethx(au.high.eth)} · ${userLink(au.high.bidder)}` : 'None yet'}</strong></div>
      ${!au.settled && !au.ended ? `<div><span>Minimum next bid</span><strong>${ethx(au.minNextEth)} <span class="faint">${au.high ? 'high bid + 0.1 ETH' : 'the opening bid'}</span></strong></div>` : ''}
      <div><span>Time</span><strong id="au-clock">${au.settled ? 'Settled ' + esc(new Date(au.settled.at).toLocaleString()) : au.ended ? 'Ended' : au.endsAt == null ? `Opening bid: ${ethx(au.reserveEth)} · no timer until the first bid` : clock(au.endsAt - p.now) + ' left'}</strong></div>
      ${!au.settled && au.endsAt != null ? `<div><span>Ends</span><strong>${esc(new Date(au.endsAt).toLocaleString())} <span class="faint">a bid in the last 5 minutes moves it to 5 minutes after that bid</span></strong></div>` : ''}
     </div>
     ${au.settled ? '' : !au.ended ? (me ? `<div class="actions" style="align-items:center;margin-top:14px"><input id="bid-amt" inputmode="decimal" value="${esc(weiDec(au.minNextWei))}" style="width:140px;border:0;border-bottom:1px solid var(--line)" aria-label="Bid, ETH"><span class="muted">ETH</span><button type="button" class="cta" id="bid">Bid</button><span class="faint">Preview · no ETH moves</span></div>`
       : connectAct)
       : me ? `<div class="actions" style="margin-top:14px"><button type="button" class="cta" id="settle">${au.high ? 'Settle · Statement to the high bidder' : 'Close with no bids'}</button></div>` : connectAct}
     <div class="error" id="bid-err"></div>
     ${au.bids.length ? `<h2 style="margin:18px 0 8px">Bids · ${au.bids.length}</h2><div class="rows">${au.bids.map(b => `<div><span>${ago(b.at)} ago · ${userLink(b.bidder)}</span><strong>${ethx(b.eth)}${b.refunded ? ' <span class="faint">· outbid, refunded</span>' : ''}${b.extended ? ' <span class="faint">· extended</span>' : ''}</strong></div>`).join('')}</div>` : ''}
    </div>` : ''}
    ${p.status === 'ASSEMBLED' && p.listing ? `
    <div class="panel"><h2>Buy</h2>
     <div class="rows"><div><span>Price</span><strong>${eth(p.listingEth)} · ${vsFloor(p.listingEth, p.floorEth)}</strong></div><div><span>Split</span><strong>1% Statement Maker · ${eth(p.listingEth ? p.listingEth * 0.99 / SLOTS : null)} per Credit Card</strong></div></div>
     ${p.buyOpensAt > p.now ? `<p class="muted">Buying opens in ${hrs(p.buyOpensAt - p.now)}. ${p.listing.source === 'default' ? 'Default price from the host.' : 'Price set by vote.'}</p>` : me ? `<button class="cta" id="buy">Buy Statement ${Number(p.assembled.number)} for ${eth(p.listingEth)}</button> <span class="faint">Preview · no ETH moves</span>` : connectAct}
     <div class="error" id="buy-err"></div></div>` : ''}
    ${p.status === 'SOLD' ? `
    <div class="panel"><h2>Sold</h2><div class="rows">
     <div><span>Price</span><strong>${eth(p.sold.price)} to ${userLink(p.sold.buyer)}</strong></div>
     <div><span>Statement Maker 1%</span><strong>${eth(p.sold.fee)}</strong></div>
     <div><span>Per Credit Card</span><strong>${eth(p.perCard)}</strong></div>
     <div><span>Claimed</span><strong>${p.credits.filter(c => c.claimed).length} / 80 cards</strong></div></div></div>` : ''}

    ${p.status === 'OPEN' && !embed ? `
    <div class="panel">
     <h2>Deposit</h2>
     ${!me ? `${connectAct}` : `
       ${!wallet.length ? `<p class="alert-k">Connected: ${meName()} holds 0 Credits. Parties need a wallet holding a Credit.</p><div class="actions">${switchBtn}</div>` : !eligibleMine.length ? `<p class="alert-k">Connected: ${meName()} holds ${wallet.length} Credit${wallet.length === 1 ? '' : 's'}; none meet this party’s criteria.</p><div class="actions">${switchBtn}</div>` : ''}
       <p class="muted">${nameTag(me)} holds ${wallet.length} Credit${wallet.length === 1 ? '' : 's'} · ${eligibleMine.length} eligible here · minimum ${minDep}</p>
       <div class="picker">${pickList.slice(0, partyUI.pickShown || 80).map(c => { const ok = !c.deposited && matchesClient(c, p.params.filters); return `<button type="button" data-pick="${Number(c.id)}" ${ok ? '' : 'disabled'} aria-pressed="${partyUI.picks.has(c.id)}" title="#${Number(c.id)} ${esc(c.colors)} ${esc(c.print)} ${esc(c.weight)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>`; }).join('')}</div>
       ${pickList.length > (partyUI.pickShown || 80) ? `<div class="actions"><button type="button" id="pick-more">Show more · ${pickList.length - (partyUI.pickShown || 80)} left</button></div>` : ''}
       <div class="actions"><button type="button" id="pick-all">Select eligible</button><button type="button" id="pick-none">Clear</button></div>
       <div class="fee-box"><strong>Fee: 1%.</strong> When the Statement sells, Statement Maker keeps 1% of the price. Each of the 80 Credit Cards receives 1/80 of the other 99%. Example: a 3 ETH sale pays 0.03 ETH to Statement Maker and 0.037125 ETH per card.</div>
       <label class="check" style="margin:12px 0"><input type="checkbox" id="dep-ack"> <span>I understand that this party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. It sells at the party’s price, and <strong>Statement Maker takes a 1% fee on that sale</strong>. The other 99% is split equally across the 80 Credit Cards.</span></label>
       <button class="cta" id="deposit" disabled>Deposit</button> ${cost('deposit')} each <span class="hint" id="dep-hint"></span>
       ${isMember ? `<button type="button" id="withdraw" class="muted" style="margin-left:18px">Redeem all my cards</button>` : ''}`}
     <div class="error" id="dep-err"></div>
     <p class="note">Depositing accepts this party's defaults: arranged by ${esc(p.manual ? 'the host’s metric (' + arrDesc(p.params.arrangement) + ')' : arrLabel(p.params.arrangement) + ', ' + arrDesc(p.params.arrangement))}, ${targetText(p.params.target)} price. Each Credit you deposit returns one Credit Card. Until the party fills, the card's holder can redeem it for that Credit.</p>
    </div>` : ''}

    ${p.status === 'EXPIRED' ? `
    <div class="panel"><h2>Expired</h2>
     ${p.returned ? `<p class="muted">${Number(p.returned.count)} Credits returned to their card holders by ${userLink(p.returned.by)}.</p>` : `<p class="muted">The party did not finish in time. Each Credit goes to whoever holds its card. Any member can send them all.</p>${isMember ? `<div class="actions"><button type="button" class="cta" id="return">Return all Credits</button> ${cost('returnCredit')} per Credit</div>` : ''}`}
     <div class="error" id="ret-err"></div></div>` : ''}
    ${p.status !== 'OPEN' && p.status !== 'EXPIRED' ? `
    <div class="panel" id="proposals">
     <div class="caption" style="min-height:0;margin-bottom:10px"><h2>Proposals</h2><button type="button" id="rules-t" class="muted">${partyUI.rules ? 'Hide rules' : 'How votes work'}</button></div>
     ${partyUI.rules ? `<div class="rules-box">
      <div><span>Weight</span><strong>1 Credit Card = 1 vote, counted as held when the proposal opened</strong></div>
      <div><span>Passes</span><strong>41 of 80 yes and zero no</strong></div>
      <div><span>Below floor</span><strong>60 of 80 yes and zero no</strong></div>
      <div><span>Deadlock</span><strong>After 3 counted blocks (a price with 41+ yes stopped by a no, recorded by anyone) or 30 days without a price executing, 54 yes passes; no is ignored. Now: ${Number(p.deadlock?.blocked || 0)}/3 counted${p.deadlock?.LIST ? ' · deadlock rule on' : ''}</strong></div>
      <div><span>Window</span><strong>1 hour to 7 days, chosen by the proposer</strong></div>
      <div><span>Execute</span><strong>Any card holder, within 7 days of passing, or it lapses</strong></div></div>` : ''}
     ${p.status === 'FULL' ? (() => {
       const hostBurn = p.manual && canHandArrange && partyUI.mode === 'arrange', fbBurn = p.manual && !isHost && fallbackOpen && holder;
       const canBurn = p.manual ? hostBurn || fbBurn : holder;
       return `<div class="prop"><div class="prop-head"><strong>Burn</strong><span class="chip ${!p.manual || fallbackOpen ? 'pass' : 'open'}">${p.house || !p.manual ? 'Any card holder' : fallbackOpen ? 'Any card holder · Time order' : 'Host arranges by hand'}</span></div>
      <p class="muted">${p.house ? 'Arranged in mint order, earliest first. Any card holder can burn the 80 into the Statement in one step.' : !p.manual ? `Arrangement is locked as ${esc(arrLabel(p.params.arrangement))} (${esc(arrDesc(p.params.arrangement))}). Any card holder can burn the 80 into the Statement in one step.`
        : `The host orders the 80 by the stated metric and burns in one step.${p.fallbackAt ? ` If the host has not burned by ${esc(new Date(p.fallbackAt).toLocaleString())} (1 day after the party filled), any card holder can burn in Time order.` : ''}`} ${p.house ? 'The auction then opens at 100 × the Credits floor; its 24-hour timer starts at the first bid.' : 'The default price then goes live.'} Preview until the Statement contract is public.</p>
      ${burnAlert(p.manual ? (fallbackOpen && !isHost ? 'Time' : null) : p.params.arrangement?.preset)}
      ${canBurn ? (partyUI.confirmBurn
        ? `<div class="actions"><span class="blocked">Burning is permanent. The 80 Credits become one Statement.</span><button type="button" class="cta" id="assemble">Confirm burn</button><button type="button" id="burn-x">Cancel</button></div>`
        : `<div class="actions"><button type="button" class="cta" id="burn-ask">${hostBurn ? 'Burn with this order' : fbBurn ? 'Burn in Time order' : 'Burn'}</button></div>`)
        : canHandArrange ? '<p class="note">Open Arrange to set the order, then burn.</p>' : !me ? connectAct : !p.manual && !holder ? '<p class="note">Any Credit Card holder can burn.</p>' : ''}
     </div>`; })() : ''}
     ${p.assembled ? `<div class="prop"><div class="prop-head"><strong>Statement ${Number(p.assembled.number)}</strong><a href="#/statement/${esc(p.id)}">View →</a></div><p class="muted">Assembled by ${userLink(p.assembled.by)}</p></div>` : ''}
     ${[...p.proposals].reverse().map(q => {
       const mine = q.votes?.[me];
       const canVote = isMember && !q.executed && !q.closed && !q.superseded && (q.snapshot ? q.snapshot[me] > 0 : true);
       const state = q.executed ? ['Executed', 'done'] : q.superseded ? ['Superseded', 'muted'] : q.lapsed ? ['Lapsed', 'muted'] : q.executable ? ['Passed · execute', 'pass'] : q.no && !q.override ? ['Blocked by no', 'blocked'] : q.closed ? ['Failed', 'muted'] : q.passing ? ['Passing', 'pass'] : ['Voting', 'open'];
       const what = q.type === 'LIST' ? `Sell for ${eth(q.priceEth)} <span class="faint">(${priceLabel(q.args)} · buying opens ${Number(q.args.buyDelayHours ?? 1)}h after it goes live)</span> ${vsFloor(q.priceEth, p.floorEth)}` : q.type === 'CANCEL_LISTING' ? 'Cancel the listing' : esc(q.type);
       return `
      <div class="prop s-${state[1]}">
       <div class="prop-head"><span><span class="faint">#${Number(q.id)}</span> <strong>${esc({ NOMINATE_ARRANGER: 'Arranger', APPROVE_ARRANGEMENT: 'Arrangement', LIST: 'Price', CANCEL_LISTING: 'Cancel listing' }[q.type] || q.type)}</strong></span><span class="chip ${state[1]}">${state[0]}</span></div>
       <p class="prop-what">${what}</p>
       <div class="meter" title="Pass line at ${Number(q.need)} cards">
        <i class="yes" style="width:${q.yes / SLOTS * 100}%"></i><b style="left:${q.need / SLOTS * 100}%"></b>
       </div>
       <div class="prop-nums"><span>Yes ${q.yes} / ${Number(q.need)} needed${q.below ? ' · below floor' : ''}${q.override ? ' · deadlock rule' : ''}</span><span class="${q.no ? 'blocked' : 'faint'}">No ${q.no}${q.override && q.no ? ' (ignored)' : ''}</span></div>
       <div class="prop-foot">
        <span class="faint">${userLink(q.by)} · ${ago(q.at)} ago · ${q.executed ? 'executed by ' + userLink(q.executedBy) : q.closed ? (q.executable ? 'execute within ' + hrs(q.execBy - p.now) : 'closed') : 'closes in ' + hrs(q.endsAt - p.now)}</span>
        <span class="actions" style="margin:0">
         ${mine !== undefined ? `<span class="you">You voted ${mine ? 'yes' : 'no'}</span>` : ''}
         ${canVote ? `<button type="button" data-vote="${Number(q.id)}" data-yes="1" class="${mine === true ? 'on' : ''}">Yes</button><button type="button" data-vote="${Number(q.id)}" data-yes="0" class="${mine === false ? 'on no' : ''}">No</button>` : ''}
         ${isMember && q.executable ? `<button type="button" class="cta" data-exec="${Number(q.id)}" style="margin:0">Execute</button>` : ''}
         ${me && q.countable ? `<button type="button" data-count="${Number(q.id)}" style="margin:0" title="Records this block toward the deadlock rule (3 needed)">Count as blocked</button>` : ''}
         ${q.blockedCounted && !q.superseded ? '<span class="faint">counted toward deadlock</span>' : ''}
        </span>
       </div>
      </div>`; }).join('') || '<p class="muted">No proposals yet.</p>'}

     ${auctionOn ? '<p class="note">This party sells by auction: no price votes.</p>' : isMember ? `
     <div class="composer">
      <div class="caption" style="min-height:0"><h2>New proposal</h2></div>
       <div class="field"><label>Price</label><div><div style="display:flex;gap:12px;align-items:center"><select id="pm"><option value="fixed">ETH</option><option value="floorEth">Floor ± ETH</option><option value="floorPct">Floor ± %</option></select><input id="pv" type="number" step="0.01" value="${p.floorEth ? (p.floorEth * 1.1).toFixed(2) : 1}" style="width:110px"><span id="pp" class="muted"></span></div><div class="hint" id="ph"></div></div></div>
      <div class="field"><label>Buy wait, hours</label><div><input id="bw2" type="number" min="0" max="72" value="${Number(p.params.buyDelayHours ?? 1)}" style="width:80px"><div class="hint">Range: 0–72 · voted with this price · party default ${Number(p.params.buyDelayHours ?? 1)}h</div></div></div>
      <div class="field"><label>Voting window</label><div><select id="win">${[1, 24, 48, 72, 168].map(h => `<option value="${h}" ${h === (p.params.voteHours || 48) ? 'selected' : ''}>${h === 1 ? '1 hour' : h < 168 ? h + ' hours' : '7 days'}</option>`).join('')}</select><div class="hint">Range: 1 hour – 7 days</div></div></div>
      <div class="actions" style="margin-top:12px"><button type="button" class="cta" id="propose-price" style="margin:0">Propose</button> ${cost('propose')} <span class="hint">Your yes vote is cast automatically.</span></div>
     </div>` : !me ? connectAct : `<p class="note">Only Credit Card holders can propose and vote.</p>`}
     <div class="error" id="vote-err"></div>
    </div>` : ''}

    ${embed ? '' : `<div class="panel">
     <h2>Card holders · ${p.members.length}</h2>
     <table class="table"><tbody>${p.members.slice(0, 30).map(m => `<tr><td>${m.address === me ? '<span class="dot y"></span>' : ''}${userLink(m.address)}${m.host ? ' <span class="muted">host</span>' : ''}</td><td style="text-align:right">${Number(m.count)}</td></tr>`).join('')}</tbody></table>
    </div>`}

    <div class="panel">
     <h2>Chat</h2>
     <div class="chat" id="chat">${p.chat.map(m => `<div class="msg"><span class="muted">${userLink(m.address)} · ${ago(m.at)}</span><p>${esc(m.text)}</p></div>`).join('') || '<p class="muted" style="padding:10px 0">Quiet.</p>'}</div>
     ${holder ? `<div class="compose"><textarea id="say" rows="1" placeholder="Say something"></textarea><button type="button" id="send">Send</button></div>` : !me ? connectAct : `<p class="note">Credit Card holders can post.</p>`}
     <div class="error" id="chat-err"></div>
    </div>

    ${embed ? '' : '<div class="panel" id="log"></div>'}
   </section>
  </div>`);

  const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  if (!embed) logPanel(p.id, $('#log'));
  // The Minute page speaks only to the four parties: no hosts, criteria, presets or settings rows.
  if (embed && p.house) root.querySelectorAll('.rows > div > span:first-child').forEach(sp => { if (/^(hosts|eligible credits|minimum deposit|arranged by|host’s metric|defaults|hand off hosting|default price)$/i.test(sp.textContent.trim())) sp.parentElement.remove(); });
  const err = (id, e) => { const el = $('#' + id); if (el) el.textContent = e.message || e; };
  const act = async (path, body, errId) => { try { await api(`parties/${encodeURIComponent(p.id)}/${path}`, body); await route(); return true; } catch (e) { err(errId, e); return false; } };

  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { partyUI.mode = b.dataset.mode; if (partyUI.mode === 'arrange' && !partyUI.order) partyUI.order = [...p.credits]; route(); });
  root.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { partyUI.order = PRESETS[b.dataset.preset](partyUI.order || p.credits); partyUI.preset = b.dataset.preset + (partyUI.order.seed ? ' #' + partyUI.order.seed : ''); route(); });
  const sheetEl = embed ? null : $('#sheet');
  sheetEl?.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { partyUI.selected = Number(b.dataset.id); route(); } });
  if (sheetEl && partyUI.mode === 'arrange') {
    sheetEl.classList.add('dragging');
    let from = null;
    sheetEl.addEventListener('dragstart', e => { from = Number(e.target.closest('button')?.dataset.i); });
    sheetEl.addEventListener('dragover', e => { e.preventDefault(); sheetEl.querySelectorAll('.over').forEach(x => x.classList.remove('over')); e.target.closest('button')?.classList.add('over'); });
    sheetEl.addEventListener('drop', e => {
      e.preventDefault(); const to = Number(e.target.closest('button')?.dataset.i);
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) { const o = [...partyUI.order]; [o[from], o[to]] = [o[to], o[from]]; partyUI.order = o; partyUI.preset = (partyUI.preset || 'Custom').replace(/ · edited$/, '') + ' · edited'; route(); }
    });
  }
  $('#host-go')?.addEventListener('click', () => act('host', { to: $('#host-to').value.trim() }, 'vote-err'));
  $('#burn-ask')?.addEventListener('click', () => { partyUI.confirmBurn = true; route(); });
  $('#burn-x')?.addEventListener('click', () => { partyUI.confirmBurn = false; route(); });
  $('#submit-order-legacy')?.addEventListener('click', () => act('arrange', { order: partyUI.order.map(c => c.id), preset: partyUI.preset || 'Deposit order', hours: $('#win')?.value }, 'arr-err'));
  root.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const id = Number(b.dataset.pick); partyUI.picks.has(id) ? partyUI.picks.delete(id) : partyUI.picks.add(id); b.setAttribute('aria-pressed', partyUI.picks.has(id)); depState(); });
  $('#pick-more')?.addEventListener('click', () => { partyUI.pickShown = (partyUI.pickShown || 80) + 80; route(); });
  $('#pick-all')?.addEventListener('click', () => { partyUI.picks = new Set(eligibleMine.slice(0, remaining).map(c => c.id)); route(); });
  $('#pick-none')?.addEventListener('click', () => { partyUI.picks.clear(); route(); });
  // Deposit exactly the Credits picked: at least the party minimum, at most the slots left.
  function depState() {
    const b = $('#deposit'); if (!b) return;
    const k = partyUI.picks.size;
    b.textContent = `Deposit ${k} Credit${k === 1 ? '' : 's'}`;
    b.disabled = !($('#dep-ack').checked && k >= minDep && k <= remaining);
    $('#dep-hint').textContent = k < minDep ? `Pick at least ${minDep}` : k > remaining ? `Only ${remaining} slots left` : '';
  }
  depState();
  $('#dep-ack')?.addEventListener('change', depState);
  $('#deposit')?.addEventListener('click', async () => { const picks = [...partyUI.picks]; partyUI.picks.clear(); if (!await act('deposit', { ids: picks, storeOnly: $('#dep-ack').checked }, 'dep-err')) partyUI.picks = new Set(picks); });
  $('#withdraw')?.addEventListener('click', () => act('withdraw', {}, 'dep-err'));
  root.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => act('vote', { proposal: b.dataset.vote, yes: b.dataset.yes === '1' }, 'vote-err'));
  root.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => { const q = p.proposals.find(x => x.id === Number(b.dataset.preview)); const m = new Map(p.credits.map(c => [c.id, c])); partyUI.mode = 'arrange'; partyUI.order = q.args.order.map(id => m.get(id)); partyUI.preset = 'Proposal ' + q.id; route(); });
  const pricePreview = () => {
    const t = { mode: $('#pm').value, value: +$('#pv').value }; const e = priceOf({ mode: t.mode, value: $('#pv').value }, p.floorEth);
    render($('#pp'), `= ${eth(e)} ${vsFloor(e, p.floorEth)}`);
    $('#ph').textContent = t.mode === 'fixed' ? 'Range: above 0 ETH' : t.mode === 'floorPct' ? 'Range: above −100% (floor ' + eth(p.floorEth) + ')' : 'Range: above −' + eth(p.floorEth) + ' (floor ' + eth(p.floorEth) + ')';
  };
  if ($('#pm')) { $('#pm').onchange = pricePreview; $('#pv').oninput = pricePreview; pricePreview(); }
  $('#propose-price')?.addEventListener('click', () => act('propose', { type: 'LIST', hours: $('#win')?.value, buyDelayHours: Number($('#bw2')?.value ?? 1), args: { mode: $('#pm').value, value: +$('#pv').value } }, 'vote-err'));
  root.querySelectorAll('[data-exec]').forEach(b => b.onclick = () => act('execute', { proposal: b.dataset.exec }, 'vote-err'));
  root.querySelectorAll('[data-count]').forEach(b => b.onclick = () => act('countBlocked', { proposal: b.dataset.count }, 'vote-err'));
  $('#raise-ask')?.addEventListener('click', () => act('raiseAsk', {}, 'vote-err'));
  $('#skip')?.addEventListener('click', async () => { await api('dev/advance', { hours: 24 }); route(); });
  $('#rules-t')?.addEventListener('click', () => { partyUI.rules = !partyUI.rules; route(); });
  root.querySelectorAll('[data-ptype]').forEach(b => b.onclick = () => { partyUI.ptype = b.dataset.ptype; route(); });
  let sending = null;
  // Your Credit Cards: collapsed unless opened (remembered per party); drawn 40 at a time once open.
  const cardsBox = $('#mycards', root);
  if (cardsBox) {
    const list = $('#cards-list', root), more = $('#cards-more', root);
    let shown = 0;
    const fig = c => `<figure><img src="/api/card/${Number(c.card)}.svg" alt="Credit Card ${Number(c.card)}" loading="lazy"><figcaption class="actions">
       ${c.claimed ? '<span class="muted">Redeemed</span>' : `<button type="button" data-send="${Number(c.card)}">Send</button>`}
       ${!c.claimed && (p.status === 'OPEN' || p.status === 'EXPIRED') ? `<button type="button" data-wd="${Number(c.id)}">Redeem for Credit #${Number(c.id)}</button>` : ''}
       ${!c.claimed && p.status === 'SOLD' ? `<button type="button" data-claim="${Number(c.card)}">Claim ${eth(p.perCard)}</button>` : ''}
     </figcaption></figure>`;
    const draw = () => { list.append(document.createRange().createContextualFragment(myCards.slice(shown, shown + 40).map(fig).join(''))); shown = Math.min(myCards.length, shown + 40); more.hidden = shown >= myCards.length; more.textContent = `Show more · ${myCards.length - shown} left`; };
    if (cardsBox.open) draw();
    cardsBox.addEventListener('toggle', () => { setCardsOpen(p.id, cardsBox.open); if (cardsBox.open && !shown) draw(); });
    more.onclick = draw;
    list.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.send) { sending = Number(b.dataset.send); $('#send-row').hidden = false; $('#send-no').textContent = '#' + sending; $('#send-to').focus(); }
      else if (b.dataset.wd) act('withdraw', { ids: [Number(b.dataset.wd)] }, 'card-err');
      else if (b.dataset.claim) act('claim', { cards: [Number(b.dataset.claim)] }, 'card-err');
    });
  }
  $('#redeem-all')?.addEventListener('click', () => act('withdraw', {}, 'card-err'));
  $('#send-x')?.addEventListener('click', () => { $('#send-row').hidden = true; sending = null; });
  $('#send-go')?.addEventListener('click', () => act('transfer', { card: sending, to: $('#send-to').value.trim() }, 'card-err'));
  $('#claim-all')?.addEventListener('click', () => act('claim', {}, 'card-err'));
  $('#buy')?.addEventListener('click', () => act('buy', {}, 'buy-err'));
  $('#bid')?.addEventListener('click', () => act('bid', { amount: $('#bid-amt').value.trim() }, 'bid-err'));
  $('#settle')?.addEventListener('click', () => act('settle', {}, 'bid-err'));
  // Live countdown on the server's clock (p.now); at zero, redraw so Settle appears.
  clearInterval(auctionTick);
  if (au && !au.settled && !au.ended && au.endsAt != null) {
    const skew = p.now - Date.now();
    auctionTick = setInterval(() => {
      const el = document.getElementById('au-clock');
      if (!el) return clearInterval(auctionTick);
      const left = au.endsAt - (Date.now() + skew);
      if (left <= 0) { clearInterval(auctionTick); route(); return; }
      el.textContent = clock(left) + ' left';
    }, 1000);
  }
  $('#assemble')?.addEventListener('click', async () => { partyUI.confirmBurn = false; await act('assemble', p.manual && isHost ? { order: (partyUI.order || p.credits).map(c => c.id) } : {}, 'vote-err'); });
  $('#return')?.addEventListener('click', () => act('return', {}, 'ret-err'));
  $('#nominate-legacy')?.addEventListener('click', () => act('propose', { type: 'NOMINATE_ARRANGER', hours: $('#win')?.value, args: { address: $('#nominee').value } }, 'vote-err'));
  const send = () => { const t = $('#say').value.trim(); if (t) act('chat', { text: t }, 'chat-err'); };
  $('#send')?.addEventListener('click', send);
  $('#say')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
}

let draft = { name: '', minDeposit: 1, days: 14, voteHours: 48, arrangement: { preset: 'Time' }, target: { mode: 'floorPct', value: 25 }, filters: {} };
const arrLabel = a => !a ? 'Deposit order' : a.preset === 'Random' ? `Random #${a.seed}` : a.preset === 'Deposit' ? 'Deposit order' : a.preset;
// The metric each arrangement orders by, in one plain line (must match PRESETS in lib/core.mjs). Manual: the host's own words.
const ARR_DESC = { Time: 'mint order, earliest first', Number: 'token number, lowest first', Rarity: 'rarest first', Colors: 'by ink plates: C, M, Y, K, then combinations', Print: 'most misregistered first', Weight: 'lightest coverage first, sparse to extreme', Eights: 'most eights first', Ink: 'fewest inked squares first', Deposit: 'deposit order, first deposited first' };
const arrDesc = a => a?.preset === 'Manual' ? (a.metric || 'no metric stated') : a?.preset === 'Random' ? `shuffled with seed ${Number(a.seed)}` : ARR_DESC[a?.preset || 'Deposit'] || '';
const ARR_HINT = { preset: a => `Arrangement is locked as ${arrLabel(a)}.`, manual: 'Manual: state the metric you will order the 80 by. Only you can burn, with your order. If you have not burned within 1 day of the party filling, any card holder can burn in Time order.' };
async function pageNew() {
  stats = stats || await api('stats');
  if (!stats.partiesUnlocked) {
    const mins = [['1349', '13:49'], ['1505', '15:05'], ['1528', '15:28'], ['1622', '16:22']];
    render(app, `
    <div class="intro"><div><h1>Start a party</h1><p class="muted">Not open yet. At launch there are four parties: the four minutes of the Credits mint in which exactly 80 Credits were minted. Starting your own party opens once one of them has made its Statement.</p></div></div>
    <div class="panel" style="max-width:900px"><h2>The four parties</h2><div class="rows">${mins.map(([id, t]) => `<div><span><a href="#/party/minute-${id}">Minute ${t} UTC</a></span><strong><a href="#/party/minute-${id}">Open →</a></strong></div>`).join('')}</div></div>`);
    return;
  }
  const chip = (key, vals) => `<div class="chips">${vals.map(v => `<button type="button" data-f="${key}" data-v="${esc(v)}" aria-pressed="${[].concat(draft.filters[key] ?? []).map(String).includes(String(v))}">${esc(key === 'shiftMin' ? v + '+' : v)}</button>`).join('')}</div>`;
  const val = v => v == null ? '' : esc(v);
  const rg = stats.ranges;
  render(app, `
  <div class="intro"><div><h1>Start a party</h1><p class="muted">You host. Every setting is a default that runs automatically. You can change settings until someone else deposits and hand hosting on; with Manual you also order and burn. Card holders can vote a different price.</p></div></div>
  <form class="new" id="new-form">
   <div>
    <div class="field"><label for="n">Name</label><div><input id="n" value="${val(draft.name)}" placeholder="Two eights or more" maxlength="60">${hint('Up to 60 characters')}</div></div>
    <div class="field"><label for="ds">Description</label><div><textarea id="ds" rows="3" maxlength="1000" placeholder="What this Statement is about">${val(draft.description)}</textarea>${hint('Up to 1,000 characters')}</div></div>
    <div class="field"><label for="md">Minimum deposit</label><div><input id="md" type="number" min="1" max="80" value="${val(draft.minDeposit)}">${hint('Range: 1–80 Credits per depositor')}</div></div>
    <div class="field"><label for="dd">Deadline, days</label><div><input id="dd" type="number" min="1" max="60" value="${val(draft.days)}">${hint('Range: 1–60 days')}</div></div>
    <div class="field"><label for="vh">Vote window</label><div><select id="vh">${[1, 24, 48, 72, 168].map(h => `<option value="${h}" ${h === (draft.voteHours || 48) ? 'selected' : ''}>${h === 1 ? '1 hour' : h < 168 ? h + ' hours' : '7 days'}</option>`).join('')}</select>${hint('Range: 1 hour – 7 days · default for this party’s proposals')}</div></div>
    <div class="field"><label>Default arrangement</label><div><div class="chips">${['Time', ...Object.keys(PRESETS).filter(k => k !== 'Time'), 'Deposit', 'Manual'].map(k => `<button type="button" data-arr="${k}" aria-pressed="${(draft.arrangement?.preset || 'Time') === k}">${k === 'Deposit' ? 'Deposit order' : k}</button>`).join('')}</div>
      <div class="hint" id="arr-desc">${esc(draft.arrangement?.preset === 'Manual' ? '' : arrLabel(draft.arrangement) + ': ' + arrDesc(draft.arrangement))}</div>
      <div id="arr-metric" ${draft.arrangement?.preset === 'Manual' ? '' : 'hidden'} style="margin-top:6px"><input id="am" maxlength="200" placeholder="The metric you will order by, e.g. darkest to lightest, left to right" value="${esc(draft.arrangement?.metric || '')}"></div>
      <div class="hint${draft.arrangement?.preset === 'Manual' ? ' alert-c' : ''}" id="arr-hint">${draft.arrangement?.preset === 'Manual' ? ARR_HINT.manual : esc(ARR_HINT.preset(draft.arrangement))}</div></div></div>
    <div class="field"><label>Floor reference</label><div><div class="chips">${[['avg24h', '24-hour average'], ['latest', 'Latest reading']].map(([k, l]) => `<button type="button" data-fm="${k}" aria-pressed="${(draft.floorMode || 'avg24h') === k}">${l}</button>`).join('')}</div>${hint('Floor = the Statement collection floor once Statements trade; until then 80 × the Credits floor. Read every minute. The average resists one cheap listing moving it; the latest follows the market as it is. Used for floor-based prices and the 60/80 below-floor rule.')}</div></div>
    <div class="field"><label for="bw">Buy wait, hours</label><div><input id="bw" type="number" min="0" max="72" value="${val(draft.buyDelayHours ?? 1)}">${hint('Range: 0–72 hours · default 1 · how long after a price goes live before anyone can buy. Every price vote can set its own.')}</div></div>
    <div class="field"><label>Default price</label><div>
      <div class="chips">${[['fixed', 'ETH'], ['floorEth', 'Floor + ETH'], ['floorPct', 'Floor + %']].map(([m, l]) => `<button type="button" data-tm="${m}" aria-pressed="${draft.target.mode === m}">${l}</button>`).join('')}</div>
      <input id="tv" type="number" step="0.01" value="${val(draft.target.value)}" style="margin-top:6px"><div class="hint" id="tvh"></div></div></div>
    <div class="field"><label>Colors</label>${chip('colors', COLOR_ORDER)}</div>
    <div class="field"><label>Print</label>${chip('print', PRINT_ORDER)}</div>
    <div class="field"><label>Weight</label>${chip('weight', WEIGHT_ORDER)}</div>
    <div class="field"><label>Shifted plates</label><div>${chip('shiftPlates', ['C', 'M', 'Y', 'K'])}<div class="chips" style="margin-top:4px"><button type="button" id="shift-only" aria-pressed="${!!draft.filters.shiftOnly}">Only these plates</button></div>${hint('Misregistered Credits only · plates that moved off register · from the art contract’s own shift function')}</div></div>
    <div class="field"><label>Shift size</label><div>${chip('shiftMin', [1, 2])}${hint('Range: 1–2 squares · largest move of any plate')}</div></div>
    <div class="field"><label>Eights</label>${chip('eights', [0, 1, 2, 3, 4, 5])}</div>
    <div class="field"><label for="rk">Rarity rank ≤</label><div><input id="rk" type="number" min="1" max="${rg.rank[1]}" value="${val(draft.filters.rankMax)}" placeholder="Any">${hint(`Range: ${n(rg.rank[0])}–${n(rg.rank[1])} · 1 = rarest · e.g. 1,000 keeps the rarest 1,000`)}</div></div>
    <div class="field"><label>Ink (marks)</label><div><div style="display:flex;gap:12px"><input id="mk0" type="number" min="${rg.marks[0]}" max="${rg.marks[1]}" placeholder="Min" value="${val(draft.filters.marksMin)}"><input id="mk1" type="number" min="${rg.marks[0]}" max="${rg.marks[1]}" placeholder="Max" value="${val(draft.filters.marksMax)}"></div>${hint(`Range: ${rg.marks[0]}–${rg.marks[1]} inked squares · median 65`)}</div></div>
    <div class="field"><label>Token number</label><div><div style="display:flex;gap:12px"><input id="id0" type="number" min="1" max="${rg.id[1]}" placeholder="From" value="${val(draft.filters.idMin)}"><input id="id1" type="number" min="1" max="${rg.id[1]}" placeholder="To" value="${val(draft.filters.idMax)}"></div>${hint(`Range: ${n(rg.id[0])}–${n(rg.id[1])} · lower numbers paid earlier`)}</div></div>
    <div class="panel" style="margin-top:32px">
     <h2>Your opening deposit</h2>
     <p class="alert-k">Your connected wallet must deposit at least the minimum number of Credits, and every one must meet the criteria selected above. The party opens with your deposit.</p>
     <p class="muted" id="own-note">…</p>
     <div class="picker" id="own-picker"></div>
     <div class="actions"><button type="button" id="own-all">Select the minimum</button><button type="button" id="own-none">Clear</button></div>
    </div>
    ${storeBanner()}
    <div class="fee-box"><strong>Fee: 1%.</strong> When the Statement sells, Statement Maker keeps 1% of the price. Each of the 80 Credit Cards receives 1/80 of the other 99%. Example: a 3 ETH sale pays 0.03 ETH to Statement Maker and 0.037125 ETH per card.</div>
    <label class="check" style="margin:12px 0"><input type="checkbox" id="new-ack"> <span>I understand that this party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. It sells at the party’s price, and <strong>Statement Maker takes a 1% fee on that sale</strong>. The other 99% is split equally across the 80 Credit Cards.</span></label>
    <button class="cta" id="create" type="button" disabled>Open party and deposit</button>
    <div class="error" id="new-err"></div>
   </div>
   <div>
    <div class="caption" style="min-height:0;margin-bottom:12px"><h2>Eligible</h2><span id="elig" class="muted">…</span></div>
    <div class="frame statement" id="elig-sheet"></div>
    <p class="note" id="elig-note"></p>
   </div>
  </form>`);
  $('#new-form').addEventListener('submit', e => e.preventDefault());
  const read = () => {
    if (draft.arrangement?.preset === 'Manual') draft.arrangement.metric = $('#am').value;
    draft.name = $('#n').value; draft.buyDelayHours = Math.max(0, Math.min(72, Math.round(+$('#bw').value || 0))); draft.description = $('#ds').value; draft.voteHours = +$('#vh').value; draft.minDeposit = +$('#md').value || 1; draft.days = +$('#dd').value || 14; draft.target.value = +$('#tv').value || 0;
    const num = id => +$(id).value || undefined;
    Object.assign(draft.filters, { rankMax: num('#rk'), marksMin: num('#mk0'), marksMax: num('#mk1'), idMin: num('#id0'), idMax: num('#id1') });
  };
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(async () => {
    read();
    const r = await api('eligible', draft.filters);
    $('#elig').textContent = `${r.count.toLocaleString()} Credits · ${r.owners.toLocaleString()} holders · up to ${r.statements.toLocaleString()} Statements`;
    render($('#elig-sheet'), r.sample.map(c => `<span><img src="${svg(c.id)}" alt=""></span>`).join('') + '<span class="empty"></span>'.repeat(Math.max(0, SLOTS - r.sample.length)));
    $('#elig-note').textContent = r.count < SLOTS ? 'Fewer than 80 Credits match. This party could never fill.' : 'Rarest 16 shown.';
    drawOwn();
  }, 150); };
  // The host's own Credits that meet the criteria; the party opens with at least the minimum of them.
  let own = [], ownState = 'loading', ownShown = 80;
  const picks = new Set();
  api('wallet/' + me).then(w => { own = w; ownState = 'ok'; drawOwn(); }).catch(e => { ownState = e.message; drawOwn(); });
  function drawOwn() {
    const ok = own.filter(c => !c.deposited && matchesClient(c, draft.filters));
    for (const id of [...picks]) if (!ok.some(c => c.id === id)) picks.delete(id);
    const min = draft.minDeposit || 1;
    const note = $('#own-note');
    if (ownState !== 'ok') { note.textContent = ownState === 'loading' ? 'Reading your Credits…' : ownState; render($('#own-picker'), ''); }
    else if (!own.length) { render(note, `<span class="alert-k">Connected: ${meName()} holds 0 Credits. Parties need a wallet holding a Credit.</span><span class="actions" style="display:flex;margin-top:10px">${switchBtn}</span>`); render($('#own-picker'), ''); }
    else if (!ok.length) { render(note, `<span class="alert-k">Connected: ${meName()} holds ${own.length} Credit${own.length === 1 ? '' : 's'}; none match the chosen filters.</span> Loosen the filters, or switch to a wallet holding a matching Credit.<span class="actions" style="display:flex;margin-top:10px">${switchBtn}</span>`); render($('#own-picker'), ''); }
    else {
      note.textContent = `${nameOf(me) || short(me)} holds ${own.length} Credit${own.length === 1 ? '' : 's'}; ${ok.length} meet these criteria. Selected ${picks.size} of at least ${min}.`;
      render($('#own-picker'), ok.slice(0, ownShown).map(c => `<button type="button" data-own="${Number(c.id)}" aria-pressed="${picks.has(c.id)}" title="#${Number(c.id)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>`).join('') + (ok.length > ownShown ? `<button type="button" id="own-more" style="grid-column:1/-1;aspect-ratio:auto;padding:6px 0;text-align:left">Show more · ${ok.length - ownShown} left</button>` : ''));
      $('#own-more')?.addEventListener('click', () => { ownShown += 80; drawOwn(); });
    }
    app.querySelectorAll('[data-own]').forEach(b => b.onclick = () => { const id = Number(b.dataset.own); picks.has(id) ? picks.delete(id) : picks.add(id); drawOwn(); });
    $('#create').disabled = !($('#new-ack').checked && picks.size >= min && picks.size <= SLOTS);
    $('#create').textContent = `Open party and deposit ${picks.size} Credit${picks.size === 1 ? '' : 's'}`;
  }
  $('#own-all').onclick = () => { own.filter(c => !c.deposited && matchesClient(c, draft.filters)).slice(0, draft.minDeposit || 1).forEach(c => picks.add(c.id)); drawOwn(); };
  $('#own-none').onclick = () => { picks.clear(); drawOwn(); };
  $('#new-ack').onchange = drawOwn;
  $('#shift-only').onclick = e => { draft.filters.shiftOnly = !draft.filters.shiftOnly; e.target.setAttribute('aria-pressed', draft.filters.shiftOnly); refresh(); };
  app.querySelectorAll('[data-f="shiftMin"]').forEach(b => b.onclick = e => { e.stopImmediatePropagation(); const v = +b.dataset.v; draft.filters.shiftMin = draft.filters.shiftMin === v ? undefined : v; app.querySelectorAll('[data-f="shiftMin"]').forEach(x => x.setAttribute('aria-pressed', draft.filters.shiftMin === +x.dataset.v)); refresh(); });
  app.querySelectorAll('[data-f]:not([data-f="shiftMin"])').forEach(b => b.onclick = () => { const k = b.dataset.f, v = k === 'eights' ? +b.dataset.v : b.dataset.v; const a = draft.filters[k] || []; draft.filters[k] = a.includes(v) ? a.filter(x => x !== v) : [...a, v]; b.setAttribute('aria-pressed', draft.filters[k].includes(v)); refresh(); });
  const tvHint = () => { const fl = (draft.floorMode === 'latest' ? stats.floorLatest : stats.floorAvg?.credit) * SLOTS || null; $('#tvh').textContent = draft.target.mode === 'fixed' ? 'Range: above 0 ETH' : (draft.target.mode === 'floorPct' ? 'Range: above −100%' : 'Range: above −' + eth(fl)) + ' · floor now ' + eth(fl); };
  app.querySelectorAll('[data-fm]').forEach(b => b.onclick = () => { draft.floorMode = b.dataset.fm; app.querySelectorAll('[data-fm]').forEach(x => x.setAttribute('aria-pressed', x === b)); tvHint(); });
  app.querySelectorAll('[data-arr]').forEach(b => b.onclick = () => { draft.arrangement = b.dataset.arr === 'Random' ? { preset: 'Random', seed: 1 + Math.floor(Math.random() * 999999) } : { preset: b.dataset.arr }; app.querySelectorAll('[data-arr]').forEach(x => x.setAttribute('aria-pressed', x === b)); const h = $('#arr-hint'); const man = draft.arrangement.preset === 'Manual'; if (man) draft.arrangement.metric = $('#am').value; h.className = 'hint' + (man ? ' alert-c' : ''); h.textContent = man ? ARR_HINT.manual : ARR_HINT.preset(draft.arrangement); $('#arr-metric').hidden = !man; $('#arr-desc').textContent = man ? '' : arrLabel(draft.arrangement) + ': ' + arrDesc(draft.arrangement); });
  app.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => { draft.target.mode = b.dataset.tm; app.querySelectorAll('[data-tm]').forEach(x => x.setAttribute('aria-pressed', x === b)); tvHint(); });
  tvHint();
  app.querySelectorAll('input:not([type=checkbox]), textarea').forEach(i => i.oninput = refresh);
  $('#create').onclick = async () => { read(); try { const p = await api('parties', { ...draft, ids: [...picks], storeOnly: $('#new-ack').checked }); location.hash = '#/party/' + p.id; } catch (e) { $('#new-err').textContent = e.message; } };
  refresh();
}

async function pageWallet(addr) {
  addr = (addr || me || '').toLowerCase();
  if (addr && !/^0x[0-9a-f]{40}$/.test(addr)) addr = '';
  const list = addr ? await api('wallet/' + addr) : [];
  const solo = Math.floor(list.length / SLOTS);
  render(app, `
  <div class="intro"><div><h1>Credits</h1><p class="muted">Look up any wallet.</p></div>
   <div class="compose" style="min-width:min(420px,100%)"><textarea id="w" rows="1" placeholder="0x…">${esc(addr)}</textarea><button type="button" id="go">Look up</button></div></div>
  ${addr ? `<div class="caption"><h2>${userLink(addr)} · ${list.length} Credits</h2><span class="muted">${solo} Statement${solo === 1 ? '' : 's'} alone · ${list.length % SLOTS} left over</span></div>
  <table class="table"><thead><tr><th></th><th>Credit</th><th>Colors</th><th>Print</th><th>Weight</th><th>Eights</th><th>Ink</th><th>Rarity</th><th>Party</th></tr></thead><tbody>
  ${list.slice(0, 500).map(c => `<tr><td><img src="${svg(c.id)}" alt="" loading="lazy"></td><td>#${Number(c.id)}</td><td>${esc(c.colors)}</td><td>${esc(c.register || c.print)}</td><td>${esc(c.weight)}</td><td>${Number(c.eights)}</td><td>${Number(c.marks)}</td><td>${c.rank.toLocaleString()}</td><td>${c.deposited ? 'In a party' : '—'}</td></tr>`).join('')}
  </tbody></table>` : ''}`);
  const go = () => { location.hash = '#/wallet/' + $('#w').value.trim(); };
  $('#go').onclick = go;
  $('#w').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
}

// ---------- profile: a user is a wallet address ----------
// Statements owned and Statements it was part of are public; Credits, Credit Cards, redemptions and the parties it
// could join are shown to wallets that pass the party gate (a Credit or a Credit Card), as the server enforces.
const CARD_STATE = { redeemable: 'Redeemable', locked: 'Locked · party full', 'statement made': 'Statement made', claimable: 'Claimable', claimed: 'Claimed' };
async function pageUser(addr) {
  addr = String(addr || me || '').toLowerCase();
  const byName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(addr);
  if (!isAddress(addr) && !byName) {
    render(app, `<div class="intro"><div><h1>Profile</h1><p class="muted">${me ? 'Not a wallet address or ENS name.' : 'Connect a wallet to see your profile, or open any address shown on the site.'}</p></div></div>`);
    return;
  }
  const u = await api('users/' + encodeURIComponent(addr));
  if (u.name) ensNames.set(u.address, u.name);
  addr = u.address;
  const you = me === addr;
  const mini = ids => `<span class="mini">${ids.map(id => `<img src="${svg(id)}" alt="">`).join('')}</span>`;
  const statementLink = (id, number, name) => `<a href="#/statement/${esc(id)}">Statement ${Number(number)}</a> <span class="faint">${esc(name)}</span>`;
  const creditCell = c => `<span class="${c.party ? 'in-party' : ''}" title="#${Number(c.id)} · ${esc(c.colors)} · ${esc(c.print)} · ${esc(c.weight)} · rarity ${Number(c.rank).toLocaleString()}${c.party ? ' · in ' + esc(c.party.name) : ''}"><img src="${svg(c.id)}" alt="Credit ${Number(c.id)}" loading="lazy"></span>`;
  const past = u.past.map(q => `<div><span>${statementLink(q.id, q.number, q.name)}${q.demo ? ' <span class="demo">Demo</span>' : ''}</span><strong>${q.deposited ? `${Number(q.deposited)} deposited` : ''}${q.deposited && q.held ? ' · ' : ''}${q.held ? `${Number(q.held)} card${q.held === 1 ? '' : 's'} held` : ''} · ${q.soldPrice != null ? `sold ${eth(q.soldPrice)}` : 'not sold'}${q.claimed ? ` · <span class="dot y"></span>claimed ${eth(q.claimedEth)}` : ''}${q.claimable ? ` · ${Number(q.claimable)} claimable · <a href="#/party/${esc(q.id)}">Claim →</a>` : ''}</strong></div>`).join('');
  const listed = u.statements.filter(p => p.resale && p.resale.seller === addr);
  render(app, `
  <div class="intro"><div><h1>${nameTag(addr)}${you ? ' <span class="muted">· you</span>' : ''}</h1><p class="muted">${esc(addr)}</p></div>
   <p class="muted"><a href="https://etherscan.io/address/${esc(addr)}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a></p></div>
  <div class="stats">
   <div><strong>${u.statements.length}</strong><span>Statements owned</span></div>
   <div><strong>${u.open ? n(u.credits.total) : '—'}</strong><span>Credits</span></div>
   <div><strong>${u.open ? n(u.cards.total) : '—'}</strong><span>Credit Cards</span></div>
   <div><strong>${n(u.pastTotal)}</strong><span>Statements part of</span></div>
  </div>

  <div class="caption"><h2>Statements · ${u.statements.length}</h2>${listed.length ? `<span class="muted">${listed.length} listed for sale</span>` : ''}</div>
  ${u.statements.length ? `<div class="parties" style="margin-bottom:64px">${u.statements.map(p => `
   <a class="party-card" href="#/statement/${esc(p.id)}">
    ${sheet(p)}
    <div class="caption"><span><strong>Statement ${Number(p.assembled.number)}</strong> <span class="muted">${esc(p.name)}</span></span><span class="src">${p.demo ? '<span class="demo">Demo</span> ' : ''}${p.resale ? 'Holder listing' : 'Owned'}</span></div>
    <div class="price-line"><strong>${p.resale ? eth(p.resale.priceEth) : eth(p.sold?.price)}</strong><span class="muted">${p.resale ? 'listed' : 'last sale'}</span></div>
   </a>`).join('')}</div>` : '<p class="muted" style="margin-bottom:64px">No Statements owned.</p>'}

  ${u.open ? `
  <div class="works">
   <section>
    <div class="panel">
     <div class="caption" style="min-height:0;margin-bottom:10px"><h2>Credits · ${n(u.credits.total)}</h2><span class="muted">${n(u.credits.inParties)} in parties · rarest first</span></div>
     ${u.credits.total ? `<div class="thumbs" id="credit-grid">${u.credits.items.map(creditCell).join('')}</div>
     ${u.credits.total > u.credits.items.length ? `<div class="actions"><button type="button" id="more-credits">Show more · ${n(u.credits.total - u.credits.items.length)} left</button></div>` : ''}
     <p class="note">Faded: already in a party.</p>` : '<p class="muted">No Credits.</p>'}
    </div>
    <div class="panel">
     <h2>Could join · ${Number(u.couldJoin.total)}</h2>
     ${u.couldJoin.parties.length ? `<div class="rows">${u.couldJoin.parties.map(q => `<div><span><a href="#/party/${esc(q.id)}">${esc(q.name)}</a> <span class="faint">${Number(q.filled)}/80 · min ${Number(q.minDeposit)}${q.house ? ' · house' : ''}</span></span><strong>${mini(q.sample)} ${Number(q.fit)} qualify · <a href="#/party/${esc(q.id)}">Pick and deposit →</a></strong></div>`).join('')}</div>`
       : `<p class="muted">${u.couldJoin.free ? 'No open party accepts these Credits right now.' : 'No Credits free to deposit.'}</p>`}
    </div>
   </section>
   <section>
    <div class="panel">
     ${u.cards.items.length ? `<details class="cards-box" id="ucards" ${cardsOpen('u') ? 'open' : ''}>
      <summary><h2>Credit Cards · ${n(u.cards.total)}</h2><span class="muted">${n(u.cards.items.filter(c => c.status === 'claimable').length)} claimable · ${n(u.cards.items.filter(c => c.status === 'redeemable').length)} redeemable</span></summary>
      <div class="sim-cards" id="ucards-list" style="margin-top:10px"></div>
      <div class="actions"><button type="button" id="ucards-more" hidden></button></div>
      ${u.cards.total > u.cards.items.length ? `<p class="note">The first ${u.cards.items.length} of ${n(u.cards.total)}.</p>` : ''}
     </details>` : `<h2>Credit Cards · 0</h2><p class="muted">No Credit Cards.</p>`}
    </div>
    <div class="panel">
     <h2>History</h2>
     <div class="caption" style="min-height:0;margin:0 0 8px"><span>Statements part of · ${n(u.pastTotal)}</span></div>
     ${past ? `<div class="rows">${past}</div>` : '<p class="muted">None yet.</p>'}
     <div class="caption" style="min-height:0;margin:24px 0 8px"><span>Credits redeemed · ${n(u.redeemed.total)}</span></div>
     ${u.redeemed.items.length ? `<div class="rows">${u.redeemed.items.map(r => `<div><span>${mini([r.id])} #${Number(r.id)}</span><strong>${r.kind === 'returned' ? 'Returned from' : 'Redeemed from'} <a href="#/party/${esc(r.party)}">${esc(r.name)}</a> · ${ago(r.at)} ago</strong></div>`).join('')}</div>` : '<p class="muted">None recorded.</p>'}
    </div>
   </section>
  </div>` : `
  <div class="panel">
   <h2>History</h2>
   <div class="caption" style="min-height:0;margin:0 0 8px"><span>Statements part of · ${n(u.pastTotal)}</span></div>
   ${past ? `<div class="rows">${past}</div>` : '<p class="muted">None yet.</p>'}
  </div>
  <p class="note" style="margin-top:32px">Credits, Credit Cards and open parties are shown to wallets that hold a Credit or a Credit Card and have agreed to the Rules.${me ? '' : ' Use “Connect wallet” at the top right.'}</p>`}`);
  // Credit Cards: collapsed unless opened; drawn 40 at a time.
  const ub = $('#ucards');
  if (ub) {
    const list = $('#ucards-list'), more = $('#ucards-more'), items = u.cards.items;
    let shown = 0;
    const card = c => `<a class="sim-card" href="#/party/${esc(c.party)}"><img src="${svg(c.credit)}" alt="" loading="lazy"><div><strong>Credit Card</strong><span>No. ${Number(c.card)}</span><span>${esc(c.name)}</span><span>Credit #${Number(c.credit)}</span><span class="${c.status === 'claimable' ? 'you' : c.status === 'claimed' ? 'muted' : ''}">${esc(CARD_STATE[c.status] || c.status)}${c.status === 'claimable' ? ' · ' + eth(c.perCard) : ''}</span></div></a>`;
    const draw = () => { list.append(document.createRange().createContextualFragment(items.slice(shown, shown + 40).map(card).join(''))); shown = Math.min(items.length, shown + 40); more.hidden = shown >= items.length; more.textContent = `Show more · ${items.length - shown} left`; };
    if (ub.open) draw();
    ub.addEventListener('toggle', () => { setCardsOpen('u', ub.open); if (ub.open && !shown) draw(); });
    more.onclick = draw;
  }
  let offset = u.open ? u.credits.items.length : 0;
  $('#more-credits')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api(`users/${addr}/credits?offset=${offset}`);
      offset += r.items.length;
      $('#credit-grid').append(document.createRange().createContextualFragment(r.items.map(creditCell).join('')));
      if (offset >= r.total) b.remove(); else { b.disabled = false; b.textContent = `Show more · ${n(r.total - offset)} left`; }
    } catch (err) { b.disabled = false; b.textContent = err.message; }
  });
}

// Parties require agreeing to the rules and terms once per browser (the wallet also signs the terms at connect).
// Signed in, the server's record is what counts (it rejects every party action without it); the browser flag only
// carries an agreement made before connecting, and is copied to the wallet's record at sign-in.
// Launch and full launch have separate rules (and versions); the flag is kept per version.
const rulesKey = () => 'sm-rules-ok-' + (launchPhase() ? '2026-09-24.L5' : '2026-09-24.4');
const localRules = () => { try { return localStorage.getItem(rulesKey()) === '1'; } catch { return false; } };
const rulesAgreed = () => (me ? !!access.rules : localRules());
async function syncRules() {
  if (me && !access.rules && localRules()) try { await api('rules', { accept: true }); access.rules = true; } catch {}
}
let afterRules = null; // the page asked for before the Rules, to return to after agreeing
const toRules = () => { afterRules = location.hash; location.hash = '#/rules'; };
// Launch phase has its own Rules page, written for the four parties only; the full-launch Rules stay as they are.
function pageRules() { return launchPhase() ? pageRulesLaunch() : pageRulesFull(); }
const agreeRow = () => `<div class="agree"><label class="check"><input type="checkbox" id="rules-ok" ${rulesAgreed() ? 'checked' : ''}> <span>I have read the rules and agree to the <a href="#/terms">terms and conditions</a>.</span></label>
    <button class="cta" id="rules-go" ${rulesAgreed() ? '' : 'disabled'}>${launchPhase() ? 'Continue to The Four →' : 'Continue to parties →'}</button><div class="error" id="rules-err"></div></div>`;
function pageRulesLaunch() {
  const dl = stats?.launchDeadline ? new Date(stats.launchDeadline).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null;
  const rows = [
   ['01 Four parties', 'Four minutes of the Credits mint each produced exactly 80 Credits: 13:49, 15:05, 15:28 and 16:22 UTC on September 21, 2026. Each minute is one party. Only its 80 Credits can be deposited per party.'],
   ['02 Deposit', 'Holders deposit any number of their Credits from that minute. Each deposited Credit returns one Credit Card.'],
   ['03 The card', 'Whoever holds a Credit Card can redeem it for its Credit until the party reaches 80, and receives 1/80 of the sale. Cards can be transferred.'],
   ['04 Order', 'The 80 are arranged in mint order, earliest first. The order cannot be changed.'],
   ['05 Burn', 'Once all 80 are deposited, any card holder can burn them into one Statement. Burning is permanent. Whoever burns pays the gas: about 6–11M gas plus the Statement mint.'],
   ['06 Auction', 'The Statement is sold by auction on Statement Maker. Opening bid: 100 × the Credits floor at the burn. Each bid must be at least 0.1 ETH above the last. The 24-hour clock starts with the first bid. A bid in the last 5 minutes moves the end to 5 minutes after that bid. An outbid bid is returned right away, while the auction is still running. The auction ends only after bidding starts.'],
   ['07 Sold only here', 'A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. The buyer owns it and may resell it anywhere.'],
   ['08 The split', '1% of the sale goes to Statement Maker. Any creator royalty the Statement contract declares, up to 1%, is paid first. The rest goes to card holders, 1/80 per card.'],
   ['09 Deadline', `If a party is not burned by ${dl ? dl : 'its deadline'}, every card can be redeemed for its Credit.`],
   ['10 Preview', 'Until the Statement contract is published, deposits, bids and sales here are recorded by Statement Maker only. Nothing moves on-chain.'],
  ];
  render(app, `
  <div class="intro"><div><h1>Rules</h1><p class="muted">How the four parties work. Read these first.</p></div></div>
  <div class="works no-defs"><div class="rows terms">
   ${rows.map(([h, t]) => `<div><span>${esc(h)}</span><strong>${esc(t)}${h.endsWith(' Burn') ? burnAlert(null) : ''}</strong></div>`).join('')}
   ${agreeRow()}
  </div>
  <div class="rows">
   <div><span>Contract</span><strong><a href="https://etherscan.io/address/0x97630aa70ab14ed9883b41dafccbc11349723043" target="_blank" rel="noopener noreferrer">Credits 0x9763…3043, Ethereum ↗</a></strong></div>
   <div><span>Status</span><strong><span class="demo">Preview</span> · the Statement contract is not published yet · nothing here moves Credits or ETH</strong></div>
  </div></div>`);
  bindRules();
}
function pageRulesFull() {
  render(app, `
  <div class="intro"><div><h1>Rules</h1><p class="muted">How a party works. Read these first.</p></div></div>
  <div class="works no-defs"><div class="rows terms">
   <div><span>01 Open</span><strong>A host opens a party and sets its defaults: which Credits qualify, minimum deposit, default arrangement, default price, voting window, deadline.</strong></div>
   <div><span>02 Deposit</span><strong>Users deposit Credits that match the party’s criteria. Each deposited Credit returns one Credit Card (ERC-721) to the depositor. Depositing accepts the party’s defaults.</strong></div>
   <div><span>03 The card</span><strong>Whoever holds a Credit Card has its vote, can redeem its Credit until the party fills or if it expires, and gets 1/80 of the sale. Credit Cards are ERC-721s and can be transferred. The Statement itself sells only here.</strong></div>
   <div><span>04 Full</span><strong>At 80, redemption closes.</strong></div>
   <div><span>05 Arrange</span><strong>The arrangement is a party setting, Time (mint order) by default. The host picks a preset, each ordering by one stated metric, or Manual, where the host states at creation the metric they will order the 80 by. There is no vote on arrangement.</strong></div>
   <div><span>06 Assemble</span><strong>Arranging and burning are one step. With a preset, any card holder can burn once all 80 are deposited. With Manual, the host burns with their order; if the host has not burned within 1 day of the party filling, any card holder can burn in Time order. The Statement is held by the party and the default price goes live.</strong></div>
   <div><span>07 Host</span><strong>The host can change settings until someone else deposits, order and burn a Manual party, and hand hosting to another address. Nothing else: a host without Credit Cards cannot vote, chat or burn a preset party.</strong></div>
   <div><span>08 Sold only here</span><strong>A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. It sells at the party’s own price; the party contract has no other way to release it. No offers. Each price carries its own wait before buying opens, voted with the price (the host sets the default, 1 hour unless changed). After the sale the buyer owns it outright and may resell anywhere, including in the Statement Maker gallery. The floor is the Statement collection floor once it exists, 80 × the Credits floor until then, as a 24-hour average or the latest reading (the host’s choice).</strong></div>
   <div><span>09 Split</span><strong>1% to Statement Maker, and any creator royalty the Statement contract declares (up to 1%); the rest split across the 80 Credit Cards.</strong></div>
   <div><span>10 Votes</span><strong>1 card = 1 vote, counted as held when the proposal opened. Passes with 41 of 80 yes and zero no. Prices below the floor need 60. After 3 blocked proposals of a kind or 30 days, 54 yes passes it and no is ignored.</strong></div>
   <div><span>11 Time</span><strong>Votes run 1 hour to 7 days. Any card holder executes a passed proposal within 7 days or it lapses.</strong></div>
   <div><span>12 Expire</span><strong>If a party never fills or never assembles, each Credit goes to whoever holds its card.</strong></div>
   <div><span>13 The four</span><strong>The four launch Statements (the Minute parties) sell by auction. Opening bid: 100 × the Credits floor at the burn. The 24-hour timer starts at the first bid; each bid at least 0.1 ETH over the last; a bid in the last 5 minutes moves the end to 5 minutes after it. An outbid bid is returned right away, while the auction is still running.</strong></div>
   <div><span>Gas</span><strong>${burnAlert(null)}</strong></div>
   <div class="agree"><label class="check"><input type="checkbox" id="rules-ok" ${rulesAgreed() ? 'checked' : ''}> <span>I have read the rules and agree to the <a href="#/terms">terms and conditions</a>.</span></label>
    <button class="cta" id="rules-go" ${rulesAgreed() ? '' : 'disabled'}>${launchPhase() ? 'Continue to The Four →' : 'Continue to parties →'}</button><div class="error" id="rules-err"></div></div>
  </div>
  <div class="rows">
   <div><span>Contract</span><strong><a href="https://etherscan.io/address/0x97630aa70ab14ed9883b41dafccbc11349723043" target="_blank" rel="noopener noreferrer">Credits 0x9763…3043, Ethereum ↗</a></strong></div>
   <div><span>Source code</span><strong><a href="https://github.com/yuribeats/statement-maker" target="_blank" rel="noopener noreferrer">github.com/yuribeats/statement-maker ↗</a></strong></div>
   <div><span>Traits</span><strong>Computed by the Credits art contract itself</strong></div>
   <div><span>Rarity</span><strong>Sum of −log2 frequency over Colors, Print, Weight, Eights</strong></div>
   <div><span>Status</span><strong><span class="demo">Preview</span> · the Statement contract is not published yet · nothing here moves Credits or ETH</strong></div>
  </div></div>`);
  bindRules();
}
function bindRules() {
  $('#rules-ok').onchange = async e => {
    const on = e.target.checked;
    try { localStorage.setItem(rulesKey(), on ? '1' : '0'); } catch {}
    $('#rules-go').disabled = true;
    if (me) try { await api('rules', { accept: on }); access.rules = on; $('#rules-err').textContent = ''; } catch (x) { $('#rules-err').textContent = x.message; e.target.checked = !!access.rules; }
    $('#rules-go').disabled = !rulesAgreed(); applyNav();
  };
  $('#rules-go').onclick = () => { if (!rulesAgreed()) return; const to = afterRules && afterRules !== '#/rules' && afterRules !== '#/' ? afterRules : home(); afterRules = null; location.hash = to; };
}

// ---------- terms ----------
// Launch phase has its own terms version; only the rows describing party mechanics differ (TERMS_LAUNCH below).
const termsVer = () => (launchPhase() ? '2026-09-24.L5' : '2026-09-24.5');
const TERMS = [
 ['What Statement Maker is', 'Statement Maker is a tool that lets holders of Credits pool them in groups called parties. When a party collects 80 Credits, the party can burn them to create one Statement and then sell it. Statement Maker provides the website and the smart contracts. It does not hold your Credits or your money; the party contracts do.'],
 ['Not affiliated with Jack Butcher', 'Statement Maker is independent. It is not made, endorsed, or operated by Jack Butcher, jack.art, the Credits project, or X. Credits and Statements are Jack Butcher’s work. We only coordinate holders who choose to use the burn function his contracts provide.'],
 ['How a party works', 'A host opens a party and sets its defaults: eligible Credits, minimum deposit, arrangement, price, voting window and deadline. Each deposited Credit returns one Credit Card; whoever holds a card can redeem its Credit until the party reaches 80. The host can change settings until someone else deposits and hand hosting to another address. Arranging and burning happen in one step: with a preset (Time, mint order, by default) any card holder can burn once all 80 are deposited; with Manual the host burns with an order by the metric they stated, and if the host has not burned within 1 day of the party filling, any card holder can burn in Time order.'],
 ['Burning is permanent', 'Assembly burns all 80 Credits forever. They cannot be restored, withdrawn, or returned after assembly. If a party never fills, or never assembles before its deadline, every Credit goes back to its depositor.'],
 ['Credit Cards', 'A Credit Card is an ERC-721 token, one per deposited Credit. Whoever holds it has that Credit’s vote, the right to redeem the Credit before the Statement is made or if the party expires, and 1/80 of any sale. Credit Cards can be transferred or traded by anyone. They are not a claim on Statement Maker, carry no promise of value, and may end up worth nothing.'],
 ['Voting', 'Every Credit Card is one vote. A proposal passes when more than 40 Credit Cards vote yes and none vote no within its voting window, which lasts 1 hour to 7 days. Any member must then execute it within 7 days or it lapses. A single no vote blocks a proposal, so a party can stay deadlocked and its Statement can go unsold indefinitely.'],
 ['Selling', 'A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. It sells only at the price its members approved, to the first buyer who pays it. There are no offers. After the sale, the buyer owns it and may resell it anywhere. Members may approve any price, including below the floor. A floor-based price can rise automatically but never falls without a new vote. The four launch Statements (the Minute parties) are sold instead by auction: opening bid 100 × the Credits floor at the burn, a 24-hour timer from the first bid, steps of at least 0.1 ETH, and a 5-minute extension for a bid in the last 5 minutes; with no bid within 7 days, the party sells at the opening bid.'],
 ['Fees and gas', 'Each sale pays a 1% Statement Maker fee, and any creator royalty the Statement contract declares (up to 1%); the rest goes to Credit Card holders, 1/80 per card. Every action on-chain (depositing, voting, executing, assembling, claiming) costs gas, paid by whoever calls it. Statement Maker does not refund gas.'],
 ['Risks', 'The Statement contract has not been published; it may work differently from what this site assumes, or may not accept parties at all. Prices can fall. Transactions cannot be reversed. If you lose access to your wallet, nobody can recover your Credits, Credit Cards, or proceeds. Laws about tokens like Credit Cards may change or differ where you live.'],
 ['No advice', 'Nothing on this site is financial, investment, legal, or tax advice. You decide what to deposit, how to vote, and whether to sell.'],
 ['Your wallet is you', 'Your wallet address is your identity here. You alone keep your wallet, keys and seed phrase safe. Anything done from your wallet counts as done by you, whether you authorized it or not. Statement Maker cannot access your wallet, recover lost keys, or reverse a transaction. If you think your wallet is compromised, stop using it and secure it; Statement Maker is not responsible for unauthorized use of it.'],
 ['Your responsibilities', 'You confirm you are of legal age and legally allowed to use this service where you live; that you are not in a sanctioned or embargoed country or on any sanctions list, and do not act for anyone who is; and that you will handle your own taxes and legal obligations. If you use Statement Maker for a company, DAO or other wallet, you confirm you may bind it to these terms. You will not use Statement Maker to manipulate votes, prices, or other members, and you will not use what you know before it is public on-chain (such as a coming deposit, vote, burn or price) to trade ahead of others. Do not promote Credit Cards or Statements as investments.'],
 ['Preview', 'Statement Maker is in preview until the Statement contract is published. Deposits, votes, sales and claims shown here are recorded by Statement Maker only; nothing moves Credits or ETH on-chain yet.'],
 ['The code controls', 'Statement Maker’s contracts are non-custodial and run on their own once deployed. Statement Maker never holds your Credits, Credit Cards, Statements, ETH or keys, and does not broker, match, route, clear or settle anything: every transaction is between your wallet and the contracts. Statement Maker is not an exchange, broker, money transmitter or fiduciary. Where the contracts and these terms differ, the deployed contract code controls. Your wallet shows each transaction before you sign it; by signing you confirm you reviewed and understood it. You can use the contracts without this site.'],
 ['Automatic outcomes', 'By depositing you consent to everything the contracts do by their rules, including actions other members trigger: minting and burning Credit Cards, returning Credits, the burn of all 80, executing a passed price, a sale to the first buyer who pays, fees, and claims. Transactions are final. Statement Maker cannot stop, change or undo them.'],
 ['Members act for themselves', 'Hosts, members, card holders and buyers each act on their own behalf. A party is not a partnership, joint venture, company or fund, and joining one creates no duty of care or trust between members, or between any member and Statement Maker. A host is not Statement Maker’s agent. Voting is a technical mechanism, not a management right.'],
 ['Things outside our control', 'Statement Maker depends on systems it does not run: Ethereum, Jack Butcher’s Credits and Statement contracts, wallets, RPC providers, third-party price sources, and the floor-price signer. Any of them can fail, change, be attacked or become incompatible. Statement Maker is not responsible for failed, stuck, delayed, reordered or front-run transactions (including MEV), gas costs, network congestion, forks, or other users acting maliciously.'],
 ['Collectibles, not investments', 'Credits, Credit Cards and Statements are collectibles, not investments, securities or financial products, and nothing here is an offer to sell one. Floors, prices, rarity and other data on this site are for information only and may be wrong or out of date. Nobody promises that a buyer, market or price will ever exist. You may lose everything you put in.'],
 ['Public by design', 'Your wallet address, holdings and every on-chain action are public and permanent. Statement Maker shows party activity, profiles and ENS names publicly and cannot delete what is on-chain.'],
 ['No warranties', 'Statement Maker, its site and its contracts are experimental and provided as is and as available, without warranties of any kind, including merchantability, fitness for a purpose, title and non-infringement. Statement Maker does not promise the site or contracts will work without interruption, errors, bugs or exploits, or as expected.'],
 ['Limit of liability', 'To the fullest extent the law allows, Statement Maker and the people who build and run it are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, assets or data, arising from your use of the site or contracts. Their total liability for any claim is limited to the lesser of 100 US dollars or the fees you paid Statement Maker in the 12 months before the claim.'],
 ['Indemnity', 'You will cover Statement Maker and the people who build and run it against claims, losses and costs (including reasonable legal fees) that come from your use or misuse of the service, your breach of these terms or the law, or your infringement of anyone else’s rights.'],
 ['Site access and changes', 'Statement Maker may change, suspend or restrict the site, or block access where the law requires or these terms are broken. That cannot touch your assets in the contracts. These terms may change; you will be asked to accept any new version before your next action. If one part of these terms is unenforceable, the rest still applies.'],
];
const TERMS_LAUNCH = {
 'How a party works': 'There are four parties, one for each of the four minutes of the Credits mint that produced exactly 80 Credits. Only a minute’s own 80 Credits can be deposited into its party. Each deposited Credit returns one Credit Card; whoever holds a card can redeem it for its Credit until the party reaches 80. The 80 are arranged in mint order, earliest first, and the order cannot be changed. Once all 80 are deposited, any card holder can burn them into one Statement.',
 'Voting': 'There are no price votes. The Statement is sold only by auction, and each Credit Card receives 1/80 of the winning bid.',
 'Credit Cards': 'A Credit Card is an ERC-721 token, one per deposited Credit. Whoever holds it has the right to redeem the Credit before the Statement is made or if the party expires, and 1/80 of the sale. Credit Cards can be transferred by anyone. They are not a claim on Statement Maker, carry no promise of value, and may end up worth nothing.',
 'Selling': 'A party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker, by auction: the opening bid is 100 × the Credits floor at the burn, each bid must be at least 0.1 ETH above the last, the 24-hour clock starts with the first bid, and a bid in the last 5 minutes moves the end to 5 minutes after that bid. An outbid bid is returned right away, while the auction is still running. After the sale, the buyer owns it and may resell it anywhere.',
 'Members act for themselves': 'Members, card holders, bidders and buyers each act on their own behalf. A party is not a partnership, joint venture, company or fund, and joining one creates no duty of care or trust between members, or between any member and Statement Maker. Voting is a technical mechanism, not a management right.',
 'Burning is permanent': 'Assembly burns all 80 Credits forever. They cannot be restored, withdrawn, or returned after assembly. If a party does not reach 80 by its deadline, every card can be redeemed for its Credit.',
};
const termsRows = () => (launchPhase() ? TERMS.map(([h, t]) => [h, TERMS_LAUNCH[h] || t]) : TERMS);
const termsBody = () => `<div class="rows terms">${termsRows().map(([h, t], i) => `<div><span>${String(i + 1).padStart(2, '0')} ${esc(h)}</span><strong>${esc(t)}</strong></div>`).join('')}</div>`;
function pageTerms() {
  render(app, `
  <div class="intro"><div><h1>Terms and conditions</h1><p class="muted">Version ${termsVer()}</p></div></div>
  <div style="max-width:900px">${termsBody()}</div>`);
}
// Connecting a wallet opens the terms as a scrollable modal over the site. Accepting is required to connect.
function openTermsModal(address, mode = 'sim') {
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  render(root, `
  <div class="modal-back" id="mb">
   <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <div class="modal-head"><h2 id="mt">Terms and conditions</h2><span class="muted">Connecting ${nameTag(address)} · version ${termsVer()}</span></div>
    <div class="modal-body" id="mbody">
     <p class="muted" style="margin-bottom:18px">Read to the end to continue.</p>
     ${termsBody()}
    </div>
    <div class="modal-foot">
     <label class="check"><input type="checkbox" id="agree" disabled> <span>I have read these terms. I understand that deposits lock at 80, that assembly burns my Credits permanently, that a single no vote can block a sale, and that Credit Cards may be worth nothing. I accept these terms.</span></label>
     <div class="actions" style="margin-top:14px;align-items:center"><button class="cta" id="accept" disabled style="margin-top:0">${mode === 'wallet' ? 'Sign and connect' : 'Accept and connect (simulated)'}</button><button type="button" id="decline">Cancel</button><span class="hint" id="scroll-hint">Scroll to the end to enable the checkbox</span></div>
     <div class="error" id="t-err"></div>
    </div>
   </div>
  </div>`);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  const body = $('#mbody');
  const atEnd = () => body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
  const unlock = () => { if (atEnd()) { $('#agree').disabled = false; $('#scroll-hint').textContent = ''; } };
  body.addEventListener('scroll', unlock); unlock();
  $('#mb').addEventListener('click', e => { if (e.target.id === 'mb') close(); });
  $('#agree').onchange = e => { $('#accept').disabled = !e.target.checked; };
  $('#decline').onclick = close;
  $('#accept').onclick = async () => {
    try {
      let who;
      if (mode === 'wallet') {
        // Your wallet signs a sign-in message whose statement is this acceptance; the server verifies the signature.
        const { nonce, message } = await api('auth/nonce', { address });
        const signature = await Wallets.sign(message, address);
        who = (await api('auth/verify', { nonce, message, signature })).address;
      } else {
        who = (await api('auth/dev', { address, accept: $('#agree').checked })).address;
      }
      close(); await setMe(who);
      if (!location.hash.replace(/^#\/?/, '')) location.hash = home(); // signed in from the landing: continue into the site
    } catch (e) { $('#t-err').textContent = e.message; }
  };
  $('#agree').focus?.();
}

// ---------- gate ----------
function pageGate(page, arg) {
  render(app, `
  <div class="intro"><div><h1>For Credit holders</h1><p class="muted">Parties are open to wallets that hold a Credit or a Credit Card.</p></div></div>
  <div class="works"><div class="rows terms">
   <div><span>Parties</span><strong>${me ? `Connected: ${meName()} holds 0 Credits. Parties need a wallet holding a Credit.` : 'Connect a wallet that holds at least one Credit to start or join a party.'}</strong></div>
   <div><span>Starting a party</span><strong>You must hold a Credit, and open the party by depositing at least its minimum number of Credits that meet the criteria you set.</strong></div>
   <div><span>Without a Credit</span><strong>You can view and buy Statements, read the rules, and try the simulation.</strong></div>
  </div>
  <div><div class="actions">${me ? switchBtn : '<button type="button" class="cta" data-switch-wallet style="margin:0">Connect wallet</button>'}<a class="cta" href="#/statements" style="margin:0">View Statements →</a></div></div></div>
  ${page === 'party' && arg ? '<div class="panel" id="log" style="margin-top:64px;max-width:900px"></div>' : ''}`);
  if (page === 'party' && arg) logPanel(arg, $('#log'));
}

// ---------- statements ----------
// The real Statement image comes from Jack's Statement contract, which is not public yet.
// Until then this renders the 80 Credits in their approved order, as jack.art previews a Statement.
async function statementPNG(p) {
  const order = p.credits, W = 1600, H = 2000, pad = W * 0.08, cw = (W - pad * 2) / 8, ch = (H - pad * 2) / 10;
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  await Promise.all(order.map((c, i) => new Promise(ok => {
    const img = new Image(); img.onload = () => { const s = Math.min(cw, ch); g.drawImage(img, pad + (i % 8) * cw + (cw - s) / 2, pad + Math.floor(i / 8) * ch + (ch - s) / 2, s, s); ok(); }; img.onerror = ok; img.src = svg(c.id);
  })));
  const a = Object.assign(document.createElement('a'), { href: cv.toDataURL('image/png'), download: `statement-${p.assembled.number}.png` }); a.click();
}
// Every listing looks the same whatever its source; only a small label differs.
const SOURCE = { party: 'Party sale', holder: 'Holder listing', opensea: 'Listing' };
function listingCard(it, byId) {
  const p = byId[it.id];
  const pic = p ? sheet(p) : `<div class="frame statement os-frame"><span>Statement ${esc(it.number)}</span></div>`;
  const opens = it.opensAt && it.source !== 'opensea' ? (it.source === 'party' ? it.opensAt - Date.now() : 0) : 0;
  const href = it.source === 'opensea' ? esc(it.url) : `#/statement/${esc(it.id)}`;
  return `
   <a class="party-card" href="${href}" ${it.source === 'opensea' ? 'target="_blank" rel="noopener noreferrer"' : ''}>
    ${pic}
    <div class="caption"><span><strong>Statement ${esc(it.number)}</strong> <span class="muted">${esc(it.name)}</span></span><span class="src">${it.demo ? '<span class="demo">Demo</span> ' : ''}${SOURCE[it.source]}</span></div>
    <div class="price-line"><strong>${eth(it.priceEth)}</strong><span class="muted">${opens > 0 ? 'Opens in ' + hrs(opens) : 'Buy →'}</span></div>
   </a>`;
}
const statementCard = p => `
   <a class="party-card" href="#/statement/${esc(p.id)}">
    ${sheet(p)}
    <div class="caption"><span><strong>Statement ${Number(p.assembled.number)}</strong> <span class="muted">${esc(p.name)}</span></span><span class="src">${p.demo ? '<span class="demo">Demo</span> ' : ''}${p.sold ? 'Owned' : 'Party'}</span></div>
    <div class="price-line"><strong>${p.sold ? eth(p.sold.price) : '—'}</strong><span class="muted">${p.sold ? 'last sale' : 'not listed'}</span></div>
   </a>`;
async function pageStatements() {
  const [list, market] = await Promise.all([api('statements'), api('market')]);
  const byId = Object.fromEntries(list.map(p => [p.id, p]));
  const sort = partyUI.gsort || 'price';
  const items = [...market.items].sort({ price: (a, b) => a.priceEth - b.priceEth, high: (a, b) => b.priceEth - a.priceEth, new: (a, b) => (b.opensAt || 0) - (a.opensAt || 0) }[sort]);
  const listedIds = new Set(items.filter(i => i.source !== 'opensea').map(i => i.id));
  const others = list.filter(p => !listedIds.has(p.id));
  const mine = me ? list.filter(p => p.owner === me || p.members.some(m => m.address === me)) : [];
  const grid = arr => `<div class="parties" style="margin-bottom:64px">${arr.join('')}</div>`;
  render(app, `
  <div class="intro"><div><h1>Statements</h1><p class="muted">Everything for sale in one place.</p></div><p class="muted">${list.length} made · ${items.length} for sale${(() => { const live = items.filter(i => !(i.source !== 'opensea' && i.opensAt > Date.now())); return live.length ? ` · <strong>Floor ${eth(Math.min(...live.map(i => i.priceEth)))}</strong>` : ''; })()}</p></div>
  <div class="caption"><h2>For sale · ${items.length}</h2><div class="modes">${[['price', 'Price ↑'], ['high', 'Price ↓'], ['new', 'Newest']].map(([k, l]) => `<button type="button" data-gsort="${k}" aria-pressed="${sort === k}">${l}</button>`).join('')}</div></div>
  ${items.length ? grid(items.map(i => listingCard(i, byId))) : '<p class="muted" style="margin-bottom:64px">Nothing for sale right now.</p>'}
  ${stats?.dev && market.sources.opensea !== 'ok' ? `<p class="note" style="margin:-48px 0 48px">Dev · OpenSea listings: ${esc(market.sources.opensea)}.</p>` : ''}
  ${others.length ? `<div class="caption"><h2>Not for sale · ${others.length}</h2></div>${grid(others.map(statementCard))}` : ''}
  ${mine.length ? `<div class="caption"><h2><span class="dot y"></span>Yours · ${mine.length}</h2></div>${grid(mine.map(statementCard))}` : ''}`);
  app.querySelectorAll('[data-gsort]').forEach(b => b.onclick = () => { partyUI.gsort = b.dataset.gsort; route(); });
}
async function pageStatement(id) {
  const p = await api('parties/' + encodeURIComponent(id));
  if (!p.assembled) { location.hash = '#/party/' + encodeURIComponent(id); return; }
  const mine = p.members.find(m => m.address === me);
  render(app, `
  <div class="intro"><div><h1>Statement ${Number(p.assembled.number)}</h1><p class="muted">${esc(p.name)} · assembled ${new Date(p.assembled.at).toLocaleDateString()}</p></div><a href="#/party/${esc(p.id)}" class="muted">Party page →</a></div>
  <div class="works">
   <section>
    ${sheet(p)}
    <div class="caption"><span>Statement ${Number(p.assembled.number)}</span><div class="modes"><button type="button" id="png">PNG ↓</button></div></div>
    <p class="note">Preview from the approved order. The final image comes from the Statement contract once Jack publishes it.</p>
   </section>
   <section><div class="rows">
    <div><span>Party</span><strong>${esc(p.name)}</strong></div>
    <div><span>Credits</span><strong>80, burned ${new Date(p.assembled.at).toLocaleString()}</strong></div>
    <div><span>Order</span><strong>${esc(p.orderSource === 'Manual' ? 'Manual, by the host' : arrLabel({ preset: p.orderSource }))}</strong></div>
    <div><span>Assembled by</span><strong>${userLink(p.assembled.by)}</strong></div>
    <div><span>Held by</span><strong>${p.sold ? userLink(p.owner) + (p.owner === me ? ' (you)' : '') : 'The party vault · ' + p.members.length + ' Credit Card holders'}</strong></div>
    ${mine ? `<div><span>You</span><strong><span class="dot y"></span>${Number(mine.count)} of 80 Credit Cards · ${(mine.count / 80 * 100).toFixed(2)}%</strong></div>` : ''}
    <div><span>Price</span><strong>${p.sold ? 'Sold for ' + eth(p.sold.price) : p.listing ? priceLabel(p.listing) + ' · ' + eth(p.listingEth) + ' · ' + vsFloor(p.listingEth, p.floorEth) : 'Not listed'}</strong></div>
    <div><span>Floor</span><strong>${eth(p.floorEth)}</strong></div>
   </div>
   ${p.sold && p.resale ? `<div class="buy-box">
     <div class="caption" style="min-height:0"><h2>Buy · holder listing</h2><strong class="big">${eth(p.resale.priceEth)}</strong></div>
     <p class="muted">Listed by ${userLink(p.resale.seller)}. 1% to Statement Maker, the rest to the seller.</p>
     ${me === p.resale.seller ? `<button type="button" id="unlist">Cancel your listing</button>` : me ? `<button class="cta" id="buy-r">Buy Statement ${Number(p.assembled.number)} for ${eth(p.resale.priceEth)}</button> <span class="faint">Preview · no ETH moves</span>` : connectAct}
     <div class="error" id="buy-r-err"></div></div>` : ''}
   ${p.sold && p.owner === me && !p.resale ? `<div class="buy-box">
     <h2 style="margin-bottom:10px">List it for sale</h2>
     <p class="muted">You own Statement ${Number(p.assembled.number)}. List it here at a fixed price; buyers pay the price, you receive it less 1%. You may also sell anywhere else.</p>
     <div class="actions"><input id="lp" type="number" step="0.01" min="0" value="${p.sold.price.toFixed(2)}" style="width:110px;border:0;border-bottom:1px solid var(--line)"> ETH <button class="cta" id="list" style="margin:0">List</button></div>
     <div class="error" id="list-err"></div></div>` : ''}
   ${!p.sold && p.listing ? `<div class="buy-box">
     <div class="caption" style="min-height:0"><h2>Buy</h2><strong class="big">${eth(p.listingEth)}</strong></div>
     <p class="muted">1% to Statement Maker, then ${eth(p.listingEth * 0.99 / SLOTS)} to each of the 80 Credit Cards.</p>
     ${p.buyOpensAt > p.now ? `<p class="muted">Buying opens in ${hrs(p.buyOpensAt - p.now)}.</p>` : me ? `<button class="cta" id="buy-s">Buy Statement ${Number(p.assembled.number)} for ${eth(p.listingEth)}</button> <span class="faint">Preview · no ETH moves</span>` : connectAct}
     <div class="error" id="buy-s-err"></div></div>` : ''}
   <h2 style="margin:48px 0 14px">Holders</h2>
   <table class="table"><tbody>${p.members.map(m => `<tr><td>${m.address === me ? '<span class="dot y"></span>' : ''}${userLink(m.address)}</td><td style="text-align:right">${Number(m.count)}</td></tr>`).join('')}</tbody></table>
   </section>
  </div>`);
  $('#png').onclick = () => statementPNG(p);
  const sAct = async (path, body, errId) => { try { await api(`statements/${encodeURIComponent(p.id)}/${path}`, body); route(); } catch (e) { $('#' + errId).textContent = e.message; } };
  $('#buy-r')?.addEventListener('click', () => sAct('buy', { maxPriceEth: p.resale.priceEth }, 'buy-r-err'));
  $('#unlist')?.addEventListener('click', () => sAct('unlist', {}, 'buy-r-err'));
  $('#list')?.addEventListener('click', () => sAct('list', { priceEth: Number($('#lp').value) }, 'list-err'));
  $('#buy-s')?.addEventListener('click', async () => { try { await api(`parties/${encodeURIComponent(p.id)}/buy`, {}); route(); } catch (e) { $('#buy-s-err').textContent = e.message; } });
}

// ---------- definitions: hovering a field label shows what it means ----------
const DEFS = {
  'name': 'What the party is called. Shown on its page and on every Credit Card.',
  'description': 'What this Statement is about, in your words. Up to 1,000 characters.',
  'minimum deposit': 'The fewest Credits one person can add at a time. The last slots are exempt so the party can always reach exactly 80.',
  'deadline, days': 'How long the party has to fill and burn. If it misses the deadline, every Credit goes back to whoever holds its card.',
  'vote window': 'How long a price vote stays open by default. Anyone proposing can pick 1 hour, 24 hours, 48 hours, 72 hours or 7 days.',
  'default arrangement': 'The order of the 80 Credits in the 8 × 10 sheet. Time (mint order) by default. A preset is checked by the contract at the burn; Manual means the host arranges by hand by a metric they state.',
  'arrangement': 'The order of the 80 Credits in the 8 × 10 sheet, set by the host when the party opened.',
  'arranged by': 'The metric that orders the 80 Credits in the 8 × 10 sheet, set by the host when the party opened.',
  'floor reference': 'Which floor this party uses: the average of the last 24 hours (harder to move with one cheap listing) or the latest reading.',
  'default price': 'What the Statement sells for once it is made, unless card holders vote a different price.',
  'colors': 'Which of the four ink plates (cyan, magenta, yellow, black) show on a Credit. Set by the payment second.',
  'print': 'Registration: Registered means the plates line up; Nudge, Slip, Skew, Drift and Loose are increasingly misregistered.',
  'weight': 'How much of the grid is inked: sparse, lean, even or extreme.',
  'eights': 'How many 8s appear in the X Money transaction ID. More eights are rarer.',
  'shifted plates': 'For misregistered Credits: which ink plates moved off register.',
  'shift size': 'The largest distance any plate moved, in squares (1 or 2).',
  'rarity rank ≤': 'Keep only Credits at or above this rarity. 1 is the rarest of all 122,154.',
  'ink (marks)': 'How many squares are inked, from 16 to 160.',
  'token number': 'The Credit number. Lower numbers were paid for earlier.',
  'status': 'Where the party is: open (filling), full (ready to burn), assembled (Statement made), sold, or expired.',
  'filled': 'Credits deposited so far, out of 80.',
  'hosts': 'Who runs the party. The host sets the defaults (until someone else deposits), orders and burns Manual parties, and can hand hosting on. Nothing else.',
  'eligible credits': 'Which Credits this party accepts, and how many exist in total.',
  'sale split': 'Where the sale money goes: 1% to Statement Maker, the rest in 80 equal shares, one per Credit Card.',
  'defaults': 'Settings the host chose when opening the party. They apply automatically.',
  'you': 'How many of this party’s 80 Credit Cards your connected wallet holds.',
  'floor': 'The reference price for a Statement: the Statement collection floor once it exists, 80 × the Credits floor until then. Prices below it need 60 of 80 votes.',
  'buy wait, hours': 'How long after a price goes live before anyone can buy it. The host sets the default; each price vote can set its own.',
  'buy wait': 'How long after a price goes live before anyone can buy it. The host sets the default; each price vote can set its own.',
  'open': 'Opening a party: the host sets the defaults and makes the first deposit.',
  'the card': 'A Credit Card is the token you get for each Credit you deposit. Whoever holds it owns that Credit\u2019s vote and share.',
  'full': 'The moment the 80th Credit arrives. Deposits and redemptions stop.',
  'arrange': 'Choosing the order of the 80 Credits in the 8 × 10 Statement. Only the host arranges.',
  'assemble': 'The burn: the 80 Credits become one Statement, held by the party until it sells.',
  'sold only here': 'Where a party can sell its Statement: only through Statement Maker, at its own price.',
  'split': 'How sale money is divided: 1% fee, the rest equally across the 80 Credit Cards.',
  'votes': 'How price decisions pass: 1 card = 1 vote; 41 yes and no no; 60 below the floor.',
  'time': 'How long votes stay open, and how long a passed vote can wait to be executed.',
  'expire': 'What happens if a party runs out of time: every Credit goes back to whoever holds its card.',
  'contract': 'The Credits contract on Ethereum that every party works with.',
  'source code': 'Statement Maker\u2019s code, public on GitHub.',
  'traits': 'Colors, print, weight and eights, read directly from the Credits art contract.',
  'rarity': 'How rare a Credit is: the sum of how uncommon each of its four traits is.',
  'deposit': 'Adding Credits to a party. Each one returns a Credit Card.',
  'approved price': 'The price in force now, set by the host default or by a vote.',
};
function addDefs(root = app) {
  root.querySelectorAll('.field > label, .rows > div > span:first-child').forEach(el => {
    if (el.closest('.no-defs')) return; // the Rules page explains itself
    const k = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^\d\d /, '');
    const d = DEFS[k] || DEFS[k.split(' · ')[0]];
    if (d) { el.dataset.def = d; el.tabIndex = 0; }
  });
}
new MutationObserver(() => addDefs()).observe(app, { childList: true, subtree: true });

// ---------- launch phase: only the four Minute parties, until one of them makes its Statement ----------
// While stats.partiesUnlocked is false the site shows The Four instead of the parties list, a Minute page per party,
// and hides starting parties and the Credits lookup. The full-launch pages above stay as they are and return by themselves.
const launchPhase = () => !stats?.partiesUnlocked;
const home = () => (launchPhase() ? '#/four' : '#/parties');
// Nav: launch or full-launch links, party links only after the Rules agreement, Profile only when signed in.
function applyNav() {
  const l = launchPhase(), ok = !me || rulesAgreed(); // view only (no wallet) may read every page
  document.querySelectorAll('header nav [data-nav]').forEach(a => {
    a.hidden = (a.dataset.phase && a.dataset.phase !== (l ? 'launch' : 'full')) || (a.hasAttribute('data-gated') && !ok) || (a.id === 'nav-profile' && !me);
  });
}
const applyPhase = applyNav;
// GET /api/launch is cached on the CDN for 30 s; after this tab changes something, ask for a fresh copy.
async function launchData() {
  const L = await api('launch' + (launchBust ? '?t=' + launchBust : ''));
  if (stats && stats.partiesUnlocked !== L.unlocked) { stats.partiesUnlocked = L.unlocked; applyPhase(); }
  const A = i => (i >= 0 ? L.addrs[i] : null);
  for (const m of L.minutes) m.cells = m.cells.map(c => ({ id: c.id, owner: A(c.o), in: !!c.d, holder: c.d ? A(c.h) : null, get who() { return this.in ? this.holder : this.owner; } }));
  return L;
}
const minuteKey = m => m.time.replace(':', '');
const minuteTitle = m => `${esc(m.time)} UTC · #${Number(m.from)}–${Number(m.to)}`;
const minuteState = m => ({ OPEN: 'Open', FULL: 'Full · ready to burn', ASSEMBLED: `Statement ${Number(m.assembled?.number)}${m.auction && !m.auction.settled ? (m.auction.highEth != null ? ' · auction, high bid ' + ethx(m.auction.highEth) : ' · auction opens at ' + ethx(m.auction.reserveEth)) : ''}`, SOLD: `Statement ${Number(m.assembled?.number)} · sold`, EXPIRED: 'Expired' }[m.status] || esc(m.status || '—'));
const LAUNCH_NOTE = 'Four minutes of the Credits mint produced exactly 80 Credits each. Each can become one Statement if its holders deposit.';

async function pageFour() {
  const L = await launchData();
  render(app, `
  <div class="intro"><div><h1>The Four</h1><p class="muted">${LAUNCH_NOTE}</p></div><p class="muted">Synced to block ${Number(L.syncedBlock).toLocaleString()}</p></div>
  <div class="four">${L.minutes.map(m => `
   <a class="party-card" href="#/minute/${minuteKey(m)}">
    <div class="frame statement">${m.cells.map(c => `<span class="${c.in ? '' : 'out'}${me && c.who === me ? ' mine' : ''}"><img src="${svg(c.id)}" alt="" loading="lazy"></span>`).join('')}</div>
    <div class="bar" aria-label="${Number(m.filled)} of 80"><i style="width:${m.filled / SLOTS * 100}%"></i></div>
    <div class="caption"><span><strong>${minuteTitle(m)}</strong></span><span>${Number(m.filled)}/80</span></div>
    <div class="caption" style="margin-top:-14px"><span class="muted">${n(m.holders)} holders · ${minuteState(m)}</span><span>Open →</span></div>
   </a>`).join('')}</div>
  <div class="panel lookup" id="lookup"></div>`);
  lookupBox($('#lookup'), L);
}

// "Is my wallet in?": an address or ENS name → which of the 320 Credits it holds (as Credits, or as Credit Cards).
function lookupBox(el, L) {
  render(el, `<h2>Is my wallet in?</h2>
   <div class="compose" style="margin-top:0"><textarea id="lk" rows="1" placeholder="0x… or name.eth">${esc(me || '')}</textarea><button type="button" id="lk-go">Check</button></div>
   <div id="lk-out" style="margin-top:12px"></div>`);
  const out = $('#lk-out', el);
  const go = async () => {
    let q = $('#lk', el).value.trim().toLowerCase();
    if (!q) return render(out, '');
    render(out, '<p class="muted">Checking…</p>');
    if (!isAddress(q)) {
      try { q = (await api('users/' + encodeURIComponent(q))).address; } catch (e) { return render(out, `<p class="error">${esc(e.message)}</p>`); }
    }
    const rows = L.minutes.map(m => ({ m, cs: m.cells.filter(c => c.who === q) })).filter(r => r.cs.length);
    render(out, rows.length
      ? `<p style="margin-bottom:8px">${userLink(q)} holds ${n(rows.reduce((s, r) => s + r.cs.length, 0))} of the 320.</p><div class="rows">${rows.map(({ m, cs }) => `<div><span><a href="#/minute/${minuteKey(m)}">${esc(m.time)} UTC</a></span><strong>${cs.length} · ${cs.filter(c => c.in).length} deposited · ${cs.slice(0, 8).map(c => '#' + Number(c.id)).join(' ')}${cs.length > 8 ? ' …' : ''} · <a href="#/minute/${minuteKey(m)}">Open →</a></strong></div>`).join('')}</div>`
      : `<p class="muted">${userLink(q)} holds none of the 320 Credits from the four minutes.</p>`);
  };
  $('#lk-go', el).onclick = go;
  $('#lk', el).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  if (me) go();
}

// A Minute party: the 8×10 grid in Time order is the page. Each cell: the Credit, its number, who holds it, and
// whether it is in the party. Your own cells can be picked and deposited here; the rest of the party (burn, price
// votes, buying, claims, chat) is the regular party page's panels, drawn underneath.
async function pageMinute(key) {
  const L = await launchData();
  const m = L.minutes.find(x => minuteKey(x) === key);
  if (!m || !m.party) return render(app, `<div class="intro"><div><h1>No such minute</h1><p class="muted"><a href="#/four">The Four →</a></p></div></div>`);
  const open = m.status === 'OPEN', remaining = SLOTS - m.filled;
  const free = me && open ? m.cells.filter(c => !c.in && c.owner === me) : [];
  const freeIds = new Set(free.map(c => c.id));
  for (const id of [...partyUI.picks]) if (!freeIds.has(id)) partyUI.picks.delete(id);
  const mineAll = me ? m.cells.filter(c => c.who === me) : [];
  const hold = new Map();
  for (const c of m.cells) { const a = c.who; if (!a) continue; const r = hold.get(a) || hold.set(a, { a, n: 0, d: 0 }).get(a); r.n++; if (c.in) r.d++; }
  const holders = [...hold.values()].sort((x, y) => y.n - x.n || y.d - x.d);
  const cell = c => `<div class="mcell${c.in ? '' : ' out'}${me && c.who === me ? ' mine' : ''}">
    <button type="button" data-cell="${Number(c.id)}" aria-pressed="${partyUI.picks.has(c.id)}" aria-label="Credit ${Number(c.id)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>
    <span class="l">#${Number(c.id)}</span><span class="l o">${c.who ? userLink(c.who) : '—'}</span><span class="l s">${c.in ? 'In the party' : 'Not yet'}</span></div>`;
  render(app, `
  <div class="intro"><div><h1>Minute ${esc(m.time)} UTC</h1><p class="muted">#${Number(m.from)}–${Number(m.to)} · ${Number(m.filled)}/80 in the party · ${n(m.holders)} holders · ${minuteState(m)}</p></div><a href="#/" class="muted">← The Four</a></div>
  <div class="bar" style="margin-bottom:16px"><i style="width:${m.filled / SLOTS * 100}%"></i></div>
  <div class="mgrid" id="mgrid">${m.cells.map(cell).join('')}</div>
  <div class="caption"><span class="muted">Mint order, earliest first: how the Statement will be laid out. <span class="key-in">In the party</span> · <span class="key-out">not yet</span>${me ? ' · <span class="dot y"></span>yours' : ''}</span></div>
  <div class="detail" id="mdetail"><span class="faint">—</span><span class="muted">Select a Credit.</span></div>
  <div class="works" style="margin-top:48px">
   <section>
    ${open ? `<div class="panel">
     <h2>Deposit</h2>
     ${!me ? connectAct
       : !free.length ? `<p class="alert-k">${meName()} holds ${mineAll.length ? 'no undeposited Credits' : 'none of these 80'}.</p><div class="actions">${switchBtn}</div>`
       : `<p class="muted">${meName()} holds ${free.length} of these 80 not yet deposited. Tap yours on the grid (marked yellow) to pick.</p>
       <div class="actions"><button type="button" id="m-all">Select all mine</button><button type="button" id="m-none">Clear</button></div>
       <div class="fee-box"><strong>Fee: 1%.</strong> When the Statement sells, Statement Maker keeps 1% of the price. Each of the 80 Credit Cards receives 1/80 of the other 99%. Example: a 3 ETH sale pays 0.03 ETH to Statement Maker and 0.037125 ETH per card.</div>
       <label class="check" style="margin:12px 0"><input type="checkbox" id="m-ack"> <span>I understand that this party cannot list, sell, offer or auction its Statement on OpenSea or any other marketplace. It sells only on Statement Maker. It sells at the party’s price, and <strong>Statement Maker takes a 1% fee on that sale</strong>. The other 99% is split equally across the 80 Credit Cards.</span></label>
       <button class="cta" id="m-deposit" disabled>Deposit</button> ${cost('deposit')} each`}
     <div class="error" id="m-err"></div>
     <p class="note">Each Credit deposited returns one Credit Card. Until all 80 are in, the card’s holder can redeem it for that Credit. At 80, any card holder can burn them into the Statement, in mint order.</p>
    </div>` : ''}
    <div class="panel" id="lookup"></div>
   </section>
   <section>
    <div class="panel">
     <h2>Holders · ${holders.length}</h2>
     <table class="table"><thead><tr><th>Holder</th><th style="text-align:right">Of the 80</th><th style="text-align:right">Deposited</th></tr></thead><tbody>${holders.map(h => `<tr><td>${h.a === me ? '<span class="dot y"></span>' : ''}${userLink(h.a)}</td><td style="text-align:right">${h.n}</td><td style="text-align:right">${h.d}</td></tr>`).join('')}</tbody></table>
    </div>
   </section>
  </div>
  <div id="more" style="margin-top:48px"></div>
  <div class="panel" id="log" style="margin-top:48px;max-width:900px"></div>`);

  const byCell = new Map(m.cells.map(c => [c.id, c]));
  const detail = c => render($('#mdetail'), `<img src="${svg(c.id)}" alt="Credit ${Number(c.id)}"><div class="rows">
    <div><span>Credit</span><strong>#${Number(c.id)} · slot ${m.cells.indexOf(c) + 1} of 80</strong></div>
    <div><span>${c.in ? 'Card holder' : 'Owner'}</span><strong>${c.who ? userLink(c.who) : '—'}</strong></div>
    <div><span>Status</span><strong>${c.in ? 'In the party' : 'Not yet deposited'}${freeIds.has(c.id) ? ' · yours · ' + (partyUI.picks.has(c.id) ? 'picked' : 'tap to pick') : ''}</strong></div></div>`);
  const depState = () => {
    const b = $('#m-deposit'); if (!b) return;
    const k = partyUI.picks.size;
    b.textContent = `Deposit ${k} Credit${k === 1 ? '' : 's'}`;
    b.disabled = !($('#m-ack').checked && k >= 1 && k <= remaining);
  };
  $('#mgrid').addEventListener('click', e => {
    const b = e.target.closest('[data-cell]'); if (!b) return;
    const id = Number(b.dataset.cell), c = byCell.get(id);
    if (freeIds.has(id)) { partyUI.picks.has(id) ? partyUI.picks.delete(id) : partyUI.picks.add(id); b.setAttribute('aria-pressed', partyUI.picks.has(id)); depState(); }
    else { $('#mgrid').querySelectorAll('[aria-pressed=true]').forEach(x => { if (!freeIds.has(Number(x.dataset.cell))) x.setAttribute('aria-pressed', 'false'); }); b.setAttribute('aria-pressed', 'true'); }
    detail(c);
  });
  $('#m-all')?.addEventListener('click', () => { partyUI.picks = new Set(free.slice(0, remaining).map(c => c.id)); route(); });
  $('#m-none')?.addEventListener('click', () => { partyUI.picks.clear(); route(); });
  $('#m-ack')?.addEventListener('change', depState);
  $('#m-deposit')?.addEventListener('click', async () => {
    const picks = [...partyUI.picks];
    try { await api(`parties/${encodeURIComponent(m.party)}/deposit`, { ids: picks, storeOnly: $('#m-ack').checked }); partyUI.picks.clear(); route(); }
    catch (e) { $('#m-err').textContent = e.message; }
  });
  depState();
  lookupBox($('#lookup'), L);
  logPanel(m.party, $('#log'));
  // The regular party panels (your cards, burn, price votes, buy, claim, chat). Hidden when the party page is not
  // readable by this wallet (after launch, unassembled parties are for Credit holders).
  pageParty(m.party, { root: $('#more') }).catch(() => render($('#more'), ''));
}

// ---------- deploy check: a tab left open across a deploy reloads itself instead of running stale code ----------
let build = null;
async function checkBuild() {
  try { const { build: b } = await api('version'); if (build && b !== build) location.reload(); build = b; } catch {}
}
checkBuild(); setInterval(checkBuild, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkBuild(); });

// ---------- router ----------
let lastParty = null;
async function route() {
  const [, page, arg] = location.hash.replace(/^#?\/?/, '#/').split('/');
  // A bare URL opens "#/". Not signed in, "#/" is the landing: the name and Connect wallet, nothing else. After
  // connecting (and accepting the terms) it continues to the Rules, then The Four (or the parties list after launch).
  if (!location.hash) { location.replace('#/'); return; }
  // The bare URL is always the landing: the name with Connect wallet and View only, or Enter and Log out when signed in.
  const bare = !page;
  document.body.classList.toggle('bare', bare);
  if (bare) { clearInterval(auctionTick); return render(app, `<div class="landing"><h1>Statement Maker</h1>${me ? `<a class="cta" href="${home()}">Enter</a><button type="button" class="view-only" id="land-out">Log out</button>` : '<button type="button" class="cta" id="land-connect">Connect wallet</button><button type="button" class="view-only" id="view-only">View only</button>'}</div>`), $('#view-only') && ($('#view-only').onclick = () => { try { sessionStorage.setItem(VIEW_KEY, '1'); } catch {} location.hash = home(); }), $('#land-connect') && ($('#land-connect').onclick = async () => { await connectWallet(); if (me && !document.querySelector('#modal-root .modal')) location.hash = home(); }), $('#land-out') && ($('#land-out').onclick = async () => { await Wallets.disconnect(); await signOut(); route(); }); }
  applyPhase();
  const launch = launchPhase();
  // Launch phase: a Minute party's generic page opens as its Minute page.
  if (launch && page === 'party' && /^minute-\d{4}$/.test(arg || '')) { location.replace('#/minute/' + arg.slice(7)); return; }
  const navKey = launch && (page === 'four' || page === 'minute') ? 'four' : page === 'party' ? 'parties' : page;
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', a.dataset.nav === navKey));
  const uiKey = page === 'party' || page === 'minute' ? page + '/' + arg : null;
  if (!uiKey || uiKey !== lastParty) partyUI = freshUI();
  lastParty = uiKey;
  try {
    // Launch phase: The Four (home, after the rules) and the Minute pages are public; starting parties, the parties
    // list, other party pages and the Credits lookup open after the first Statement.
    // Party pages (The Four, Minute and party pages, Start a party, Credits) need the Rules agreement first.
    // View-only visitors (no wallet) read them without it; every action needs a wallet, then the agreement.
    if (me && ['minute', 'party', 'new', 'wallet', 'four', 'parties'].includes(page) && !rulesAgreed()) return toRules();
    if (page === 'minute') return await pageMinute(arg);
    if (launch && !['four', 'minute', 'rules', 'terms', 'statements', 'statement'].includes(page)) { location.replace('#/'); return; }
    if (page === 'four' && !launch) { location.replace('#/parties'); return; }
    if (page === 'parties' && launch) { location.replace('#/four'); return; }
    if (page === 'four') return await pageFour();
    // Parties are for Credit holders. Without a Credit or Credit Card: Rules, Statements and Terms only.
    const gated = page === 'parties' || page === 'new' || page === 'wallet' || page === 'party';
    if (gated && me && !rulesAgreed()) return toRules();
    if (gated && !access.canParty && !(page === 'party' && (await api('parties/' + encodeURIComponent(arg)).catch(() => null))?.assembled)) return pageGate(page, arg);
    if (page === 'party') await pageParty(arg);
    else if (page === 'new') await pageNew();
    else if (page === 'wallet') await pageWallet(arg);
    else if (page === 'u') await pageUser(arg);
    else if (page === 'rules') pageRules();
    else if (page === 'terms') pageTerms();
    else if (page === 'statements') await pageStatements();
    else if (page === 'statement') await pageStatement(arg);
    else await pageParties();
  } catch (e) { render(app, `<p class="error">${esc(e.message)}</p>`); }
}
window.addEventListener('hashchange', route);
Promise.all([api('auth/me').then(async m => { me = m.address && m.terms ? m.address : ''; access = m; await syncRules(); }), api('stats').then(x => (stats = x))]).then(async () => { const a = await Wallets.restore(CHAIN); const w = Wallets.wallet(); if (w) try { chainNow = Number(await w.provider.request({ method: 'eth_chainId' })) || CHAIN; } catch {} if (me && a && a !== me) { await api('auth/logout', {}).catch(() => {}); me = ''; access = await api('auth/me').catch(() => access); } }).then(() => Promise.all([navProfile(), fillActing(), api('gas').then(g => (gasInfo = g)).catch(() => {})])).then(route);
