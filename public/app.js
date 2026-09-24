// Statement Maker — local prototype front end. Hash routes, no framework.
// All user-supplied strings go through esc() before render().
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const render = (el, s) => el.replaceChildren(document.createRange().createContextualFragment(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => a ? esc(a.slice(0, 6) + '…' + a.slice(-4)) : '—';
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
let me = (() => { try { return localStorage.getItem('sm-acting') || ''; } catch { return ''; } })();
if (!/^0x[0-9a-f]{40}$/.test(me)) me = '';

// ---------- acting-as wallet (stand-in for wallet connect) ----------
async function fillActing() {
  const sel = $('#acting');
  const top = await api('holders');
  const seen = new Set();
  const opts = [{ address: '', count: 0 }, ...(me ? [{ address: me, count: '·' }] : []), ...top].filter(o => !seen.has(o.address) && seen.add(o.address));
  render(sel, opts.map(o => `<option value="${esc(o.address)}" ${o.address === me ? 'selected' : ''}>${o.address ? short(o.address) + ' · ' + esc(o.count) : 'Nobody'}</option>`).join('') + '<option value="__paste">Paste address…</option>');
}
$('#acting').addEventListener('change', e => {
  let v = e.target.value;
  if (v === '__paste') { v = (prompt('Wallet address') || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(v)) v = me; }
  me = v; try { localStorage.setItem('sm-acting', me); } catch {}
  fillActing(); route();
});

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
  return true;
}

// ---------- pages ----------
async function pageParties() {
  const [parties] = await Promise.all([api('parties'), stats || api('stats').then(s => (stats = s))]);
  render(app, `
  <div class="intro"><div><h1>Eighty Credits make a Statement.</h1><p class="muted">Most holders have one. Parties pool them.</p></div><p class="muted">Snapshot block ${stats.block.toLocaleString()}</p></div>
  <div class="stats">
   <div><strong>${stats.credits.toLocaleString()}</strong><span>Credits</span></div>
   <div><strong>${stats.holders.toLocaleString()}</strong><span>Holders</span></div>
   <div><strong>${stats.soloStatements.toLocaleString()} / ${stats.maxStatements.toLocaleString()}</strong><span>Statements possible without a party</span></div>
   <div><strong>${stats.scattered.toLocaleString()}</strong><span>Credits in wallets under 80</span></div>
  </div>
  <div class="caption"><h2>Parties</h2><a href="#/new">Start a party →</a></div>
  <div class="parties">${parties.map(p => `
   <a class="party-card" href="#/party/${esc(p.id)}">
    ${sheet(p)}
    ${filled(p)}
    <div class="caption"><span><strong>${esc(p.name)}</strong></span><span>${p.credits.length}/80 ${stateTag(p.status)}</span></div>
    <div class="muted">${filterText(p.params.filters)} · Target ${targetText(p.params.target)}${p.demo ? ' · <span class="demo">Demo</span>' : ''}</div>
   </a>`).join('')}</div>`);
}

const freshUI = () => ({ mode: 'sheet', selected: null, order: null, preset: null, picks: new Set() });
let partyUI = freshUI();
async function pageParty(id) {
  const p = await api('parties/' + encodeURIComponent(id));
  const isHost = p.hosts.includes(me), isMember = p.members.some(m => m.address === me), isArranger = p.arranger === me;
  const myTokens = p.members.find(m => m.address === me)?.count || 0;
  const order = partyUI.mode === 'arrange' && partyUI.order ? partyUI.order : p.credits;
  const sel = order.find(c => c.id === partyUI.selected) || null;
  const wallet = me && p.status === 'OPEN' ? await api('wallet/' + me) : [];
  const remaining = SLOTS - p.credits.length, minDep = Math.min(p.params.minDeposit, remaining);
  const eligibleMine = wallet.filter(c => !c.deposited && matchesClient(c, p.params.filters));

  render(app, `
  <div class="intro"><div><h1>${esc(p.name)}</h1><p class="muted">${p.status === 'OPEN' ? `${remaining} slots open · closes in ${Math.max(0, Math.ceil((p.deadline - Date.now()) / 864e5))} days` : p.status === 'FULL' ? 'Full · arranging the 80' : esc(p.status)}${p.demo ? ' · <span class="demo">Demo data</span>' : ''}</p></div><div style="text-align:right"><a href="#/" class="muted">← All parties</a><div><button type="button" id="skip" class="faint" title="Prototype only: move the clock forward">Dev · skip 24h</button></div></div></div>
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
      <p class="muted">Auto-order, then drag to swap. ${isArranger ? `You are the ${p.arrangerElected ? 'elected' : 'default'} arranger.` : `Only the ${p.arrangerElected ? 'elected' : 'default'} arranger ${short(p.arranger)} can submit. Anyone can preview.`}${p.arrangerElected ? '' : ' The host arranges unless members elect someone else.'}</p>
      <div class="modes" style="margin:10px 0">${Object.keys(PRESETS).map(k => `<button type="button" data-preset="${k}" aria-pressed="${(partyUI.preset || '').startsWith(k)}">${k}</button>`).join('')}</div>
      ${isArranger ? `<button class="cta" id="submit-order">Submit arrangement for vote</button>` : ''}
      <div class="error" id="arr-err"></div>
     </div>` : ''}
    <div class="detail">${sel ? `<img src="${svg(sel.id)}" alt="Credit ${Number(sel.id)}"><div class="rows">
      <div><span>Credit</span><strong>#${Number(sel.id)}</strong></div>
      <div><span>Colors · Print</span><strong>${esc(sel.colors)} · ${esc(sel.print)}</strong></div>
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
      <div><span>Minimum deposit</span><strong>${Number(p.params.minDeposit)}</strong></div>
      <div><span>Target</span><strong>${targetText(p.params.target)}${p.params.target.mode !== 'fixed' ? ' · now ' + eth(p.targetEth) : ''}</strong></div>
      <div><span>Floor (80 × Credit floor)</span><strong>${eth(p.floorEth)}</strong></div>
      ${p.listing ? `<div><span>Approved price</span><strong>${priceLabel(p.listing)} · ${eth(p.listingEth)} · ${vsFloor(p.listingEth, p.floorEth)}</strong></div>` : ''}
      <div><span>Sale split</span><strong>Artist royalty · 1% Statement Maker · rest to 80 tokens</strong></div>
      ${isMember ? `<div><span>You</span><strong><span class="dot y"></span>${myTokens} of 80 ${p.status === 'OPEN' ? 'deposited' : 'tokens'}</strong></div>` : ''}
     </div>
    </div>

    ${p.status === 'OPEN' ? `
    <div class="panel">
     <h2>Deposit</h2>
     ${!me ? `<p class="muted">Choose a wallet under “Acting as”.</p>` : `
       <p class="muted">${short(me)} holds ${wallet.length} Credit${wallet.length === 1 ? '' : 's'} · ${eligibleMine.length} eligible here · minimum ${minDep}</p>
       <div class="picker">${wallet.slice(0, 200).map(c => { const ok = !c.deposited && matchesClient(c, p.params.filters); return `<button type="button" data-pick="${Number(c.id)}" ${ok ? '' : 'disabled'} aria-pressed="${partyUI.picks.has(c.id)}" title="#${Number(c.id)} ${esc(c.colors)} ${esc(c.print)} ${esc(c.weight)}"><img src="${svg(c.id)}" alt="" loading="lazy"></button>`; }).join('')}</div>
       <div class="actions"><button type="button" id="pick-all">Select eligible</button><button type="button" id="pick-none">Clear</button></div>
       <button class="cta" id="deposit">Deposit ${partyUI.picks.size || ''}</button> ${cost('deposit')} each
       ${isMember ? `<button type="button" id="withdraw" class="muted" style="margin-left:18px">Withdraw mine</button>` : ''}`}
     <div class="error" id="dep-err"></div>
     <p class="note">Credits stay yours until 80 are in. Withdraw any time before the party fills.</p>
    </div>` : ''}

    ${p.status === 'EXPIRED' ? `
    <div class="panel"><h2>Expired</h2>
     ${p.returned ? `<p class="muted">${Number(p.returned.count)} Credits returned to their depositors by ${short(p.returned.by)}.</p>` : `<p class="muted">The party did not finish in time. Any member can send every Credit back to its depositor.</p>${isMember ? `<div class="actions"><button type="button" class="cta" id="return">Return all Credits</button> ${cost('returnCredit')} per Credit</div>` : ''}`}
     <div class="error" id="ret-err"></div></div>` : ''}
    ${p.status !== 'OPEN' && p.status !== 'EXPIRED' ? `
    <div class="panel">
     <h2>Proposals</h2>
     <p class="muted" style="margin-bottom:10px">48-hour vote. Passes when YES &gt; 40 tokens and no one votes NO. Any member can then execute it.</p>
     ${p.status === 'FULL' && p.orderApproved ? `<div class="proposal"><div class="caption" style="min-height:0"><strong>Assemble</strong><span class="pass">Ready</span></div><div class="muted">Arrangement approved. Any member can burn the 80 into the Statement. Simulated: the Statement contract is not public yet.</div>${isMember ? `<div class="actions"><button type="button" class="cta" id="assemble">Assemble</button> ${cost('assemble')}</div>` : ''}</div>` : ''}
     ${p.assembled ? `<div class="proposal"><strong>Assembled</strong> <span class="muted">by ${short(p.assembled.by)}</span></div>` : ''}
     ${p.proposals.length ? p.proposals.map(q => `
      <div class="proposal">
       <div class="caption" style="min-height:0"><strong>${Number(q.id)}. ${esc(q.type.replace('_', ' '))}</strong><span class="${q.executed || q.executable ? 'pass' : q.no ? 'blocked' : 'muted'}">${q.executed ? 'Executed' : q.no ? 'Blocked by NO' : q.executable ? 'Passed · ready to execute' : q.closed ? 'Failed' : q.passing ? 'Passing · closes in ' + hrs(q.endsAt - p.now) : 'Open · closes in ' + hrs(q.endsAt - p.now)}</span></div>
       <div class="muted">${q.type === 'NOMINATE_ARRANGER' ? 'Arranger: ' + short(q.args.address) : q.type === 'APPROVE_ARRANGEMENT' ? 'Order: ' + esc(q.args.preset) : q.type === 'LIST' ? 'Price: ' + priceLabel(q.args) + ' · ' + eth(priceOf(q.args, p.floorEth)) + ' · ' + vsFloor(priceOf(q.args, p.floorEth), p.floorEth) : ''} · by ${short(q.by)} · ${ago(q.at)} ago</div>
       <div class="tally"><div class="bar"><i style="width:${q.yes / SLOTS * 100}%"></i></div><span>Yes ${q.yes}</span><div class="bar no"><i style="width:${q.no / SLOTS * 100}%"></i></div><span>No ${q.no}</span></div>
       ${q.executed && q.executedBy ? `<div class="muted">Executed by ${short(q.executedBy)}</div>` : ''}
       ${isMember && q.executable ? `<div class="actions"><button type="button" class="cta" data-exec="${Number(q.id)}">Execute</button> ${cost('execute')}</div>` : ''}
       ${isMember && !q.executed && !q.closed ? `<div class="actions"><button type="button" data-vote="${Number(q.id)}" data-yes="1">Vote yes</button><button type="button" data-vote="${Number(q.id)}" data-yes="0">Vote no</button><span>${cost('vote')}</span>${q.type === 'APPROVE_ARRANGEMENT' ? `<button type="button" data-preview="${Number(q.id)}">Preview order</button>` : ''}</div>` : ''}
      </div>`).join('') : '<p class="muted">None yet.</p>'}
     ${isMember && p.status === 'FULL' ? `
      <div class="actions" style="margin-top:14px"><span class="muted">Nominate arranger</span>
       <select id="nominee" style="border:0;border-bottom:1px solid var(--line)">${p.members.map(m => `<option value="${esc(m.address)}">${short(m.address)} · ${Number(m.count)}</option>`).join('')}</select>
       <button type="button" id="nominate">Propose</button></div>` : ''}
     ${isMember ? `
      <div class="actions" style="margin-top:10px;align-items:center"><span class="muted">Propose price</span>
       <select id="pm" style="border:0;border-bottom:1px solid var(--line)"><option value="fixed">ETH</option><option value="floorEth">Floor ± ETH</option><option value="floorPct">Floor ± %</option></select>
       <input id="pv" type="number" step="0.01" value="${p.floorEth ? (p.floorEth * 0.9).toFixed(2) : 1}" style="width:90px;border:0;border-bottom:1px solid var(--line)">
       <span id="pp" class="muted"></span>
       <span class="hint" id="ph"></span>
       <button type="button" id="propose-price">Propose</button></div>
      <p class="note">Any price can be proposed, below the floor included. Only the vote decides.</p>` : ''}
     <div class="error" id="vote-err"></div>
    </div>` : ''}

    <div class="panel">
     <h2>Members · ${p.members.length}</h2>
     <table class="table"><tbody>${p.members.slice(0, 30).map(m => `<tr><td>${m.address === me ? '<span class="dot y"></span>' : ''}${short(m.address)}${m.host ? ' <span class="muted">host</span>' : ''}${m.address === p.arranger ? ` <span class="muted">arranger${p.arrangerElected ? '' : ' (default)'}</span>` : ''}</td><td style="text-align:right">${Number(m.count)}</td></tr>`).join('')}</tbody></table>
    </div>

    <div class="panel">
     <h2>Chat</h2>
     <div class="chat" id="chat">${p.chat.map(m => `<div class="msg"><span class="muted">${short(m.address)} · ${ago(m.at)}</span><p>${esc(m.text)}</p></div>`).join('') || '<p class="muted" style="padding:10px 0">Quiet.</p>'}</div>
     ${isMember || isHost ? `<div class="compose"><textarea id="say" rows="1" placeholder="Say something"></textarea><button type="button" id="send">Send</button></div>` : `<p class="note">Depositors and hosts can post.</p>`}
     <div class="error" id="chat-err"></div>
    </div>
   </section>
  </div>`);

  const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  const err = (id, e) => { const el = $('#' + id); if (el) el.textContent = e.message || e; };
  const act = async (path, body, errId) => { try { await api(`parties/${encodeURIComponent(p.id)}/${path}`, { address: me, ...body }); await route(); return true; } catch (e) { err(errId, e); return false; } };

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
  $('#submit-order')?.addEventListener('click', () => act('arrange', { order: partyUI.order.map(c => c.id), preset: partyUI.preset || 'Deposit order' }, 'arr-err'));
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
  $('#propose-price')?.addEventListener('click', () => act('propose', { type: 'LIST', args: { mode: $('#pm').value, value: +$('#pv').value } }, 'vote-err'));
  app.querySelectorAll('[data-exec]').forEach(b => b.onclick = () => act('execute', { proposal: b.dataset.exec }, 'vote-err'));
  $('#skip')?.addEventListener('click', async () => { await api('dev/advance', { hours: 24 }); route(); });
  $('#assemble')?.addEventListener('click', () => act('assemble', {}, 'vote-err'));
  $('#return')?.addEventListener('click', () => act('return', {}, 'ret-err'));
  $('#nominate')?.addEventListener('click', () => act('propose', { type: 'NOMINATE_ARRANGER', args: { address: $('#nominee').value } }, 'vote-err'));
  const send = () => { const t = $('#say').value.trim(); if (t) act('chat', { text: t }, 'chat-err'); };
  $('#send')?.addEventListener('click', send);
  $('#say')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
}

let draft = { name: '', minDeposit: 1, days: 14, target: { mode: 'floorPct', value: 25 }, filters: {} };
async function pageNew() {
  stats = stats || await api('stats');
  const chip = (key, vals) => `<div class="chips">${vals.map(v => `<button type="button" data-f="${key}" data-v="${esc(v)}" aria-pressed="${(draft.filters[key] || []).map(String).includes(String(v))}">${esc(v)}</button>`).join('')}</div>`;
  const val = v => v == null ? '' : esc(v);
  const rg = stats.ranges;
  render(app, `
  <div class="intro"><div><h1>Start a party</h1><p class="muted">You host. You set who can join and what the Statement should sell for.</p></div></div>
  <form class="new" onsubmit="return false">
   <div>
    <div class="field"><label for="n">Name</label><input id="n" value="${val(draft.name)}" placeholder="Two eights or more" maxlength="60"></div>
    <div class="field"><label for="md">Minimum deposit</label><div><input id="md" type="number" min="1" max="80" value="${val(draft.minDeposit)}">${hint('Range: 1–80 Credits per depositor')}</div></div>
    <div class="field"><label for="dd">Deadline, days</label><div><input id="dd" type="number" min="1" max="60" value="${val(draft.days)}">${hint('Range: 1–60 days')}</div></div>
    <div class="field"><label>Target price</label><div>
      <div class="chips">${[['fixed', 'ETH'], ['floorEth', 'Floor + ETH'], ['floorPct', 'Floor + %']].map(([m, l]) => `<button type="button" data-tm="${m}" aria-pressed="${draft.target.mode === m}">${l}</button>`).join('')}</div>
      <input id="tv" type="number" step="0.01" value="${val(draft.target.value)}" style="margin-top:6px"><div class="hint" id="tvh"></div></div></div>
    <div class="field"><label>Colors</label>${chip('colors', COLOR_ORDER)}</div>
    <div class="field"><label>Print</label>${chip('print', PRINT_ORDER)}</div>
    <div class="field"><label>Weight</label>${chip('weight', WEIGHT_ORDER)}</div>
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
  const read = () => {
    draft.name = $('#n').value; draft.minDeposit = +$('#md').value || 1; draft.days = +$('#dd').value || 14; draft.target.value = +$('#tv').value || 0;
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
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { const k = b.dataset.f, v = k === 'eights' ? +b.dataset.v : b.dataset.v; const a = draft.filters[k] || []; draft.filters[k] = a.includes(v) ? a.filter(x => x !== v) : [...a, v]; b.setAttribute('aria-pressed', draft.filters[k].includes(v)); refresh(); });
  const fl = stats.floor ? stats.floor * SLOTS : null;
  const tvHint = () => { $('#tvh').textContent = draft.target.mode === 'fixed' ? 'Range: above 0 ETH' : (draft.target.mode === 'floorPct' ? 'Range: above −100%' : 'Range: above −' + eth(fl)) + ' · floor now ' + eth(fl); };
  app.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => { draft.target.mode = b.dataset.tm; app.querySelectorAll('[data-tm]').forEach(x => x.setAttribute('aria-pressed', x === b)); tvHint(); });
  tvHint();
  app.querySelectorAll('input').forEach(i => i.oninput = refresh);
  $('#create').onclick = async () => { read(); try { const p = await api('parties', { address: me, ...draft }); location.hash = '#/party/' + p.id; } catch (e) { $('#new-err').textContent = e.message; } };
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
  ${list.slice(0, 500).map(c => `<tr><td><img src="${svg(c.id)}" alt="" loading="lazy"></td><td>#${Number(c.id)}</td><td>${esc(c.colors)}</td><td>${esc(c.print)}</td><td>${esc(c.weight)}</td><td>${Number(c.eights)}</td><td>${Number(c.marks)}</td><td>${c.rank.toLocaleString()}</td><td>${c.deposited ? 'In a party' : '—'}</td></tr>`).join('')}
  </tbody></table>` : ''}`);
  const go = () => { location.hash = '#/wallet/' + $('#w').value.trim(); };
  $('#go').onclick = go;
  $('#w').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
}

function pageRules() {
  render(app, `
  <div class="intro"><div><h1>Rules</h1><p class="muted">How a party works.</p></div></div>
  <div class="works"><div class="rows">
   <div><span>01 Open</span><strong>A host opens a party and sets a minimum deposit, a target price, and which Credits qualify.</strong></div>
   <div><span>02 Deposit</span><strong>Holders deposit matching Credits. Withdraw any time before the 80th arrives.</strong></div>
   <div><span>03 Full</span><strong>At 80, each deposited Credit becomes one party token (ERC-20). Tokens trade freely.</strong></div>
   <div><span>04 Arrange</span><strong>The host arranges the 8 × 10 sheet unless members elect someone else. Members approve the order.</strong></div>
   <div><span>05 Assemble</span><strong>The 80 Credits are burned into one Statement, held by the party.</strong></div>
   <div><span>06 Sell</span><strong>Only at the party's own price, only on Statement Maker. No offers. No auctions. No marketplaces.</strong></div>
   <div><span>07 Price</span><strong>Fixed ETH, or floor plus or minus ETH or percent. Any price can be proposed, below the floor included. A floor-tracking price only moves up; lowering it takes a new vote.</strong></div>
   <div><span>08 Split</span><strong>Artist royalty first, then 1% to Statement Maker, then the rest to token holders.</strong></div>
   <div><span>09 Votes</span><strong>A proposal passes when more than 40 tokens vote yes and no one votes no.</strong></div>
   <div><span>10 Expire</span><strong>If a party never fills or never assembles, every Credit goes back to its depositor.</strong></div>
  </div>
  <div class="rows">
   <div><span>Contract</span><strong>Credits 0x9763…3043, Ethereum</strong></div>
   <div><span>Traits</span><strong>Computed by the Credits art contract itself</strong></div>
   <div><span>Rarity</span><strong>Sum of −log2 frequency over Colors, Print, Weight, Eights</strong></div>
   <div><span>Status</span><strong><span class="demo">Local prototype</span> · no contracts deployed · wallets simulated</strong></div>
  </div></div>`);
}

// ---------- router ----------
let lastParty = null;
async function route() {
  const [, page, arg] = location.hash.replace(/^#?\/?/, '#/').split('/');
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', a.dataset.nav === (page || 'parties') || (page === 'party' && a.dataset.nav === 'parties')));
  if (page !== 'party' || arg !== lastParty) partyUI = freshUI();
  lastParty = page === 'party' ? arg : null;
  try {
    if (page === 'party') await pageParty(arg);
    else if (page === 'new') await pageNew();
    else if (page === 'wallet') await pageWallet(arg);
    else if (page === 'rules') pageRules();
    else await pageParties();
  } catch (e) { render(app, `<p class="error">${esc(e.message)}</p>`); }
}
window.addEventListener('hashchange', route);
Promise.all([fillActing(), api('gas').then(g => (gasInfo = g)).catch(() => {})]).then(route);
