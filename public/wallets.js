// Wallet picker shared by the main site (app.js) and the Sepolia page (bundled into sepolia.js).
// Installed browser wallets are found through EIP-6963: each announces its own name, icon and provider,
// so the site talks to the wallet the user picks, never to whichever extension claimed window.ethereum.
// WalletConnect v2 (QR for mobile and any other wallet) loads /wc.js only when chosen, and only when the
// server reports a project id.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = (el, s) => el.replaceChildren(document.createRange().createContextualFragment(s));
const short = a => a ? esc(String(a).slice(0, 6) + '…' + String(a).slice(-4)) : '—';
// Icons arrive as data: URIs inside the announcement; anything else is dropped.
const safeIcon = s => typeof s === 'string' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(s) && s.length < 200000 ? s : '';

// Named wallets always listed; installed ones come from their EIP-6963 announcement (matched by rdns).
export const KNOWN = [
  { rdns: 'io.metamask', name: 'MetaMask', url: 'https://metamask.io/download/' },
  { rdns: 'app.phantom', name: 'Phantom', url: 'https://phantom.com/download' },
  { rdns: 'me.rainbow', name: 'Rainbow', url: 'https://rainbow.me/download' },
  { rdns: 'com.coinbase.wallet', name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet/downloads' },
  { rdns: 'io.rabby', name: 'Rabby', url: 'https://rabby.io/' },
];
const KEY = 'sm-wallet';
const remembered = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const remember = id => { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch {} };

// ---------- EIP-6963 discovery ----------
const announced = new Map(); // rdns (or uuid) -> { id, name, icon, provider }
const listeners = new Set();
window.addEventListener('eip6963:announceProvider', e => {
  const d = e?.detail, info = d?.info, provider = d?.provider;
  if (!info || !provider || typeof provider.request !== 'function') return;
  const id = String(info.rdns || info.uuid || '').slice(0, 100);
  if (!id) return;
  announced.set(id, { id, name: String(info.name || id).slice(0, 40), icon: safeIcon(info.icon), provider });
  listeners.forEach(f => f());
});
const ask = () => window.dispatchEvent(new Event('eip6963:requestProvider'));
ask();
const settle = (ms = 250) => new Promise(r => { ask(); setTimeout(r, ms); });

// Every choice the picker offers: announced wallets, then fallbacks for wallets that do not announce.
function injected() {
  const out = new Map(announced);
  // Phantom's EVM provider: prefer its EIP-6963 announcement; fall back to window.phantom.ethereum.
  const ph = window.phantom?.ethereum;
  if (!out.has('app.phantom') && ph && typeof ph.request === 'function') out.set('app.phantom', { id: 'app.phantom', name: 'Phantom', icon: '', provider: ph });
  // Nothing announced at all: the legacy injected provider, named plainly.
  if (!out.size && window.ethereum && typeof window.ethereum.request === 'function') out.set('injected', { id: 'injected', name: 'Browser wallet', icon: '', provider: window.ethereum });
  return out;
}

// ---------- WalletConnect ----------
let wcConfig; // { projectId } or null
async function wcProjectId() {
  if (wcConfig === undefined) { try { const r = await fetch('/api/config'); wcConfig = r.ok ? await r.json() : {}; } catch { wcConfig = {}; } }
  return /^[0-9a-f]{32}$/i.test(wcConfig?.walletConnectProjectId || '') ? wcConfig.walletConnectProjectId : '';
}
const WC_URL = '/wc.js';
let wcMod = null;
async function wcProvider(chainId, { restoreOnly = false } = {}) {
  const projectId = await wcProjectId();
  if (!projectId) return null;
  wcMod = wcMod || await import(WC_URL);
  const p = await wcMod.EthereumProvider.init({
    projectId, optionalChains: [chainId], showQrModal: false,
    methods: ['personal_sign', 'eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'],
    metadata: { name: 'Statement Maker', description: 'Pool Credits into Statements', url: location.origin, icons: [] },
  });
  if (restoreOnly && !p.session) return null;
  return p;
}

// ---------- the active wallet ----------
let active = null; // { id, name, icon, provider }
const handlers = { accounts: () => {}, chain: () => {} };
const onAccounts = a => handlers.accounts((Array.isArray(a) ? a : []).map(x => String(x).toLowerCase()));
const onChain = c => handlers.chain(Number(c));
const onDisconnect = () => handlers.accounts([]);
function setActive(w) {
  const old = active?.provider;
  if (old?.removeListener) { old.removeListener('accountsChanged', onAccounts); old.removeListener('chainChanged', onChain); old.removeListener('disconnect', onDisconnect); }
  active = w;
  const p = w?.provider;
  if (p?.on) { p.on('accountsChanged', onAccounts); p.on('chainChanged', onChain); if (w.id === 'walletconnect') p.on('disconnect', onDisconnect); }
}
export const wallet = () => active;
export function on(ev, f) { handlers[ev] = f; }

async function ensureChain(p, chainId) {
  try {
    if (Number(await p.request({ method: 'eth_chainId' })) === chainId) return;
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + chainId.toString(16) }] });
  } catch {}
}

// Reconnect silently to the wallet chosen last time (no prompt). Returns its current account, or ''.
export async function restore(chainId) {
  const id = remembered();
  if (!id) return '';
  try {
    if (id === 'walletconnect') {
      const p = await wcProvider(chainId, { restoreOnly: true });
      if (!p) return '';
      setActive({ id, name: 'WalletConnect', icon: '', provider: p });
      return String(p.accounts?.[0] || '').toLowerCase();
    }
    await settle();
    const w = injected().get(id);
    if (!w) return '';
    setActive(w);
    const [a] = await w.provider.request({ method: 'eth_accounts' });
    return String(a || '').toLowerCase();
  } catch { return ''; }
}

export async function disconnect() {
  const w = active;
  setActive(null); remember('');
  try {
    if (w?.id === 'walletconnect') await w.provider.disconnect();
    else if (w) await w.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch {}
}

// personal_sign through the chosen wallet.
export async function sign(message, address) {
  if (!active) throw new Error('No wallet connected');
  const hex = '0x' + [...new TextEncoder().encode(message)].map(b => b.toString(16).padStart(2, '0')).join('');
  return active.provider.request({ method: 'personal_sign', params: [hex, address] });
}

// The picker. Resolves to { account, provider, id, name } or null if closed.
// opts: { chainId, title, note, extra: html appended under the list, bind(root, close) for the extra html }
export function pick({ chainId = 1, title = 'Connect wallet', note = '', extra = '', bind } = {}) {
  let root = document.getElementById('modal-root');
  if (!root) { root = document.createElement('div'); root.id = 'modal-root'; document.body.append(root); }
  return new Promise(resolve => {
    let done = false, wcP = null;
    const close = (result = null) => {
      if (done) return; done = true;
      listeners.delete(redraw); document.removeEventListener('keydown', onKey);
      root.replaceChildren(); document.body.style.overflow = '';
      if (!result && wcP && !wcP.session) wcP.disconnect?.().catch?.(() => {});
      resolve(result);
    };
    const onKey = e => { if (e.key === 'Escape') close(); };
    let wcOn = false, busy = '', seq = 0;
    const last = remembered();
    function row(w) {
      const ico = w.icon ? `<img src="${esc(w.icon)}" alt="" width="24" height="24">` : `<span class="w-ico" aria-hidden="true">${esc(w.name.slice(0, 1))}</span>`;
      return `<li><button type="button" class="w-row" data-w="${esc(w.id)}">${ico}<span class="w-name">${esc(w.name)}</span><span class="faint">${busy === w.id ? 'Waiting: unlock and approve in the wallet, or pick another' : w.id === last ? 'Last used' : w.id === 'walletconnect' ? 'QR · mobile and other wallets' : 'Installed'}</span></button></li>`;
    }
    function draw() {
      if (done) return;
      const inst = injected();
      const known = KNOWN.map(k => inst.has(k.rdns) ? row({ ...inst.get(k.rdns), name: inst.get(k.rdns).name || k.name })
        : `<li><span class="w-row off"><span class="w-ico" aria-hidden="true">${esc(k.name.slice(0, 1))}</span><span class="w-name">${esc(k.name)}</span><a href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">Install ↗</a></span></li>`);
      const others = [...inst.values()].filter(w => !KNOWN.some(k => k.rdns === w.id)).map(row);
      render(root, `
      <div class="modal-back" id="wp-back">
       <div class="modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wp-t">
        <div class="modal-head"><h2 id="wp-t">${esc(title)}</h2><span class="muted">${esc(note)}</span></div>
        <div class="modal-body">
         <ul class="wallets">${[...known, ...others].join('')}${wcOn ? row({ id: 'walletconnect', name: 'WalletConnect', icon: '' }) : ''}</ul>
         <div id="wp-qr"></div>
         ${extra}
         <div class="error" id="wp-err"></div>
        </div>
        <div class="modal-foot"><button type="button" id="wp-cancel">Cancel</button></div>
       </div>
      </div>`);
      root.querySelector('#wp-back').addEventListener('click', e => { if (e.target.id === 'wp-back') close(); });
      root.querySelector('#wp-cancel').onclick = () => close();
      root.querySelectorAll('[data-w]').forEach(b => b.onclick = () => choose(b.dataset.w));
      bind?.(root, close);
    }
    const err = m => { const e = root.querySelector('#wp-err'); if (e) e.textContent = m; };
    async function choose(id) {
      // A locked or ignored wallet can leave its request pending forever: picking another wallet supersedes it.
      const my = ++seq;
      busy = id; draw(); err('');
      try {
        let w;
        if (id === 'walletconnect') {
          // The relay must answer within 15 s (a bad project id or a blocked network never does).
          let shown = false;
          const slow = new Promise((_, no) => setTimeout(() => { if (!shown) no(new Error('WalletConnect did not respond. Try again, or use a browser wallet.')); }, 15000));
          slow.catch(() => {});
          wcP = await Promise.race([wcProvider(chainId), slow]);
          if (!wcP) throw new Error('WalletConnect is not configured');
          if (wcP.session) await wcP.disconnect().catch(() => {});
          wcP.on('display_uri', uri => {
            const q = root.querySelector('#wp-qr');
            if (!q || !/^wc:/.test(uri)) return;
            shown = true;
            render(q, `<div class="wc-qr"><img src="${esc(safeIcon(wcMod.qrDataUrl(uri)))}" alt="WalletConnect QR code"><p class="muted">Scan with a mobile wallet.</p><div class="actions"><a href="${esc(uri)}">Open in wallet app</a><button type="button" id="wc-copy">Copy link</button></div></div>`);
            q.querySelector('#wc-copy').onclick = e => { navigator.clipboard?.writeText(uri).then(() => { e.target.textContent = 'Copied'; }, () => {}); };
          });
          await Promise.race([wcP.connect(), slow]);
          w = { id, name: 'WalletConnect', icon: '', provider: wcP };
        } else {
          w = injected().get(id);
          if (!w) throw new Error('That wallet is no longer available');
          await w.provider.request({ method: 'eth_requestAccounts' });
        }
        if (done || my !== seq) return;
        const [a] = await w.provider.request({ method: 'eth_accounts' });
        if (!a) throw new Error('The wallet shared no account');
        await ensureChain(w.provider, chainId);
        if (done || my !== seq) return;
        setActive(w); remember(id);
        close({ account: String(a).toLowerCase(), provider: w.provider, id, name: w.name });
      } catch (e) {
        if (done || my !== seq) return;
        busy = ''; draw();
        err(e?.code === 4001 ? 'Request rejected in the wallet.' : e?.code === -32002 ? 'The wallet already has a request open. Open the wallet to answer it.' : (e?.shortMessage || e?.message || 'Could not connect'));
      }
    }
    const redraw = () => { if (!busy) draw(); };
    listeners.add(redraw);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    draw(); ask();
    wcProjectId().then(id => { wcOn = !!id; redraw(); });
  });
}
export { short as shortAddress };
