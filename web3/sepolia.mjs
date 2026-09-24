// Statement Maker on Sepolia: a working front end for the deployed test contracts. Bundled to public/sepolia.js.
// Your wallet signs every transaction. Nothing here touches mainnet.
import { createPublicClient, createWalletClient, custom, http, parseEther, formatEther, parseAbi, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import ABIS from './abis.json';

const ADDR = {
  credits: '0x1EA1a6f2f4428b646DE596498407d41613c75381',
  factory: '0xC42EECC0BC4c6122902752f8f286d64f3Ab3777C',
  cards: '0xD00863d45418F8F62412dF05291C898794525F8b',
  probe: '0x764c1bE51B6E0Ea6C870c9F57075C68E5Bbaf260',
};
const CREDITS_ABI = parseAbi([
  'function tokensOf(address) view returns (uint256[])',
  'function tokenURI(uint256) view returns (string)',
  'function setApprovalForAll(address,bool)',
  'function isApprovedForAll(address,address) view returns (bool)',
]);
const STATUS = ['OPEN', 'FULL', 'ASSEMBLED', 'SOLD', 'EXPIRED'];
const PRESETS = ['Deposit order', 'Number', 'Time', 'Rarity', 'Colors', 'Print', 'Weight', 'Eights', 'Ink', 'Random', 'Manual'];
const SLOTS = 80;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = (el, h) => el.replaceChildren(document.createRange().createContextualFragment(h));
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
const eth = w => w == null ? '—' : Number(formatEther(w)).toFixed(4) + ' ETH';

// Test hook: ?fork=<rpc>&as=<address> drives a local fork with an unlocked account instead of a wallet.
const qs = new URLSearchParams(location.search);
const FORK = qs.get('fork');
const provider = FORK
  ? { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [qs.get('as')];
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'wallet_switchEthereumChain') return null;
      const r = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (r.error) throw new Error(r.error.message);
      return r.result;
    } }
  : window.ethereum;
// Reads go through the wallet's own connection (the site's security policy allows no outside connections).
const pub = createPublicClient({ chain: sepolia, transport: FORK ? http(FORK) : custom(window.ethereum || { request: async () => { throw new Error('no wallet'); } }) });
let wallet = null, me = null;
const S = { parties: [], sel: null, party: null, credits: [], picks: new Set(), cardPicks: new Set(), log: [], busy: false };

function log(t, hash) { S.log.unshift({ t, hash, at: new Date().toLocaleTimeString() }); draw(); }

async function connect() {
  if (!provider) return alert('No wallet found. Install a browser wallet (e.g. MetaMask) and switch it to Sepolia.');
  const [a] = await provider.request({ method: 'eth_requestAccounts' });
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] }); } catch {}
  me = getAddress(a);
  wallet = createWalletClient({ chain: sepolia, transport: custom(provider), account: me });
  await refresh();
}

async function tx(label, req) {
  if (S.busy) return;
  S.busy = true; draw();
  try {
    // Simulate first: a transaction the contract would reject is never sent, and its reason is shown.
    try { await pub.simulateContract({ ...req, account: me }); }
    catch (e) { const m = (e.shortMessage || e.message).match(/Bad\("([^"]+)"\)|reason: ([^\n]+)|reverted with.*?: ([^\n]+)/); log(label + ' · refused by the contract: ' + (m ? (m[1] || m[2] || m[3]) : (e.shortMessage || e.message).split('\n')[0])); return false; }
    const hash = await wallet.writeContract({ ...req, account: me, chain: sepolia });
    log(label + ' · sent', hash);
    const r = await pub.waitForTransactionReceipt({ hash });
    log(label + (r.status === 'success' ? ' · confirmed' : ' · FAILED'), hash);
    return r.status === 'success';
  } catch (e) {
    log(label + ' · ' + (e.shortMessage || e.message).split('\n')[0]);
    return false;
  } finally { S.busy = false; await refresh(); }
}

const P = addr => ({ address: addr, abi: ABIS.Party });
const read = (c, functionName, args = []) => pub.readContract({ ...c, functionName, args });

async function refresh() {
  if (!me) return draw();
  try { chainSkew = Number((await pub.getBlock()).timestamp) - Math.floor(Date.now() / 1000); } catch {}
  const n = Number(await read({ address: ADDR.factory, abi: ABIS.Factory }, 'partiesCount'));
  const addrs = await Promise.all([...Array(n).keys()].map(i => read({ address: ADDR.factory, abi: ABIS.Factory }, 'parties', [BigInt(i)])));
  S.parties = await Promise.all(addrs.map(async a => ({ addr: a, name: (await read(P(a), 'params')).name, status: STATUS[await read(P(a), 'status')], count: Number(await read(P(a), 'count')) })));
  S.credits = (await read({ address: ADDR.credits, abi: CREDITS_ABI }, 'tokensOf', [me])).map(Number);
  if (S.sel) await loadParty(S.sel);
  draw();
}

async function loadParty(a) {
  const c = P(a);
  const [params, status, count, deadline, ask, askLiveAt, perCard, nProps, host, timeUnit, order, owed, epoch] = await Promise.all(
    ['params', 'status', 'count', 'deadline', 'ask', 'askLiveAt', 'perCard', 'proposalCount', 'host', 'timeUnit', 'depositOrder', 'owed', 'priceEpoch']
      .map(f => read(c, f, f === 'owed' ? [me] : [])));
  const cards = await Promise.all(order.map(id => read(c, 'cardOfCredit', [id])));
  const holders = await Promise.all(cards.map(cd => read({ address: ADDR.cards, abi: ABIS.Cards }, 'ownerOf', [cd]).catch(() => null)));
  let myCards = cards.filter((cd, i) => holders[i] === me);
  if (STATUS[status] === 'ASSEMBLED' || STATUS[status] === 'SOLD') {
    // After the burn the deposit order is empty; find this party's live cards by scanning card ids.
    const next = Number(await read({ address: ADDR.cards, abi: ABIS.Cards }, 'nextId'));
    const all = [...Array(next - 1).keys()].map(i => BigInt(i + 1));
    const party = await Promise.all(all.map(id => read({ address: ADDR.cards, abi: ABIS.Cards }, 'partyOf', [id])));
    const mine = all.filter((id, i) => party[i] === a);
    const own = await Promise.all(mine.map(id => read({ address: ADDR.cards, abi: ABIS.Cards }, 'ownerOf', [id]).catch(() => null)));
    myCards = mine.filter((id, i) => own[i] === me);
  }
  const props = await Promise.all([...Array(Number(nProps)).keys()].map(async i => ({ i, ...(await read(c, 'proposal', [BigInt(i)])), my: Number(await read(c, 'voteOf', [BigInt(i), me])) })));
  S.party = { a, params, status: STATUS[status], count: Number(count), deadline: Number(deadline), ask, askLiveAt: Number(askLiveAt), perCard, props, host, timeUnit: Number(timeUnit), order, myCards, owed, epoch: Number(epoch) };
}

// Chain time, not the computer's clock: rules are judged by block timestamps.
let chainSkew = 0;
const now = () => Math.floor(Date.now() / 1000) + chainSkew;
const mins = s => s <= 0 ? 'now' : s < 90 ? `${s}s` : `${Math.ceil(s / 60)} min`;

async function floorSig(mode) {
  const at = FORK ? Number((await pub.getBlock()).timestamp) : 0;
  const r = await (await fetch(`/api/sepolia/floor?mode=${mode}${at ? '&at=' + at : ''}`)).json();
  if (r.error) throw new Error(r.error);
  return { floorWei: BigInt(r.floorWei), issuedAt: BigInt(r.issuedAt), sig: r.sig };
}
const noFloor = { floorWei: 0n, issuedAt: 0n, sig: '0x' };

async function buildOrder() {
  const p = S.party, preset = p.params.arrangement;
  const ids = [...p.order];
  if (preset === 0 || preset === 10) return ids; // Deposit order; Manual uses deposit order here (host may reorder in a later version)
  if (preset === 9) return [...(await read({ address: ADDR.probe, abi: ABIS.KeyProbe }, 'shuffle', [ids, p.params.seed]))];
  const keys = await read({ address: ADDR.probe, abi: ABIS.KeyProbe }, 'keys', [preset, ADDR.credits, ids]);
  return ids.map((id, i) => [id, keys[i]]).sort((x, y) => (x[1] < y[1] ? -1 : 1)).map(x => x[0]);
}

// ------------------------------------------------------------------ view
function draw() {
  const app = $('#app');
  if (!me) {
    render(app, `<div class="intro"><div><h1>Statement Maker · Sepolia</h1><p class="muted">A working test version on the Sepolia testnet. Test Credits only; nothing touches mainnet. Rule clock: 1 minute here stands for 1 hour.</p></div></div>
      <button class="cta" id="connect">Connect wallet (Sepolia)</button>`);
    $('#connect').onclick = connect;
    return;
  }
  const p = S.party;
  render(app, `
  <div class="intro"><div><h1>Statement Maker · Sepolia</h1><p class="muted">Test contracts · ${short(me)} · ${S.credits.length} test Credits · 1 minute = 1 hour</p></div><button type="button" id="reload" class="muted">Refresh</button></div>
  <div class="store-only"><strong>Sold only on Statement Maker.</strong> A party's Statement can only be sold through its own contract at the party's price. Credit Cards can be traded anywhere.</div>
  <div class="works">
   <section>
    <div class="panel"><h2>Parties · ${S.parties.length}</h2>
     <div class="rows">${S.parties.map(q => `<div><span><a href="#" data-sel="${q.addr}">${esc(q.name)}</a></span><strong>${q.count}/80 · ${q.status}</strong></div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>
    ${p ? partyView(p) : ''}
   </section>
   <section>
    <div class="panel"><h2>Open a party</h2>
     <div class="field"><label>Name</label><input id="n" value="Sepolia test" maxlength="60"></div>
     <div class="field"><label>Arrangement</label><select id="pre">${PRESETS.map((x, i) => `<option value="${i}">${x}</option>`).join('')}</select></div>
     <div class="field"><label>Minimum deposit</label><input id="md" type="number" value="1" min="1" max="80"></div>
     <div class="field"><label>Deadline, days</label><div><input id="dd" type="number" value="3" min="1" max="60"><div class="hint">1 day here = 24 minutes</div></div></div>
     <div class="field"><label>Default price, ETH</label><input id="dp" type="number" step="0.001" value="0.01"></div>
     <p class="note">Your connected wallet then deposits the Credits you select below: at least the minimum.</p>
     <button class="cta" id="create" ${S.busy ? 'disabled' : ''}>Open party</button>
    </div>
    <div class="panel"><h2>Your test Credits · ${S.credits.length}</h2>
     <p class="muted">Select Credits to deposit into the selected party.</p>
     <div class="actions"><button type="button" id="pick80">Select all</button><button type="button" id="pick0">Clear</button><span>${S.picks.size} selected</span></div>
     <div class="rows" style="max-height:220px;overflow:auto">${S.credits.map(id => `<div><span><label class="check"><input type="checkbox" data-pick="${id}" ${S.picks.has(id) ? 'checked' : ''}> Credit #${id}</label></span><strong></strong></div>`).join('')}</div>
    </div>
    <div class="panel"><h2>Transactions</h2><div class="rows">${S.log.slice(0, 20).map(l => `<div><span>${l.at}</span><strong style="text-transform:none;text-align:left">${esc(l.t)} ${l.hash ? `<a href="https://sepolia.etherscan.io/tx/${l.hash}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</strong></div>`).join('') || '<p class="muted">None yet.</p>'}</div></div>
   </section>
  </div>`);
  bind();
}

function partyView(p) {
  const t = now();
  const isHost = p.host === me;
  const buyAt = p.askLiveAt + 24 * p.timeUnit;
  return `<div class="panel"><h2>${esc(p.params.name)} · ${p.status}</h2>
    <div class="rows">
     <div><span>Contract</span><strong><a href="https://sepolia.etherscan.io/address/${p.a}" target="_blank" rel="noopener noreferrer">${short(p.a)} ↗</a></strong></div>
     <div><span>Filled</span><strong>${p.count}/80</strong></div>
     <div><span>Arrangement</span><strong>${PRESETS[p.params.arrangement]}</strong></div>
     <div><span>Deadline</span><strong>${mins(p.deadline - t)}</strong></div>
     <div><span>Ask</span><strong>${p.ask ? eth(p.ask) : '—'}${p.ask && p.status === 'ASSEMBLED' ? ` · buy opens ${mins(buyAt - t)}` : ''}</strong></div>
     <div><span>Your cards</span><strong>${p.myCards.length}</strong></div>
     ${p.status === 'SOLD' ? `<div><span>Per card</span><strong>${eth(p.perCard)}</strong></div>` : ''}
     ${p.owed ? `<div><span>Owed to you</span><strong>${eth(p.owed)}</strong></div>` : ''}
    </div>
    <div class="actions" style="margin-top:12px">
     ${p.status === 'OPEN' ? `<button type="button" class="cta" id="deposit">Deposit ${S.picks.size} selected</button><button type="button" id="redeem">Redeem my cards</button>` : ''}
     ${p.status === 'FULL' ? `<button type="button" class="cta" id="assemble">Burn the 80 (${PRESETS[p.params.arrangement]})</button>` : ''}
     ${p.status === 'ASSEMBLED' && p.ask ? `<button type="button" class="cta" id="buy" ${t < buyAt ? 'disabled' : ''}>Buy for ${eth(p.ask)}</button>` : ''}
     ${p.status === 'SOLD' && p.myCards.length ? `<button type="button" class="cta" id="claim">Claim ${p.myCards.length} cards</button>` : ''}
     ${p.owed ? `<button type="button" id="withdraw">Withdraw ${eth(p.owed)}</button>` : ''}
     ${p.status === 'EXPIRED' && p.myCards.length ? `<button type="button" class="cta" id="redeem">Redeem my cards</button>` : ''}
    </div>
    ${p.status === 'FULL' || p.status === 'ASSEMBLED' ? `
    <h2 style="margin:24px 0 8px">Price votes</h2>
    <div class="actions"><span class="muted">Propose</span><input id="pp" type="number" step="0.001" value="0.02" style="width:90px"> ETH
     <select id="ph">${[24, 48, 72, 168].map(h => `<option value="${h}">${h} min</option>`).join('')}</select>
     <button type="button" id="propose">Propose price</button>${p.status === 'ASSEMBLED' && p.ask ? '<button type="button" id="cancel">Propose cancel</button>' : ''}</div>
    ${p.props.slice().reverse().map(q => {
      const open = t < Number(q.endsAt), lapsed = t > Number(q.endsAt) + 168 * p.timeUnit;
      return `<div class="prop"><div class="prop-head"><span>#${q.i} <strong>${q.cancel ? 'Cancel listing' : 'Price ' + eth(q.price.value)}</strong></span><span class="chip">${q.executed ? 'Executed' : Number(q.epoch) !== p.epoch ? 'Superseded' : lapsed ? 'Lapsed' : open ? 'Voting · ' + mins(Number(q.endsAt) - t) : 'Closed'}</span></div>
        <div class="prop-nums"><span>Yes ${q.yes} · No ${q.no}${q.deadlock ? ' · deadlock rule' : ''}</span><span>${q.my === 1 ? 'You: yes' : q.my === 2 ? 'You: no' : ''}</span></div>
        <div class="actions">${open ? `<button type="button" data-vote="${q.i}" data-yes="1">Yes</button><button type="button" data-vote="${q.i}" data-yes="0">No</button>` : ''}${!open && !q.executed && Number(q.epoch) === p.epoch && !lapsed ? (Number(q.no) > 0 && !q.deadlock ? '<span class="blocked">Blocked by a NO vote</span>' : Number(q.yes) < (q.deadlock ? 54 : 41) ? '<span class="muted">Did not reach 41 yes</span>' : `<button type="button" class="cta" data-exec="${q.i}">Execute</button> <span class="faint">prices below the floor need 60 yes</span>`) : ''}</div></div>`;
    }).join('')}` : ''}
  </div>`;
}

function bind() {
  $('#reload')?.addEventListener('click', refresh);
  document.querySelectorAll('[data-sel]').forEach(b => b.onclick = async e => { e.preventDefault(); S.sel = b.dataset.sel; await refresh(); });
  document.querySelectorAll('[data-pick]').forEach(b => b.onchange = () => { const id = Number(b.dataset.pick); b.checked ? S.picks.add(id) : S.picks.delete(id); draw(); });
  $('#pick80')?.addEventListener('click', () => { S.credits.slice(0, 80).forEach(id => S.picks.add(id)); draw(); });
  $('#pick0')?.addEventListener('click', () => { S.picks.clear(); draw(); });
  $('#create')?.addEventListener('click', async () => {
    const params = {
      name: $('#n').value, description: 'Sepolia test party', filters: 'any', eligibleRoot: '0x' + '00'.repeat(32),
      minDeposit: Number($('#md').value), durationDays: Number($('#dd').value), voteHours: 48, arrangement: Number($('#pre').value),
      seed: BigInt(Math.floor(Math.random() * 1e9)), defaultPrice: { mode: 0, value: parseEther(String($('#dp').value)) }, floorMode: 0,
    };
    const before = S.parties.length;
    if (await tx('Open party', { address: ADDR.factory, abi: ABIS.Factory, functionName: 'createParty', args: [params] })) S.sel = S.parties[before]?.addr || S.sel;
    await refresh();
  });
  $('#deposit')?.addEventListener('click', async () => {
    const ids = [...S.picks].map(BigInt);
    const a = S.party.a;
    if (!(await read({ address: ADDR.credits, abi: CREDITS_ABI }, 'isApprovedForAll', [me, a]))) {
      if (!(await tx('Approve this party to move your Credits', { address: ADDR.credits, abi: CREDITS_ABI, functionName: 'setApprovalForAll', args: [a, true] }))) return;
    }
    if (await tx(`Deposit ${ids.length} Credits`, { ...P(a), functionName: 'deposit', args: [ids, []] })) S.picks.clear();
    await tx('Revoke approval', { address: ADDR.credits, abi: CREDITS_ABI, functionName: 'setApprovalForAll', args: [a, false] });
  });
  $('#redeem')?.addEventListener('click', () => tx(`Redeem ${S.party.myCards.length} cards`, { ...P(S.party.a), functionName: 'redeem', args: [S.party.myCards] }));
  $('#assemble')?.addEventListener('click', async () => {
    if (!FORK && !confirm('Burning is permanent: the 80 test Credits become one Statement. Continue?')) return;
    const order = await buildOrder();
    tx('Burn the 80', { ...P(S.party.a), functionName: 'assemble', args: [order, noFloor], gas: 20_000_000n });
  });
  $('#propose')?.addEventListener('click', () => tx('Propose price', { ...P(S.party.a), functionName: 'propose', args: [{ mode: 0, value: parseEther(String($('#pp').value)) }, false, Number($('#ph').value)] }));
  $('#cancel')?.addEventListener('click', () => tx('Propose cancel', { ...P(S.party.a), functionName: 'propose', args: [{ mode: 0, value: 0n }, true, 24] }));
  document.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => tx(`Vote ${b.dataset.yes === '1' ? 'yes' : 'no'} on #${b.dataset.vote}`, { ...P(S.party.a), functionName: 'vote', args: [BigInt(b.dataset.vote), b.dataset.yes === '1'] }));
  document.querySelectorAll('[data-exec]').forEach(b => b.onclick = async () => {
    let f = noFloor;
    try { f = await floorSig(S.party.params.floorMode); } catch (e) { return log('Floor reading unavailable: ' + e.message); }
    tx(`Execute #${b.dataset.exec}`, { ...P(S.party.a), functionName: 'execute', args: [BigInt(b.dataset.exec), f] });
  });
  $('#buy')?.addEventListener('click', () => tx('Buy the Statement', { ...P(S.party.a), functionName: 'buy', args: [S.party.ask], value: S.party.ask }));
  $('#claim')?.addEventListener('click', () => tx(`Claim ${S.party.myCards.length} cards`, { ...P(S.party.a), functionName: 'claim', args: [S.party.myCards] }));
  $('#withdraw')?.addEventListener('click', () => tx('Withdraw', { ...P(S.party.a), functionName: 'withdraw', args: [] }));
}

draw();
setInterval(() => { if (me && !S.busy) refresh(); }, 20_000);
