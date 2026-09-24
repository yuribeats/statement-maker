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
// S7: the burn re-judges every price voted while FULL at its own floor (Party._burnPrice, re-audit M-1/M-2). Contract
// outcomes are Party.sol's: the M-2 rows are contracts/test/unit/ReAudit.t.sol (test_M2_*), the rest follow _burnPrice.
// Outcome: 'vote#id' (candidate applied as if executed), 'pending#id' (the price executed while FULL), 'default', or the
// revert reason ('floor needed').
const burnOut = p => { const b = S.burnPrice(p); return b.error || (b.pending ? `pending#${b.q.id}` : b.q ? `vote#${b.q.id}` : 'default'); };
const fixedAt = (id, eth, y, n = 0, extra = {}) => ({ ...prop(id, 'LIST', T, y, n, extra), args: { mode: 'fixed', value: String(eth), buyDelayHours: 1 } });
const bparty = extra => party({ params: { target: { mode: 'fixed', value: '1' }, buyDelayHours: 1 }, ...extra });
const candidate = (p, q) => { clock.now = T; p.proposals.push(q); S.noteCandidate(p, q); };
{ // S7a: a Fixed price passed at 41 YES while above the floor, not executed; the floor rises above it before the burn
  const p = bparty({ __floorEth: 100 });
  candidate(p, fixedAt(1, 150, 41));
  clock.now = T + 25 * H;
  row('S7a fixed 150 at 41 YES, floor 100 at the burn', burnOut(p), 'vote#1');
  p.__floorEth = 200;
  row('S7a fixed 150 at 41 YES, floor rose to 200 at the burn (skipped)', burnOut(p), 'default');
  p.proposals[0].votes = votes(60, 0);
  row('S7a same price with 60 YES, floor 200 (below-floor rule met)', burnOut(p), 'vote#1');
}
{ // S7b: the price executed while FULL (pending), ReAudit test_M2_fixedPending_rejudgedAtBurn / _pendingWith60 / _pendingNeedsFloorReading
  const mk = (y, floor) => {
    const q = fixedAt(1, 5, y); q.executed = true; q.executedAt = T + 25 * H;
    return bparty({ __floorEth: floor, proposals: [q], burnCandidates: [], listing: { mode: 'fixed', value: '5', buyDelayHours: 1, source: 'vote', proposal: 1 } });
  };
  clock.now = T + 26 * H;
  row('S7b pending fixed 5 at 41 YES, floor 5 at the burn', burnOut(mk(41, 5)), 'pending#1');
  row('S7b pending fixed 5 at 41 YES, floor 20 at the burn', burnOut(mk(41, 20)), 'default');
  row('S7b pending fixed 5 at 60 YES, floor 20 at the burn', burnOut(mk(60, 20)), 'pending#1');
  row('S7b pending fixed 5 at 41 YES, no floor reading', burnOut(mk(41, null)), 'floor needed');
  row('S7b pending fixed 5 at 60 YES, no floor reading', burnOut(mk(60, null)), 'pending#1');
}
{ // S7c: no pending price, a Fixed candidate at 41..59 YES and no floor reading: the burn is refused
  const p = bparty({ __floorEth: null });
  candidate(p, fixedAt(1, 150, 45));
  clock.now = T + 25 * H;
  row('S7c fixed candidate at 45 YES, no floor reading', burnOut(p), 'floor needed');
  const d = bparty({ __floorEth: null });
  clock.now = T + 25 * H;
  row('S7c no candidate, no pending, no floor reading (fixed default)', burnOut(d), 'default');
}
{ // S7d: only the latest 8 candidates are judged (residual: 41-YES groups can push an older one out of the window)
  const run = n => {
    const p = bparty({ __floorEth: 100 });
    candidate(p, fixedAt(1, 50, 60)); // passes below the floor
    for (let k = 2; k <= n; k++) candidate(p, fixedAt(k, 50, 41)); // below the floor with 41: skipped at the burn
    clock.now = T + 25 * H;
    return burnOut(p);
  };
  row('S7d 8 candidates, the oldest passes', run(8), 'vote#1');
  row('S7d 9 candidates, the oldest (out of the window) passes', run(9), 'default');
}
{ // S7e: the newest id wins, whatever order the candidates reached 41 in
  const p = bparty({ __floorEth: 100 });
  const a = fixedAt(5, 150, 30), b = fixedAt(3, 150, 41);
  clock.now = T; p.proposals.push(b, a); S.noteCandidate(p, a); S.noteCandidate(p, b); // #3 reaches 41 first
  a.votes = votes(41, 0); S.noteCandidate(p, a); // then #5
  clock.now = T + 25 * H;
  row('S7e candidates recorded [#3, #5], both pass', burnOut(p), 'vote#5');
  p.burnCandidates = [5, 3];
  row('S7e candidates recorded [#5, #3], both pass', burnOut(p), 'vote#5');
}
console.log(out.join('\n'));
