// Pulls every Distributed + Transfer log for Credits and writes data/credits.json (id, seed, paidAt, owner).
import fs from 'node:fs';
const C = '0x97630aa70ab14ed9883b41dafccbc11349723043';
const RPC = `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const DIST = '0xd531eb90fd214f28c84ac8e9b86c5b3cbb798ceceb98046d1de96857d283cd0c';
const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const START = 26037294;
async function rpc(method, params) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (!j.error) return j.result;
    if (/range|10000|too many|limit/i.test(j.error.message)) throw Object.assign(new Error(j.error.message), { split: true });
    await new Promise(s => setTimeout(s, 1000 * (a + 1)));
  }
  throw new Error('rpc failed ' + method);
}
async function logs(topic, from, to) {
  try {
    return await rpc('eth_getLogs', [{ address: C, topics: [topic], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  } catch (e) {
    if (!e.split || from === to) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...await logs(topic, from, mid), ...await logs(topic, mid + 1, to)];
  }
}
const latest = parseInt(await rpc('eth_blockNumber', []), 16);
const credits = new Map();
for (let b = START; b <= latest; b += 500) {
  const e = Math.min(b + 499, latest);
  for (const l of await logs(DIST, b, e)) {
    const id = parseInt(l.topics[1], 16);
    const d = l.data.slice(2);
    credits.set(id, { id, seed: Buffer.from(d.slice(0, 42), 'hex').toString('latin1'), seedHex: '0x' + d.slice(0, 42), paidAt: parseInt(d.slice(64, 128), 16), minter: '0x' + l.topics[2].slice(26) });
  }
  for (const l of await logs(XFER, b, e)) {
    const id = parseInt(l.topics[3], 16), to = '0x' + l.topics[2].slice(26);
    const c = credits.get(id) || credits.set(id, { id }).get(id);
    c.owner = to;
  }
  process.stdout.write(`\r${e}/${latest} credits=${credits.size}`);
}
const out = [...credits.values()].sort((a, b) => a.id - b.id);
fs.writeFileSync(new URL('../data/credits.json', import.meta.url), JSON.stringify({ block: latest, credits: out }));
console.log('\nwrote', out.length, 'burned', out.filter(c => c.owner === '0x0000000000000000000000000000000000000000').length);
