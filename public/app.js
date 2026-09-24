// Statement Maker — front end. Hash routes, no framework.
// All user-supplied strings go through esc() before render().
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const render = (el, s) => el.replaceChildren(document.createRange().createContextualFragment(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => a ? esc(String(a).slice(0, 6) + '…' + String(a).slice(-4)) : '—';
const eth = n => n == null ? '—' : (+n).toFixed(n >= 10 ? 1 : 3) + ' ETH';
const svg = id => `/api/svg/${Number(id)}`;
const hrs = ms => ms <= 0 ? '0h' : ms < 36e5 ? Math.ceil(ms / 6e4) + 'm' : Math.ceil(ms / 36e5) + 'h';
const ago = t => { const s = (Date.now() - t) / 1e3; return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
const SLOTS = 80;
const api = async (path, body) => {
  const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
let stats = null;
let me = ''; // set from the server session (GET /api/auth/me), never from local state

// ---------- wallet: real sign-in with a browser wallet; simulated wallets only in dev builds ----------
async function fillActing() {
  const sel = $('#acting');
  const real = !!window.ethereum;
  const top = stats?.dev ? await api('holders') : [];
  const seen = new Set();
  const sims = top.filter(o => o.address !== me && !seen.has(o.address) && seen.add(o.address));
  render(sel,
    (me ? `<option value="${esc(me)}" selected>${short(me)}</option><option value="__off">Disconnect</option>` : '<option value="" selected>Connect wallet</option>') +
    (real && !me ? '<option value="__wallet">Browser wallet…</option>' : '') +
    (!real && !me && !stats?.dev ? '<option value="" disabled>No wallet found in this browser</option>' : '') +
    (stats?.dev ? '<optgroup label="Simulated wallets (dev)">' + sims.map(o => `<option value="${esc(o.address)}">${short(o.address) + ' · ' + Number(o.count)}</option>`).join('') + '<option value="__paste">Paste address…</option></optgroup>' : ''));
}
$('#acting').addEventListener('change', async e => {
  let v = e.target.value;
  if (v === '__off') { await api('auth/logout', {}); setMe(''); return; }
  if (v === '__wallet') {
    try {
      const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      fillActing(); openTermsModal(account.toLowerCase(), 'wallet');
    } catch { fillActing(); }
    return;
  }
  if (v === '__paste') { v = (prompt('Wallet address') || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(v)) { fillActing(); return; } }
  if (v) { fillActing(); openTermsModal(v, 'sim'); }
});
function setMe(v) { me = v; fillActing(); route(); }
const hex = str => '0x' + [...new TextEncoder().encode(str)].map(b => b.toString(16).padStart(2, '0')).join('');

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
const priceOf = (t, floorEth) => t.mode === 'fixed' ? t.value : floorEth == null ? null : t.mode === 'floorPct' ? floorEth * (1 + t.value / 100) : floorEth + t.value;
const priceLabel = t => esc(t.mode === 'fixed' ? `${t.value} ETH` : `Floor ${t.value < 0 ? '−' : '+'} ${Math.abs(t.value)}${t.mode === 'floorPct' ? '%' : ' ETH'}`);
const vsFloor = (eth, floorEth) => { if (eth == null || !floorEth) return ''; const d = (eth / floorEth - 1) * 100; return `<span class="${d < 0 ? 'blocked' : 'muted'}">${Math.abs(d).toFixed(0)}% ${d < 0 ? 'below' : 'above'} floor</span>`; };
let gasInfo = null;
const cost = key => { if (!gasInfo?.gwei || !gasInfo.units[key]) return ''; const e = gasInfo.units[key] * gasInfo.gwei / 1e9; return `<span class="faint">~${(gasInfo.units[key] / 1e6 >= 1 ? (gasInfo.units[key] / 1e6).toFixed(1) + 'M' : Math.round(gasInfo.units[key] / 1e3) + 'k')} gas · $${(e * gasInfo.ethUsd).toFixed(2)}</span>`; };
const hint = t => `<div class="hint">${esc(t)}</div>`;
const n = x => Number(x).toLocaleString();
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
    draft = { name: i.label === 'Any Credit' ? '' : i.label, minDeposit: 1, days: 14, voteHours: 48, arrangement: { preset: 'Rarity' }, target: { mode: 'floorPct', value: 25 }, filters: { ...i.filters } };
    location.hash = '#/new';
  });
}

const freshUI = () => ({ mode: 'sheet', selected: null, order: null, preset: null, picks: new Set() });
let partyUI = freshUI();
async function pageParty(id) {
  const p = await api('parties/' + encodeURIComponent(id));
  const isHost = p.hosts.includes(me), isMember = p.members.some(m => m.address === me), isArranger = p.arranger === me;
  const myTokens = p.members.find(m => m.address === me)?.count || 0;
  const myCards = me ? p.credits.filter(c => c.depositor === me).sort((a, b) => a.card - b.card) : [];
  const order = partyUI.mode === 'arrange' && partyUI.order ? partyUI.order : p.credits;
  const sel = order.find(c => c.id === partyUI.selected) || null;
  const wallet = me && p.status === 'OPEN' ? await api('wallet/' + me) : [];
  const remaining = SLOTS - p.credits.length, minDep = Math.min(p.params.minDeposit, remaining);
  const eligibleMine = wallet.filter(c => !c.deposited && matchesClient(c, p.params.filters));

  render(app, `
  <div class="intro"><div><h1>${esc(p.name)}</h1>${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}<p class="muted">${p.status === 'OPEN' ? `${remaining} slots open · closes in ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 864e5))} days` : p.status === 'FULL' ? 'Full · arranging the 80' : esc(p.status)}${p.demo ? ' · <span class="demo">Demo data</span>' : ''}</p></div><div style="text-align:right"><a href="#/" class="muted">← All parties</a>${stats?.dev ? `<div><button type="button" id="skip" class="faint" title="Prototype only: move the clock forward">Dev · skip 24h</button></div>` : ''}</div></div>
  <div class="works">
   <section aria-label="Statement">
    ${sheet(p, { interactive: true, order, selected: partyUI.selected })}
    <div class="caption">
     <span>${partyUI.mode === 'arrange' ? 'Arranging' + (partyUI.preset ? ' · ' + esc(partyUI.preset) : '') : 'Statement'} · ${p.credits.length}/80</span>
     <div class="modes">
      <button type="button" data-mode="sheet" aria-pressed="${partyUI.mode === 'sheet'}">Sheet</button>
      ${p.status === 'FULL' ? `<button type="button" data-mode="arrange" aria-pressed="${partyUI.mode === 'arrange'}">Arrange</button>` : ''}
     </div>
    </div>
    ${partyUI.mode === 'arrange' ? `
     <div class="panel">
      <p class="muted">In force: ${p.orderSource === 'vote' ? 'the voted order' : p.orderSource === 'arranger' ? 'the arranger’s order (' + esc(p.orderPreset) + ')' : 'the host default (' + esc(arrLabel(p.params.arrangement)) + ')'}. ${isArranger ? 'You are the arranger: auto-order or drag to swap, then save. It takes effect at once.' : 'Auto-order or drag to swap, then submit as a challenge. It needs a vote to replace the arranger’s order.'} ${isArranger ? `You are the ${p.arrangerElected ? 'elected' : 'default'} arranger.` : `Only the ${p.arrangerElected ? 'elected' : 'default'} arranger ${short(p.arranger)} can submit. Anyone can preview.`}${p.arrangerElected ? '' : ' The host arranges unless members elect someone else.'}</p>
      <div class="modes" style="margin:10px 0">${Object.keys(PRESETS).map(k => `<button type="button" data-preset="${k}" aria-pressed="${(partyUI.preset || '').startsWith(k)}">${k}</button>`).join('')}</div>
      ${isMember ? `<button class="cta" id="submit-order">${isArranger ? 'Save order' : 'Challenge with this order'}</button>` : ''}
      <div class="error" id="arr-err"></div>
     </div>` : ''}
    <div class="detail">${sel ? `<img src="${svg(sel.id)}" alt="Credit ${Number(sel.id)}"><div class="rows">
      <div><span>Credit</span><strong>#${Number(sel.id)}</strong></div>
      <div><span>Colors · Print</span><strong>${esc(sel.colors)} · ${esc(sel.register || sel.print)}</strong></div>
      <div><span>Weight · Eights</span><strong>${esc(sel.weight)} · ${Number(sel.eights)} (${esc(sel.tier)})</strong></div>
      <div><span>Rarity · Depositor</span><strong>#${sel.rank.toLocaleString()} · ${short(sel.depositor)}</strong></div></div>`
      : `<span class="faint">—</span><span class="muted">Select a Credit on the sheet.</span>`}</div>
   </section>

   <section>
    <div class="panel">
     <h2>Party</h2>
     <div class="rows">
      <div><span>Status</span><strong>${esc(p.status)}</strong></div>
      <div><span>Filled</span><strong>${p.credits.length} / 80</strong></div>
      <div style="border:0;padding:0">${filled(p)}</div>
      <div><span>Hosts</span><strong>${p.hosts.map(short).join(', ')}</strong></div>
      <div><span>Eligible Credits</span><strong>${filterText(p.params.filters)} · ${p.eligible.toLocaleString()}</strong></div>
      <div><span>Vote window</span><strong>${Number(p.params.voteHours || 48)} hours default</strong></div>
      <div><span>Minimum deposit</span><strong>${Number(p.params.minDeposit)}</strong></div>
      <div><span>Default price</span><strong>${targetText(p.params.target)}${p.params.target.mode !== 'fixed' ? ' · now ' + eth(p.targetEth) : ''}${p.defaultBelowFloor ? ' · <span class="blocked">below floor</span>' : ''}</strong></div>
      <div><span>Default arrangement</span><strong>${esc(arrLabel(p.params.arrangement))}${p.status === 'FULL' || p.assembled ? ' · in force: ' + (p.orderSource === 'vote' ? 'voted order' : p.orderSource === 'arranger' ? 'arranger’s ' + esc(p.orderPreset) : 'default') : ''}</strong></div>
      <div><span>Defaults</span><strong class="muted">Set by the host. They run automatically unless card holders vote to change them.</strong></div>
      <div><span>Floor (80 × Credit floor)</span><strong>${eth(p.floorEth)}</strong></div>
      ${p.listing ? `<div><span>Approved price</span><strong>${priceLabel(p.listing)} · ${eth(p.listingEth)} · ${vsFloor(p.listingEth, p.floorEth)}</strong></div>` : ''}
      <div><span>Sale split</span><strong>Artist royalty · 1% Statement Maker · rest to the 80 Credit Cards</strong></div>
      ${isMember ? `<div><span>You</span><strong><span class="dot y"></span>${myTokens} of 80 Credit Cards</strong></div>` : ''}
     </div>
    </div>

    ${myCards.length ? `
    <div class="panel">
     <h2>Your Credit Cards · ${myCards.length}</h2>
     <p class="muted" style="margin-bottom:10px">One card per Credit. The card is the vote, the claim on its Credit before the Statement is made, and 1/80 of the sale. Whoever holds it has all three.</p>
     <div class="cards">${myCards.map(c => `<figure><img src="/api/card/${Number(c.card)}.svg" alt="Credit Card ${Number(c.card)}" loading="lazy"><figcaption class="actions">
       ${c.claimed ? '<span class="muted">Redeemed</span>' : `<button type="button" data-send="${Number(c.card)}">Send</button>`}
       ${!c.claimed && (p.status === 'OPEN' || p.status === 'EXPIRED') ? `<button type="button" data-wd="${Number(c.id)}">Redeem for Credit #${Number(c.id)}</button>` : ''}
       ${!c.claimed && p.status === 'SOLD' ? `<button type="button" data-claim="${Number(c.card)}">Claim ${eth(p.perCard)}</button>` : ''}
     </figcaption></figure>`).join('')}</div>
     <div class="actions" id="send-row" hidden><span class="muted">Send card <span id="send-no"></span> to</span><input id="send-to" placeholder="0x…" style="width:340px;border:0;border-bottom:1px solid var(--line)"><button type="button" id="send-go">Send</button><button type="button" id="send-x">Cancel</button></div>
     ${p.status === 'SOLD' && myCards.some(c => !c.claimed) ? `<div class="actions"><button type="button" class="cta" id="claim-all">Claim all · ${eth(p.perCard * myCards.filter(c => !c.claimed).length)}</button></div>` : ''}
     <div class="error" id="card-err"></div>
    </div>` : ''}

    ${p.status === 'ASSEMBLED' && p.listing ? `
    <div class="panel"><h2>Buy</h2>
     <div class="rows"><div><span>Price</span><strong>${eth(p.listingEth)} · ${vsFloor(p.listingEth, p.floorEth)}</strong></div><div><span>Split</span><strong>Artist royalty · 1% Statement Maker · ${eth(p.listingEth ? p.listingEth * 0.99 / SLOTS : null)} per Credit Card</strong></div></div>
     ${p.buyOpensAt > p.now ? `<p class="muted">Buying opens in ${hrs(p.buyOpensAt - p.now)}. ${p.listing.source === 'default' ? 'Default price from the host.' : 'Price set by vote.'}</p>` : me ? `<button class="cta" id="buy">Buy Statement ${Number(p.assembled.number)} for ${eth(p.listingEth)}</button> <span class="faint">Preview · no ETH moves · royalty 0 until the Statement contract is known</span>` : '<p class="muted">Connect a wallet to buy.</p>'}
     <div class="error" id="buy-err"></div></div>` : ''}
    ${p.status === 'SOLD' ? `
    <div class="panel"><h2>Sold</h2><div class="rows">
     <div><span>Price</span><strong>${eth(p.sold.price)} to ${short(p.sold.buyer)}</strong></div>
     <div><span>Artist royalty</span><strong>${eth(p.sold.royalty)}</strong></div>
     <div><span>Statement Maker 1%</span><strong>${eth(p.sold.fee)}</strong></div>
     <div><span>Per Credit Card</span><strong>${eth(p.perCard)}</strong></div>
     <div><span>Claimed</span><strong>${p.credits.filter(c => c.claimed).length} / 80 cards</strong></div></div></div>` : ''}

    ${p.status === 'OPEN' ? `
    <div class="panel">
     <h2>Deposit</h2>
     ${!me ? `<p class="muted">Choose a wallet under “Acting as”.</p>` : `
       <p class="muted">${short(me)} holds ${wallet.length} Credit${wallet.length === 1 ? '' : 's'} · ${eligibleMine.length} eligible here · minimum ${minDep}</p>
       <div class="picker">${wallet.slice(0, 200).map(c => { const ok = !c.deposited && matchesClient(c, p.params.filters); return `<button type="button" data-pick="${Number(c.id)}" ${ok ? '' : 'disabled'} aria-pressed="${partyUI.picks.has(c.id)}" title="#${Number(c.id)} ${esc(c.colors)} ${esc(c.print)} ${esc(c.weight)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>`; }).join('')}</div>
       <div class="actions"><button type="button" id="pick-all">Select eligible</button><button type="button" id="pick-none">Clear</button></div>
       <button class="cta" id="deposit">Deposit ${partyUI.picks.size || ''}</button> ${cost('deposit')} each
       ${isMember ? `<button type="button" id="withdraw" class="muted" style="margin-left:18px">Redeem all my cards</button>` : ''}`}
     <div class="error" id="dep-err"></div>
     <p class="note">Depositing accepts this party's defaults: ${esc(arrLabel(p.params.arrangement))} arrangement, ${targetText(p.params.target)} price. Each Credit you deposit returns one Credit Card. Until the party fills, the card's holder can redeem it for that Credit.</p>
    </div>` : ''}

    ${p.status === 'EXPIRED' ? `
    <div class="panel"><h2>Expired</h2>
     ${p.returned ? `<p class="muted">${Number(p.returned.count)} Credits returned to their card holders by ${short(p.returned.by)}.</p>` : `<p class="muted">The party did not finish in time. Each Credit goes to whoever holds its card. Any member can send them all.</p>${isMember ? `<div class="actions"><button type="button" class="cta" id="return">Return all Credits</button> ${cost('returnCredit')} per Credit</div>` : ''}`}
     <div class="error" id="ret-err"></div></div>` : ''}
    ${p.status !== 'OPEN' && p.status !== 'EXPIRED' ? `
    <div class="panel" id="proposals">
     <div class="caption" style="min-height:0;margin-bottom:10px"><h2>Proposals</h2><button type="button" id="rules-t" class="muted">${partyUI.rules ? 'Hide rules' : 'How votes work'}</button></div>
     ${partyUI.rules ? `<div class="rules-box">
      <div><span>Weight</span><strong>1 Credit Card = 1 vote, counted as held when the proposal opened</strong></div>
      <div><span>Passes</span><strong>41 of 80 yes and zero no</strong></div>
      <div><span>Below floor</span><strong>60 of 80 yes and zero no</strong></div>
      <div><span>Deadlock</span><strong>After 3 blocked proposals of a kind or 30 days, 54 yes passes it; no is ignored</strong></div>
      <div><span>Window</span><strong>24 hours to 7 days, chosen by the proposer</strong></div>
      <div><span>Execute</span><strong>Any card holder, within 7 days of passing, or it lapses</strong></div></div>` : ''}
     ${p.status === 'FULL' && p.orderApproved ? (() => { const wait = p.assemblyOpensAt - p.now; const arrVote = p.proposals.some(q => q.type === 'APPROVE_ARRANGEMENT' && !q.executed && !q.superseded && !q.closed); const ready = wait <= 0 && !arrVote; return `<div class="prop"><div class="prop-head"><strong>Assemble</strong><span class="chip ${ready ? 'pass' : 'open'}">${ready ? 'Ready' : arrVote ? 'Waiting for arrangement vote' : 'Opens in ' + hrs(wait)}</span></div><p class="muted">Uses the ${p.orderSource === 'vote' ? 'voted' : p.orderSource === 'arranger' ? 'arranger’s (' + esc(p.orderPreset) + ')' : 'default (' + esc(arrLabel(p.params.arrangement)) + ')'} order. Once open, any card holder can burn the 80 into the Statement; the default price then goes live. Preview until the Statement contract is public.</p>${isMember && ready ? `<div class="actions"><button type="button" class="cta" id="assemble">Assemble</button> ${cost('assemble')}</div>` : ''}</div>`; })() : ''}
     ${p.assembled ? `<div class="prop"><div class="prop-head"><strong>Statement ${Number(p.assembled.number)}</strong><a href="#/statement/${esc(p.id)}">View →</a></div><p class="muted">Assembled by ${short(p.assembled.by)}</p></div>` : ''}
     ${[...p.proposals].reverse().map(q => {
       const mine = q.votes?.[me];
       const canVote = isMember && !q.executed && !q.closed && !q.superseded && (q.snapshot ? q.snapshot[me] > 0 : true);
       const state = q.executed ? ['Executed', 'done'] : q.superseded ? ['Superseded', 'muted'] : q.lapsed ? ['Lapsed', 'muted'] : q.executable ? ['Passed · execute', 'pass'] : q.no && !q.override ? ['Blocked by no', 'blocked'] : q.closed ? ['Failed', 'muted'] : q.passing ? ['Passing', 'pass'] : ['Voting', 'open'];
       const what = q.type === 'NOMINATE_ARRANGER' ? `Make ${short(q.args.address)} the arranger` : q.type === 'APPROVE_ARRANGEMENT' ? `Approve the 8 × 10 order · ${esc(q.args.preset)}` : q.type === 'LIST' ? `Sell for ${eth(priceOf(q.args, p.floorEth))} <span class="faint">(${priceLabel(q.args)})</span> ${vsFloor(priceOf(q.args, p.floorEth), p.floorEth)}` : q.type === 'CANCEL_LISTING' ? 'Cancel the listing' : esc(q.type);
       return `
      <div class="prop s-${state[1]}">
       <div class="prop-head"><span><span class="faint">#${Number(q.id)}</span> <strong>${esc({ NOMINATE_ARRANGER: 'Arranger', APPROVE_ARRANGEMENT: 'Arrangement', LIST: 'Price', CANCEL_LISTING: 'Cancel listing' }[q.type] || q.type)}</strong></span><span class="chip ${state[1]}">${state[0]}</span></div>
       <p class="prop-what">${what}</p>
       <div class="meter" title="Pass line at ${Number(q.need)} cards">
        <i class="yes" style="width:${q.yes / SLOTS * 100}%"></i><b style="left:${q.need / SLOTS * 100}%"></b>
       </div>
       <div class="prop-nums"><span>Yes ${q.yes} / ${Number(q.need)} needed${q.below ? ' · below floor' : ''}${q.override ? ' · deadlock rule' : ''}</span><span class="${q.no ? 'blocked' : 'faint'}">No ${q.no}${q.override && q.no ? ' (ignored)' : ''}</span></div>
       <div class="prop-foot">
        <span class="faint">${short(q.by)} · ${ago(q.at)} ago · ${q.executed ? 'executed by ' + short(q.executedBy) : q.closed ? (q.executable ? 'execute within ' + hrs(q.execBy - p.now) : 'closed') : 'closes in ' + hrs(q.endsAt - p.now)}</span>
        <span class="actions" style="margin:0">
         ${mine !== undefined ? `<span class="you">You voted ${mine ? 'yes' : 'no'}</span>` : ''}
         ${canVote ? `<button type="button" data-vote="${Number(q.id)}" data-yes="1" class="${mine === true ? 'on' : ''}">Yes</button><button type="button" data-vote="${Number(q.id)}" data-yes="0" class="${mine === false ? 'on no' : ''}">No</button>` : ''}
         ${q.type === 'APPROVE_ARRANGEMENT' ? `<button type="button" data-preview="${Number(q.id)}">Preview</button>` : ''}
         ${isMember && q.executable ? `<button type="button" class="cta" data-exec="${Number(q.id)}" style="margin:0">Execute</button>` : ''}
        </span>
       </div>
      </div>`; }).join('') || '<p class="muted">No proposals yet.</p>'}

     ${isMember ? `
     <div class="composer">
      <div class="caption" style="min-height:0"><h2>New proposal</h2><div class="modes">${(p.status === 'FULL' ? ['price', 'arranger'] : ['price']).map(k => `<button type="button" data-ptype="${k}" aria-pressed="${(partyUI.ptype || 'price') === k}">${k === 'price' ? 'Price' : 'Arranger'}</button>`).join('')}</div></div>
      ${(partyUI.ptype || 'price') === 'price' ? `
       <div class="field"><label>Price</label><div><div style="display:flex;gap:12px;align-items:center"><select id="pm"><option value="fixed">ETH</option><option value="floorEth">Floor ± ETH</option><option value="floorPct">Floor ± %</option></select><input id="pv" type="number" step="0.01" value="${p.floorEth ? (p.floorEth * 1.1).toFixed(2) : 1}" style="width:110px"><span id="pp" class="muted"></span></div><div class="hint" id="ph"></div></div></div>`
      : `<div class="field"><label>Arranger</label><div><select id="nominee">${p.members.map(m => `<option value="${esc(m.address)}">${short(m.address)} · ${Number(m.count)} cards</option>`).join('')}</select><div class="hint">Must hold a Credit Card. Replaces the ${p.arrangerElected ? 'elected' : 'default'} arranger ${short(p.arranger)}.</div></div></div>`}
      <div class="field"><label>Voting window</label><div><select id="win">${[24, 48, 72, 168].map(h => `<option value="${h}" ${h === (p.params.voteHours || 48) ? 'selected' : ''}>${h < 168 ? h + ' hours' : '7 days'}</option>`).join('')}</select><div class="hint">Range: 24 hours – 7 days</div></div></div>
      <div class="actions" style="margin-top:12px"><button type="button" class="cta" id="${(partyUI.ptype || 'price') === 'price' ? 'propose-price' : 'nominate'}" style="margin:0">Propose</button> ${cost('propose')} <span class="hint">Your yes vote is cast automatically.</span></div>
     </div>` : `<p class="note">Only Credit Card holders can propose and vote.</p>`}
     <div class="error" id="vote-err"></div>
    </div>` : ''}

    <div class="panel">
     <h2>Card holders · ${p.members.length}</h2>
     <table class="table"><tbody>${p.members.slice(0, 30).map(m => `<tr><td>${m.address === me ? '<span class="dot y"></span>' : ''}${short(m.address)}${m.host ? ' <span class="muted">host</span>' : ''}${m.address === p.arranger ? ` <span class="muted">arranger${p.arrangerElected ? '' : ' (default)'}</span>` : ''}</td><td style="text-align:right">${Number(m.count)}</td></tr>`).join('')}</tbody></table>
    </div>

    <div class="panel">
     <h2>Chat</h2>
     <div class="chat" id="chat">${p.chat.map(m => `<div class="msg"><span class="muted">${short(m.address)} · ${ago(m.at)}</span><p>${esc(m.text)}</p></div>`).join('') || '<p class="muted" style="padding:10px 0">Quiet.</p>'}</div>
     ${isMember || isHost ? `<div class="compose"><textarea id="say" rows="1" placeholder="Say something"></textarea><button type="button" id="send">Send</button></div>` : `<p class="note">Credit Card holders and hosts can post.</p>`}
     <div class="error" id="chat-err"></div>
    </div>
   </section>
  </div>`);

  const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  const err = (id, e) => { const el = $('#' + id); if (el) el.textContent = e.message || e; };
  const act = async (path, body, errId) => { try { await api(`parties/${encodeURIComponent(p.id)}/${path}`, body); await route(); return true; } catch (e) { err(errId, e); return false; } };

  app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { partyUI.mode = b.dataset.mode; if (partyUI.mode === 'arrange' && !partyUI.order) partyUI.order = [...p.credits]; route(); });
  app.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { partyUI.order = PRESETS[b.dataset.preset](partyUI.order || p.credits); partyUI.preset = b.dataset.preset + (partyUI.order.seed ? ' #' + partyUI.order.seed : ''); route(); });
  const sheetEl = $('#sheet');
  sheetEl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { partyUI.selected = Number(b.dataset.id); route(); } });
  if (partyUI.mode === 'arrange') {
    sheetEl.classList.add('dragging');
    let from = null;
    sheetEl.addEventListener('dragstart', e => { from = Number(e.target.closest('button')?.dataset.i); });
    sheetEl.addEventListener('dragover', e => { e.preventDefault(); sheetEl.querySelectorAll('.over').forEach(x => x.classList.remove('over')); e.target.closest('button')?.classList.add('over'); });
    sheetEl.addEventListener('drop', e => {
      e.preventDefault(); const to = Number(e.target.closest('button')?.dataset.i);
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) { const o = [...partyUI.order]; [o[from], o[to]] = [o[to], o[from]]; partyUI.order = o; partyUI.preset = (partyUI.preset || 'Custom').replace(/ · edited$/, '') + ' · edited'; route(); }
    });
  }
  $('#submit-order')?.addEventListener('click', () => act('arrange', { order: partyUI.order.map(c => c.id), preset: partyUI.preset || 'Deposit order', hours: $('#win')?.value }, 'arr-err'));
  app.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const id = Number(b.dataset.pick); partyUI.picks.has(id) ? partyUI.picks.delete(id) : partyUI.picks.add(id); b.setAttribute('aria-pressed', partyUI.picks.has(id)); $('#deposit').textContent = 'Deposit ' + (partyUI.picks.size || ''); });
  $('#pick-all')?.addEventListener('click', () => { partyUI.picks = new Set(eligibleMine.slice(0, remaining).map(c => c.id)); route(); });
  $('#pick-none')?.addEventListener('click', () => { partyUI.picks.clear(); route(); });
  $('#deposit')?.addEventListener('click', async () => { const picks = [...partyUI.picks]; partyUI.picks.clear(); if (!await act('deposit', { ids: picks }, 'dep-err')) partyUI.picks = new Set(picks); });
  $('#withdraw')?.addEventListener('click', () => act('withdraw', {}, 'dep-err'));
  app.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => act('vote', { proposal: b.dataset.vote, yes: b.dataset.yes === '1' }, 'vote-err'));
  app.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => { const q = p.proposals.find(x => x.id === Number(b.dataset.preview)); const m = new Map(p.credits.map(c => [c.id, c])); partyUI.mode = 'arrange'; partyUI.order = q.args.order.map(id => m.get(id)); partyUI.preset = 'Proposal ' + q.id; route(); });
  const pricePreview = () => {
    const t = { mode: $('#pm').value, value: +$('#pv').value }; const e = priceOf(t, p.floorEth);
    render($('#pp'), `= ${eth(e)} ${vsFloor(e, p.floorEth)}`);
    $('#ph').textContent = t.mode === 'fixed' ? 'Range: above 0 ETH' : t.mode === 'floorPct' ? 'Range: above −100% (floor ' + eth(p.floorEth) + ')' : 'Range: above −' + eth(p.floorEth) + ' (floor ' + eth(p.floorEth) + ')';
  };
  if ($('#pm')) { $('#pm').onchange = pricePreview; $('#pv').oninput = pricePreview; pricePreview(); }
  $('#propose-price')?.addEventListener('click', () => act('propose', { type: 'LIST', hours: $('#win')?.value, args: { mode: $('#pm').value, value: +$('#pv').value } }, 'vote-err'));
  app.querySelectorAll('[data-exec]').forEach(b => b.onclick = () => act('execute', { proposal: b.dataset.exec }, 'vote-err'));
  $('#skip')?.addEventListener('click', async () => { await api('dev/advance', { hours: 24 }); route(); });
  $('#rules-t')?.addEventListener('click', () => { partyUI.rules = !partyUI.rules; route(); });
  app.querySelectorAll('[data-ptype]').forEach(b => b.onclick = () => { partyUI.ptype = b.dataset.ptype; route(); });
  let sending = null;
  app.querySelectorAll('[data-send]').forEach(b => b.onclick = () => { sending = Number(b.dataset.send); $('#send-row').hidden = false; $('#send-no').textContent = '#' + sending; $('#send-to').focus(); });
  $('#send-x')?.addEventListener('click', () => { $('#send-row').hidden = true; sending = null; });
  $('#send-go')?.addEventListener('click', () => act('transfer', { card: sending, to: $('#send-to').value.trim() }, 'card-err'));
  app.querySelectorAll('[data-wd]').forEach(b => b.onclick = () => act(p.status === 'EXPIRED' ? 'withdraw' : 'withdraw', { ids: [Number(b.dataset.wd)] }, 'card-err'));
  app.querySelectorAll('[data-claim]').forEach(b => b.onclick = () => act('claim', { cards: [Number(b.dataset.claim)] }, 'card-err'));
  $('#claim-all')?.addEventListener('click', () => act('claim', {}, 'card-err'));
  $('#buy')?.addEventListener('click', () => act('buy', {}, 'buy-err'));
  $('#assemble')?.addEventListener('click', () => act('assemble', {}, 'vote-err'));
  $('#return')?.addEventListener('click', () => act('return', {}, 'ret-err'));
  $('#nominate')?.addEventListener('click', () => act('propose', { type: 'NOMINATE_ARRANGER', hours: $('#win')?.value, args: { address: $('#nominee').value } }, 'vote-err'));
  const send = () => { const t = $('#say').value.trim(); if (t) act('chat', { text: t }, 'chat-err'); };
  $('#send')?.addEventListener('click', send);
  $('#say')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
}

let draft = { name: '', minDeposit: 1, days: 14, voteHours: 48, arrangement: { preset: 'Rarity' }, target: { mode: 'floorPct', value: 25 }, filters: {} };
const arrLabel = a => !a ? 'Deposit order' : a.preset === 'Random' ? `Random #${a.seed}` : a.preset === 'Deposit' ? 'Deposit order' : a.preset;
async function pageNew() {
  stats = stats || await api('stats');
  const chip = (key, vals) => `<div class="chips">${vals.map(v => `<button type="button" data-f="${key}" data-v="${esc(v)}" aria-pressed="${[].concat(draft.filters[key] ?? []).map(String).includes(String(v))}">${esc(key === 'shiftMin' ? v + '+' : v)}</button>`).join('')}</div>`;
  const val = v => v == null ? '' : esc(v);
  const rg = stats.ranges;
  render(app, `
  <div class="intro"><div><h1>Start a party</h1><p class="muted">You host. Every setting is a default that runs automatically once the party fills. Card holders can change any of them by vote.</p></div></div>
  <form class="new" id="new-form">
   <div>
    <div class="field"><label for="n">Name</label><div><input id="n" value="${val(draft.name)}" placeholder="Two eights or more" maxlength="60">${hint('Up to 60 characters')}</div></div>
    <div class="field"><label for="ds">Description</label><div><textarea id="ds" rows="3" maxlength="1000" placeholder="What this Statement is about">${val(draft.description)}</textarea>${hint('Up to 1,000 characters')}</div></div>
    <div class="field"><label for="md">Minimum deposit</label><div><input id="md" type="number" min="1" max="80" value="${val(draft.minDeposit)}">${hint('Range: 1–80 Credits per depositor')}</div></div>
    <div class="field"><label for="dd">Deadline, days</label><div><input id="dd" type="number" min="1" max="60" value="${val(draft.days)}">${hint('Range: 1–60 days')}</div></div>
    <div class="field"><label for="vh">Vote window</label><div><select id="vh">${[24, 48, 72, 168].map(h => `<option value="${h}" ${h === (draft.voteHours || 48) ? 'selected' : ''}>${h < 168 ? h + ' hours' : '7 days'}</option>`).join('')}</select>${hint('Range: 24 hours – 7 days · default for this party’s proposals')}</div></div>
    <div class="field"><label>Default arrangement</label><div><div class="chips">${['Deposit', ...Object.keys(PRESETS)].map(k => `<button type="button" data-arr="${k}" aria-pressed="${(draft.arrangement?.preset || 'Rarity') === k}">${k === 'Deposit' ? 'Deposit order' : k}</button>`).join('')}</div>${hint('Applied when the party fills. Card holders can challenge it with a vote.')}</div></div>
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
    <button class="cta" id="create" type="button">Open party as ${me ? short(me) : '—'}</button>
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
    draft.name = $('#n').value; draft.description = $('#ds').value; draft.voteHours = +$('#vh').value; draft.minDeposit = +$('#md').value || 1; draft.days = +$('#dd').value || 14; draft.target.value = +$('#tv').value || 0;
    const num = id => +$(id).value || undefined;
    Object.assign(draft.filters, { rankMax: num('#rk'), marksMin: num('#mk0'), marksMax: num('#mk1'), idMin: num('#id0'), idMax: num('#id1') });
  };
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(async () => {
    read();
    const r = await api('eligible', draft.filters);
    $('#elig').textContent = `${r.count.toLocaleString()} Credits · ${r.owners.toLocaleString()} holders · up to ${r.statements.toLocaleString()} Statements`;
    render($('#elig-sheet'), r.sample.map(id => `<span><img src="${svg(id)}" alt=""></span>`).join('') + '<span class="empty"></span>'.repeat(Math.max(0, SLOTS - r.sample.length)));
    $('#elig-note').textContent = r.count < SLOTS ? 'Fewer than 80 Credits match. This party could never fill.' : 'Rarest 16 shown.';
  }, 150); };
  $('#shift-only').onclick = e => { draft.filters.shiftOnly = !draft.filters.shiftOnly; e.target.setAttribute('aria-pressed', draft.filters.shiftOnly); refresh(); };
  app.querySelectorAll('[data-f="shiftMin"]').forEach(b => b.onclick = e => { e.stopImmediatePropagation(); const v = +b.dataset.v; draft.filters.shiftMin = draft.filters.shiftMin === v ? undefined : v; app.querySelectorAll('[data-f="shiftMin"]').forEach(x => x.setAttribute('aria-pressed', draft.filters.shiftMin === +x.dataset.v)); refresh(); });
  app.querySelectorAll('[data-f]:not([data-f="shiftMin"])').forEach(b => b.onclick = () => { const k = b.dataset.f, v = k === 'eights' ? +b.dataset.v : b.dataset.v; const a = draft.filters[k] || []; draft.filters[k] = a.includes(v) ? a.filter(x => x !== v) : [...a, v]; b.setAttribute('aria-pressed', draft.filters[k].includes(v)); refresh(); });
  const fl = stats.floor ? stats.floor * SLOTS : null;
  const tvHint = () => { $('#tvh').textContent = draft.target.mode === 'fixed' ? 'Range: above 0 ETH' : (draft.target.mode === 'floorPct' ? 'Range: above −100%' : 'Range: above −' + eth(fl)) + ' · floor now ' + eth(fl); };
  app.querySelectorAll('[data-arr]').forEach(b => b.onclick = () => { draft.arrangement = b.dataset.arr === 'Random' ? { preset: 'Random', seed: 1 + Math.floor(Math.random() * 999999) } : { preset: b.dataset.arr }; app.querySelectorAll('[data-arr]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  app.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => { draft.target.mode = b.dataset.tm; app.querySelectorAll('[data-tm]').forEach(x => x.setAttribute('aria-pressed', x === b)); tvHint(); });
  tvHint();
  app.querySelectorAll('input, textarea').forEach(i => i.oninput = refresh);
  $('#create').onclick = async () => { read(); try { const p = await api('parties', draft); location.hash = '#/party/' + p.id; } catch (e) { $('#new-err').textContent = e.message; } };
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
  ${addr ? `<div class="caption"><h2>${short(addr)} · ${list.length} Credits</h2><span class="muted">${solo} Statement${solo === 1 ? '' : 's'} alone · ${list.length % SLOTS} left over</span></div>
  <table class="table"><thead><tr><th></th><th>Credit</th><th>Colors</th><th>Print</th><th>Weight</th><th>Eights</th><th>Ink</th><th>Rarity</th><th>Party</th></tr></thead><tbody>
  ${list.slice(0, 500).map(c => `<tr><td><img src="${svg(c.id)}" alt="" loading="lazy"></td><td>#${Number(c.id)}</td><td>${esc(c.colors)}</td><td>${esc(c.register || c.print)}</td><td>${esc(c.weight)}</td><td>${Number(c.eights)}</td><td>${Number(c.marks)}</td><td>${c.rank.toLocaleString()}</td><td>${c.deposited ? 'In a party' : '—'}</td></tr>`).join('')}
  </tbody></table>` : ''}`);
  const go = () => { location.hash = '#/wallet/' + $('#w').value.trim(); };
  $('#go').onclick = go;
  $('#w').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
}

function pageRules() {
  render(app, `
  <div class="intro"><div><h1>Rules</h1><p class="muted">How a party works. Read these first.</p></div><a class="cta" href="#/" style="margin:0">Continue to parties →</a></div>
  <div class="works"><div class="rows terms">
   <div><span>01 Open</span><strong>A host opens a party and sets its defaults: which Credits qualify, minimum deposit, default arrangement, default price, voting window, deadline.</strong></div>
   <div><span>02 Deposit</span><strong>Deposit matching Credits. Each one returns a Credit Card (ERC-721). Depositing accepts the party's defaults.</strong></div>
   <div><span>03 The card</span><strong>Whoever holds a Credit Card has its vote, can redeem its Credit until the party fills or if it expires, and gets 1/80 of the sale.</strong></div>
   <div><span>04 Full</span><strong>At 80, redemption closes and the default arrangement applies.</strong></div>
   <div><span>05 Arrange</span><strong>The host is the default arranger and can save any order, auto or manual, without a vote. Any card holder can challenge it with a vote or propose a new arranger.</strong></div>
   <div><span>06 Assemble</span><strong>One voting window after filling, any card holder burns the 80 into one Statement, held by the party. The default price then goes live.</strong></div>
   <div><span>07 Sell</span><strong>Only at the party's own price, only on Statement Maker. No offers, no auctions, no marketplaces. Buying opens 24 hours after a price goes live.</strong></div>
   <div><span>08 Split</span><strong>Artist royalty first, then 1% to Statement Maker, then the rest to the 80 Credit Cards.</strong></div>
   <div><span>09 Votes</span><strong>1 card = 1 vote, counted as held when the proposal opened. Passes with 41 of 80 yes and zero no. Prices below the floor need 60. After 3 blocked proposals of a kind or 30 days, 54 yes passes it and no is ignored.</strong></div>
   <div><span>10 Time</span><strong>Votes run 24 hours to 7 days. Any card holder executes a passed proposal within 7 days or it lapses.</strong></div>
   <div><span>11 Expire</span><strong>If a party never fills or never assembles, each Credit goes to whoever holds its card.</strong></div>
  </div>
  <div class="rows">
   <div><span>Contract</span><strong><a href="https://etherscan.io/address/0x97630aa70ab14ed9883b41dafccbc11349723043" target="_blank" rel="noopener noreferrer">Credits 0x9763…3043, Ethereum ↗</a></strong></div>
   <div><span>Source code</span><strong><a href="https://github.com/yuribeats/statement-maker" target="_blank" rel="noopener noreferrer">github.com/yuribeats/statement-maker ↗</a></strong></div>
   <div><span>Traits</span><strong>Computed by the Credits art contract itself</strong></div>
   <div><span>Rarity</span><strong>Sum of −log2 frequency over Colors, Print, Weight, Eights</strong></div>
   <div><span>Status</span><strong><span class="demo">Preview</span> · the Statement contract is not published yet · nothing here moves Credits or ETH</strong></div>
  </div></div>`);
}

// ---------- terms ----------
const TERMS_VERSION = '2026-09-23.2';
const TERMS = [
 ['What Statement Maker is', 'Statement Maker is a tool that lets holders of Credits pool them in groups called parties. When a party collects 80 Credits, the party can burn them to create one Statement and then sell it. Statement Maker provides the website and the smart contracts. It does not hold your Credits or your money; the party contracts do.'],
 ['Not affiliated with Jack Butcher', 'Statement Maker is independent. It is not made, endorsed, or operated by Jack Butcher, jack.art, the Credits project, or X. Credits and Statements are Jack Butcher’s work. We only coordinate holders who choose to use the burn function his contracts provide.'],
 ['How a party works', 'A host opens a party and sets its rules: minimum deposit, eligible Credits, target price, and default voting window. Holders deposit Credits. You can withdraw your Credits at any time until the party reaches 80. At 80, deposits lock and each depositor receives one Credit Card per Credit. The host arranges the 8 × 10 order unless members elect someone else, and members vote to approve it. Any member can then assemble the Statement.'],
 ['Burning is permanent', 'Assembly burns all 80 Credits forever. They cannot be restored, withdrawn, or returned after assembly. If a party never fills, or never assembles before its deadline, every Credit goes back to its depositor.'],
 ['Credit Cards', 'A Credit Card is an ERC-721 token, one per deposited Credit. Whoever holds it has that Credit’s vote, the right to redeem the Credit before the Statement is made or if the party expires, and 1/80 of any sale. Credit Cards can be transferred or traded by anyone. They are not a claim on Statement Maker, carry no promise of value, and may end up worth nothing.'],
 ['Voting', 'Every Credit Card is one vote. A proposal passes when more than 40 Credit Cards vote yes and none vote no within its voting window, which lasts 24 hours to 7 days. Any member must then execute it within 7 days or it lapses. A single no vote blocks a proposal, so a party can stay deadlocked and its Statement can go unsold indefinitely.'],
 ['Selling', 'A party sells its Statement only on Statement Maker, only at the price its members approved, to the first buyer who pays it. There are no offers, no auctions, and no marketplace listings. Members may approve any price, including below the floor. A floor-based price can rise automatically but never falls without a new vote.'],
 ['Fees, royalties, gas', 'Each sale pays the artist royalty set by the Statement contract first, then a 1% Statement Maker fee, and the rest goes to Credit Card holders pro rata. Every action on-chain (depositing, voting, executing, assembling, claiming) costs gas, paid by whoever calls it. Statement Maker does not refund gas.'],
 ['Risks', 'Smart contracts can have bugs, and ours have not been audited yet. The Statement contract has not been published; it may work differently from what this site assumes, or may not accept parties at all. Prices can fall. Transactions cannot be reversed. If you lose access to your wallet, nobody can recover your Credits, Credit Cards, or proceeds. Laws about tokens like Credit Cards may change or differ where you live.'],
 ['No advice', 'Nothing on this site is financial, investment, legal, or tax advice. You decide what to deposit, how to vote, and whether to sell.'],
 ['Your responsibilities', 'You control your own wallet and keys. You confirm you are legally allowed to use this service where you live, are not subject to sanctions, and will handle your own taxes. You will not use Statement Maker to manipulate votes, prices, or other members.'],
 ['Preview', 'Statement Maker is in preview until the Statement contract is published. Deposits, votes, sales and claims shown here are recorded by Statement Maker only; nothing moves Credits or ETH on-chain yet.'],
 ['Liability and changes', 'Statement Maker is provided as is, without warranties. To the extent the law allows, Statement Maker is not liable for losses from using it. These terms may change; you will be asked to accept any new version before your next action.'],
];
const termsBody = () => `<div class="rows terms">${TERMS.map(([h, t], i) => `<div><span>${String(i + 1).padStart(2, '0')} ${esc(h)}</span><strong>${esc(t)}</strong></div>`).join('')}</div>`;
function pageTerms() {
  render(app, `
  <div class="intro"><div><h1>Terms and conditions</h1><p class="muted">Version ${TERMS_VERSION} · <span class="demo">Draft, needs legal review before launch</span></p></div></div>
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
    <div class="modal-head"><h2 id="mt">Terms and conditions</h2><span class="muted">Connecting ${short(address)} · version ${TERMS_VERSION}</span></div>
    <div class="modal-body" id="mbody">
     <p class="muted" style="margin-bottom:18px"><span class="demo">Draft, needs legal review before launch</span> · Read to the end to continue.</p>
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
        const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex(message), address] });
        who = (await api('auth/verify', { nonce, signature })).address;
      } else {
        who = (await api('auth/dev', { address, accept: $('#agree').checked })).address;
      }
      close(); setMe(who);
    } catch (e) { $('#t-err').textContent = e.message; }
  };
  $('#agree').focus?.();
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
const statementCard = p => `
   <a class="party-card" href="#/statement/${esc(p.id)}">
    ${sheet(p)}
    <div class="caption"><span><strong>Statement ${Number(p.assembled.number)}</strong></span><span class="muted">${esc(p.name)}</span></div>
    <div class="muted">${p.members.length} holders · ${p.listing ? 'Listed ' + eth(p.listingEth) : 'Not listed'}</div>
   </a>`;
async function pageStatements() {
  const list = await api('statements');
  const mine = me ? list.filter(p => p.members.some(m => m.address === me)) : [];
  render(app, `
  <div class="intro"><div><h1>Statements</h1><p class="muted">Made by parties on Statement Maker.</p></div><p class="muted">${list.length} made</p></div>
  ${mine.length ? `<div class="caption"><h2><span class="dot y"></span>Yours · ${mine.length}</h2></div><div class="parties" style="margin-bottom:64px">${mine.map(statementCard).join('')}</div>` : ''}
  <div class="caption"><h2>All</h2></div>
  ${list.length ? `<div class="parties">${list.map(statementCard).join('')}</div>` : '<p class="muted">None yet. A party assembles its Statement once its arrangement is approved.</p>'}`);
}
async function pageStatement(id) {
  const p = await api('parties/' + encodeURIComponent(id));
  if (!p.assembled) { location.hash = '#/party/' + encodeURIComponent(id); return; }
  const mine = p.members.find(m => m.address === me);
  const approved = p.proposals.find(q => q.type === 'APPROVE_ARRANGEMENT' && q.executed);
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
    <div><span>Order</span><strong>${approved ? esc(approved.args.preset) : 'Deposit order'} · by ${short(approved?.by || p.arranger)}</strong></div>
    <div><span>Assembled by</span><strong>${short(p.assembled.by)}</strong></div>
    <div><span>Held by</span><strong>The party vault · ${p.members.length} Credit Card holders</strong></div>
    ${mine ? `<div><span>You</span><strong><span class="dot y"></span>${Number(mine.count)} of 80 Credit Cards · ${(mine.count / 80 * 100).toFixed(2)}%</strong></div>` : ''}
    <div><span>Price</span><strong>${p.listing ? priceLabel(p.listing) + ' · ' + eth(p.listingEth) : 'Not listed'}</strong></div>
    <div><span>Floor</span><strong>${eth(p.floorEth)}</strong></div>
   </div>
   <h2 style="margin:48px 0 14px">Holders</h2>
   <table class="table"><tbody>${p.members.map(m => `<tr><td>${m.address === me ? '<span class="dot y"></span>' : ''}${short(m.address)}</td><td style="text-align:right">${Number(m.count)}</td></tr>`).join('')}</tbody></table>
   </section>
  </div>`);
  $('#png').onclick = () => statementPNG(p);
}

// ---------- router ----------
let lastParty = null;
async function route() {
  const [, page, arg] = location.hash.replace(/^#?\/?/, '#/').split('/');
  // The site lands on the rules: a bare URL (no hash) opens Rules; "#/" is the parties list.
  if (!location.hash) { location.replace('#/rules'); return; }
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', a.dataset.nav === (page || 'parties') || (page === 'party' && a.dataset.nav === 'parties')));
  if (page !== 'party' || arg !== lastParty) partyUI = freshUI();
  lastParty = page === 'party' ? arg : null;
  try {
    if (page === 'party') await pageParty(arg);
    else if (page === 'new') await pageNew();
    else if (page === 'wallet') await pageWallet(arg);
    else if (page === 'rules') pageRules();
    else if (page === 'terms') pageTerms();
    else if (page === 'statements') await pageStatements();
    else if (page === 'statement') await pageStatement(arg);
    else await pageParties();
  } catch (e) { render(app, `<p class="error">${esc(e.message)}</p>`); }
}
window.addEventListener('hashchange', route);
Promise.all([api('auth/me').then(m => { me = m.address && m.terms ? m.address : ''; }), api('stats').then(x => (stats = x))]).then(() => Promise.all([fillActing(), api('gas').then(g => (gasInfo = g)).catch(() => {})])).then(route);
