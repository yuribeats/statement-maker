// Vercel entry: every /api/* request is rewritten here (vercel.json) and handled by the shared core.
import crypto from 'node:crypto';
import { handle, jobs } from '../lib/core.mjs';

// Fails closed when CRON_SECRET is unset or empty; constant-time compare on equal-length buffers.
function cronOk(header) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`), got = Buffer.from(String(header || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export default async function (req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.searchParams.get('__path') || '';
  // Cron endpoints: Vercel sends "Authorization: Bearer $CRON_SECRET".
  if (p === 'cron/floor' || p === 'cron/sync') {
    if (!cronOk(req.headers.authorization)) { res.writeHead(401); return res.end(); }
    await (p === 'cron/floor' ? jobs.refreshFloor() : jobs.syncTransfers());
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  return handle(req, res);
}
