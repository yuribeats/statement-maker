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
  if (!p.proposals.every(q => S.countBlocked(p, q))) throw new Error('S1 setup: countBlocked rejected'); // as the contract test
  const d = S.deadlocked(p, 'LIST');
  if (!d) throw new Error('S1 setup: 3 counted blocks should deadlock');
  p.proposals.push(prop(4, 'LIST', clock.now, 60, 1, { override: d }));
  clock.now += 25 * H;
  const q4 = p.proposals[3];
  if (!S.tally(p, q4).executable) throw new Error('S1 setup: deadlock proposal should execute');
  q4.executed = true; q4.executedAt = clock.now; // as the execute route does
  for (const q of p.proposals) if (q !== q4 && !q.executed) q.superseded = true;
  row('S1 deadlock flag on a new LIST after 3 counted blocks + 1 executed', S.deadlocked(p, 'LIST'), false);
}
{ // S2
  const p = party({ assembled: { at: T } });
  for (let k = 0; k < 3; k++) p.proposals.push(prop(k + 1, 'CANCEL_LISTING', T + k * 25 * H, 50, 1));
  clock.now = T + 4 * 25 * H;
  row('S2 countBlocked accepts a blocked CANCEL_LISTING', p.proposals.some(q => S.countBlocked(p, q)), false);
  row('S2 three blocked CANCEL_LISTING proposals count toward deadlock', S.deadlocked(p, 'LIST'), false);
}
{ // S3
  const p = party({ assembled: { at: T + 20 * D } });
  clock.now = T + 31 * D;
  row('S3 deadlock at FULL+31d when assembled at FULL+20d', S.deadlocked(p, 'LIST'), false);
  clock.now = T + 50 * D;
  row('S3b deadlock exactly 30d after assembly', S.deadlocked(p, 'LIST'), false);
  clock.now = T + 50 * D + 1000;
  row('S3c deadlock 30d + 1s after assembly', S.deadlocked(p, 'LIST'), true);
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
  const listing = S.goLive(S.cleanTarget({ mode: 'floorPct', value: 10 }), p); // the default price going live at the burn
  const at100 = S.listingEth(listing, p);
  p.__floorEth = 50;
  row(`S6 ask after floor 100→50 on a floor+10% listing (was ${at100})`, S.listingEth(listing, p), 110);
}
console.log(out.join('\n'));
