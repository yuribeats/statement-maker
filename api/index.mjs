// Vercel entry: every /api/* request is rewritten here (vercel.json) and handled by the shared core.
import { handle, jobs } from '../lib/core.mjs';

export default async function (req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.searchParams.get('__path') || '';
  // Cron endpoints: Vercel sends "Authorization: Bearer $CRON_SECRET".
  if (p === 'cron/floor' || p === 'cron/sync') {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) { res.writeHead(401); return res.end(); }
    await (p === 'cron/floor' ? jobs.refreshFloor() : jobs.syncTransfers());
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  return handle(req, res);
}
