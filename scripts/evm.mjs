// Local anvil holding the Credits art contract's mainnet bytecode. Its functions are pure, so no fork is needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';

export const ART = '0xFbE816B82547B483C7DFfC5b14C75eC84f8c1985';
export const artAbi = parseAbi([
  'struct Read { bytes32 hash; uint256 marks; uint256 capacity; uint256 plates; string colors; uint256 eights; string tier; string weight; string register; string eightsLabel; }',
  'function describe(bytes21 seed, uint64 paidAt) pure returns (Read)',
  'function svg(bytes21 seed, uint64 paidAt) pure returns (string)',
]);
const PORT = Number(process.env.ANVIL_PORT || 8547);

export async function startEvm() {
  const url = `http://127.0.0.1:${PORT}`;
  const proc = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '100000'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers: { 'content-type': 'application/json' } }); break; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  const code = fs.readFileSync(new URL('../data/art.bytecode', import.meta.url), 'utf8').trim();
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setCode', params: [ART, code] }) });
  // Refuse to run against anything but the exact art bytecode (e.g. a stray process already on the port).
  const got = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [ART, 'latest'] }) })).json();
  if (String(got.result).toLowerCase() !== code.toLowerCase()) { proc.kill(); throw new Error('local EVM does not hold the Credits art bytecode'); }
  proc.on('exit', c => { if (c) { console.error('anvil exited', c); process.exit(1); } });
  const client = createPublicClient({ transport: http(url, { batch: { batchSize: 200 } }) });
  return { client, stop: () => proc.kill() };
}
