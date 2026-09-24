// Site side of contracts/test/diff/DeadlockDiff.t.sol: the same scenarios through the copied deadlocked()/tally()/priceEth().
import { S, clock } from './server-copy.mjs';

const D = 864e5, H = 36e5;
const T = clock.now;
const snap = Object.fromEntries([...Array(80)].map((_, i) => ['v' + i, 1]));
const votes = (y, n) => { const o = {}; for (let i = 0; i < y; i++) o['v' + i] = true; for (let i = 79; i >= 80 - n; i--) o['v' + i] = false; return o; };
const prop = (id, type, at, y, n, extra = {}) => ({ id, type, args: type === 'LIST' ? { mode: 'fixed', value: 300 } : {}, at, endsAt: at + 24 * H, snapshot: snap, votes: votes(y, n), ...extra });
const party = extra => ({ params: {}, fullAt: T, proposals: [], __floorEth: 100, ...extra });
const out = [];
const row = (name, site, contract) => out.push(`${site === contract ? 'SAME' : 'DIFF'}  ${name}: site=${site} contract=${contract}`);

{ // S1
  const p = party();
  for (let k = 0; k < 3; k++) p.proposals.push(prop(k + 1, 'LIST', T + k * 25 * H, 50, 1));
  clock.now = T + 4 * 25 * H;
  const d = S.deadlocked(p, 'LIST');
  p.proposals.push(prop(4, 'LIST', clock.now, 60, 1, { override: d, executed: true }));
  clock.now += 25 * H;
  row('S1 deadlock flag on a new LIST after 3 blocked + 1 executed', S.deadlocked(p, 'LIST'), true);
}
{ // S2
  const p = party({ assembled: { at: T } });
  for (let k = 0; k < 3; k++) p.proposals.push(prop(k + 1, 'CANCEL_LISTING', T + k * 25 * H, 50, 1));
  clock.now = T + 4 * 25 * H;
  row('S2 three blocked CANCEL_LISTING proposals count toward deadlock', S.deadlocked(p, 'LIST'), false);
}
{ // S3
  const p = party({ assembled: { at: T + 20 * D } });
  clock.now = T + 31 * D;
  row('S3 deadlock at FULL+31d when assembled at FULL+20d', S.deadlocked(p, 'LIST'), true);
}
{ // S4
  const p = party();
  for (let k = 0; k < 3; k++) p.proposals.push(prop(k + 1, 'LIST', T + k * 25 * H, 50, 1));
  clock.now = T + 4 * 25 * H;
  row('S4 three NO-blocked proposals, nobody calls countBlocked', S.deadlocked(p, 'LIST'), false);
}
{ // S5
  const p = party({ assembled: { at: T + 30 * H } });
  const q = prop(1, 'LIST', T, 41, 0);
  clock.now = T + 31 * H;
  row('S5 LIST passed while FULL, executed after assembly', S.tally(p, q).executable, false);
}
{ // S6
  const p = party({ __floorEth: 100 });
  const listing = { mode: 'floorPct', value: 10 };
  const at100 = S.priceEth(listing, p);
  p.__floorEth = 50;
  row(`S6 ask after floor 100→50 on a floor+10% listing (was ${at100})`, S.priceEth(listing, p), at100);
}
console.log(out.join('\n'));
