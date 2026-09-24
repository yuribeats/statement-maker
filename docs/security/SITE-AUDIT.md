> **Status (2026-09-24):** findings 1, 2, 4, 5, 6, 8 and the cron check fixed and verified on production;
> 3 fixed (settings lock once others deposit; minimum buy wait left at the owner's chosen 0–72h design);
> 7 documented (stateless sessions, 7-day expiry); 9 mitigated in code (dev mode ignores DATABASE_URL, since the
> Neon integration pins it to every Vercel environment and it cannot be removed per environment).

# Statement Maker site audit (2026-09-24)

Scope: lib/core.mjs, lib/store.mjs, api/index.mjs, vercel.json, public/*, web3/sepolia.mjs, SPEC §11. Production probed with GET requests and rejected inputs only. Write tests ran on an isolated local copy (scratchpad, port 8099, own data/), not the user's :8088 instance. Note: commit da5a61f does not exist; the earlier audit commit is 3b3369b (plus e7156b0).

## Findings, ranked

### 1. HIGH: anyone can grow the shared state document without limit (DoS). CONFIRMED locally
Each sign-in writes `state.terms[addr] = {message, signature}` into the one JSON document that every GET reads and every POST rewrites. Sign-in needs no Credit, and wallets cost nothing: generate a random key, request `POST /api/auth/nonce`, then sign and `POST /api/auth/verify`.
Local result: 40 throwaway wallets added 30,120 bytes (753 per sign-in) in 5.4 s from one serial client. At about 1M sign-ins the document reaches about 750 MB, and every request must load and parse it. The signature regex has no length cap (`/^0x[0-9a-fA-F]+$/`, up to the 64 KB body limit). With a smart-contract or ERC-6492 counterfactual wallet that accepts any signature, a sign-in could store up to about 64 KB.
Fix: move terms acceptances into their own table (`terms(address pk, version, message, signature, at)`) and read it per address. Cap the signature at about 2 KB. Rate-limit nonce and verify by IP.

### 2. MEDIUM: every POST, including unauthenticated ones, takes the global row lock; RPC calls run while the lock is held. SUSPECTED (code); partly CONFIRMED locally
`handle()` wraps every POST in `withState`, which runs `SELECT ... FOR UPDATE` on the single `state` row. `POST /api/auth/nonce` needs no session, and on success it commits a rewrite of the whole document. Locally, `nonce POST rewrote state.json = true`. Rejected POSTs (404/4xx) still hold the lock until rollback. Two paths call remote services under the lock: `checkDeposit` makes up to 80 `ownerOf` RPC calls, and `verifyMessage` can make an `eth_call`. So one slow RPC stalls all writes site-wide, and a flood of nonce POSTs queues behind the lock and uses up Neon pool connections.
Fix: route read-only POSTs (`auth/nonce`, `eligible`, `logout`) outside `withState`. Do the RPC work (ownerOf, verifyMessage) before opening the transaction, then re-check inside it. Take the lock only for mutating routes.

### 3. MEDIUM: host can change price terms after others deposit. SUSPECTED (code)
`POST /api/parties/:id/params` lets the host change `target` and `arrangement` at any time while the party is OPEN, including after other holders have deposited. The UI tells depositors that "Depositing accepts this party's defaults". The default listing goes live at assembly and is not subject to the below-floor 60/80 rule, and the buy delay is only 0 to 72 hours, shorter than any voting window.
Fix: freeze `target` and `arrangement` once any non-host deposit exists, or require a card-holder vote to change them. Also apply the below-floor rule to the default listing, and enforce a minimum buy delay of at least one voting window.

### 4. LOW: `POST /api/statements/:id/buy` skips the price check when `maxPriceEth` is missing. SUSPECTED (code)
`Number(undefined) < price` evaluates to false, so a buy request without `maxPriceEth` goes through at whatever the seller's current price is. A seller who reprices between view and click is protected against only because the site's own client sends the field.
Fix: `if (!(Number(x.maxPriceEth) >= q.resale.priceEth)) return 400`.

### 5. LOW: malformed headers cause 500s. CONFIRMED locally
A `Cookie: sm_session=%E0%A4%A` header returns 500 because `decodeURIComponent` throws. An `Origin: null` header on a POST returns 500 because `new URL('null')` throws. Both roll back, and nothing is exploitable.
Fix: wrap the decode in try/catch, and treat an unparseable Origin as cross-origin (403).

### 6. LOW: the function serves public files through `__path`. CONFIRMED on prod
`GET /api/index?__path=../app.js` and `/api/..%2Fapp.js` return public/app.js from the function (also `../sepolia.js` and `../`, which returns index.html). No files outside public/ were reachable (`../../lib/core.mjs` and `data/` both returned 404). This bypasses no gate. It only costs function time and skips the CDN.
Fix: in `route()`, when `__path` resolves outside `/api/`, return 404, and serve static files only when not on Vercel.

### 7. LOW: sessions cannot be revoked. CONFIRMED locally
Sessions are stateless HMAC tokens valid for 7 days. Logout only clears the cookie, so a stolen token stays valid until it expires. SPEC §11 still describes "random 256-bit token", which no longer matches the code. The token parser also ignores extra `.segments` (a token with `.junk` appended still verified), which is harmless.
Fix: add a per-address `sessionEpoch` in the store and bump it on logout. Update SPEC.

### 8. LOW: party gate leaks. CONFIRMED on prod
`/api/cards/:addr` and `/api/card/:n` return party ids, names and status for parties that are not yet assembled, with no gate. The same data is on-chain later; this only matters if the gate is meant to hide it.

### 9. LOW / config: DATABASE_URL is set for the Preview and Development environments too
Running `vercel env pull` and then the local server in dev mode would connect to the production database with `/api/auth/dev` enabled, so anyone could sign in as any address. Preview deployments currently fail closed (SESSION_SECRET is Production-only) and are behind Vercel Authentication (old deployment URLs return 302).
Fix: use a separate Neon branch for Preview and Development.

### 10. INFO: `?fork=&as=` test hook ships in public/sepolia.js
The CSP `connect-src 'self'` blocks outside RPC URLs, and `/api/dev/fork` is absent on prod, so it is inert there. Consider stripping it from the production bundle.

## Checked and sound
- **Session cookie:** HMAC-SHA256 compared with timingSafeEqual. Changing the address or expiry gives null (tested). HttpOnly, SameSite=Strict, Secure in production. `SESSION_SECRET` is required when NODE_ENV=production (prod reports `dev:false`). Session and nonce MAC inputs cannot collide: the session input has exactly one `.`, the nonce input has `|` and no `.`.
- **Sign-in:** the nonce MAC binds address, nonce, expiry and sha256 of the whole message, so the host, URI, chain ID and terms text cannot be altered. Altered message, swapped address line and replay were all rejected (tested). Single use is enforced by the store (`INSERT ... ON CONFLICT`), and the 10-minute expiry is checked.
- **Terms:** the terms version is checked on every mutating route.
- **CSRF:** a cross-origin Origin gets 403 (tested). JSON-only bodies. SameSite=Strict. Logout skips the content-type check, which is harmless.
- **Authorization per route:** vote (snapshot), execute and propose (members), params (host and OPEN), Manual burn (host only), transfer and claim (holder of the card), list and unlist (owner or seller), gate on parties, wallet and eligible. No IDOR found. Rollback-on-4xx covers every partial mutation (the only side effect outside the transaction is `moveCredit`, which reflects chain truth).
- **Concurrency:** the file store serializes writes. Postgres uses `FOR UPDATE` in one transaction per POST. AsyncLocalStorage gives each request its own state copy, so two requests in one instance cannot see or overwrite each other's state.
- **Input validation:** filters are reduced to known values, targets must be finite and bounded, arrangement must be a known preset, name and description are length-capped, `buyDelayHours` is 0–72, resale `priceEth` rejects NaN, Infinity, 0, negative and ≥1e6, id arrays are sliced.
- **XSS:** every `render()` interpolation is escaped with `esc()` or `Number()`. OpenSea `url` is built server-side with a fixed `https://opensea.io/` prefix and escaped; `seller` and `name` are escaped. The CSP `script-src 'self'` backs this up. SVG endpoints send `content-security-policy: sandbox`, image/svg+xml and nosniff. Party names in cards are XML-escaped.
- **Cron:** `/api/cron/floor` returns 401 without the secret on prod. CRON_SECRET is set for Production. If it were unset, `Bearer undefined` would pass; add `if (!process.env.CRON_SECRET) return 401`.
- **`__path` injection:** it cannot reach cron without the secret (`/api/x?__path=cron/sync` returned 404), and it bypasses no gate.
- **Sepolia floor oracle:** `?at=` is ignored on prod (issuedAt stays now − 5 s, tested). It signs only the site's own floor reading.
- **Dev routes:** `/api/auth/dev` and `/api/dev/*` exist only in dev builds (`dev:false` on prod).
- **Headers:** HSTS, CSP, X-Frame-Options and nosniff are on static and API responses. API responses carry `max-age=0, must-revalidate`. No authenticated response is cached at the CDN.
- **Dependencies and secrets:** npm audit reports 0 vulnerabilities. No secrets were found in public/ or git history (the Infura key in history is forge-std's public default).
- **Old deployments:** old production deployment URLs sit behind Vercel Authentication.
