// Local dev server for Statement Maker. Production runs the same core on Vercel (api/index.mjs).
import http from 'node:http';
import { handle, jobs, block } from './lib/core.mjs';

const PORT = Number(process.env.PORT || 8088);
http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`statement maker on http://localhost:${PORT}  (snapshot block ${block})`));
// On Vercel these run as cron jobs (vercel.json); locally, on timers.
jobs.refreshFloor(); setInterval(jobs.refreshFloor, 60_000);
jobs.syncTransfers(); setInterval(jobs.syncTransfers, 30_000);
