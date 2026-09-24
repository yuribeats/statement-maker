# Site audit, second pass (2026-09-24): findings and fixes

Scope: lib/core.mjs, lib/store.mjs, api/, public/*, vercel.json, launch and full modes. Findings 2, 5 and 19 concern the
contracts and SPEC and are handled separately. Every fix below was tested on an isolated copy in production mode
(NODE_ENV=production, port 8121, temporary SESSION_SECRET, no DATABASE_URL, its own data/), then smoke-tested on production.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | Any signed-in wallet could bid up to 1e6 ETH, which nobody could outbid, then settle and unlock the site. | Before the write lock, the bidder's mainnet ETH balance is read (6 s limit). The bid must not exceed it. If the balance cannot be read, the answer is 503. Bids are capped at 10,000 ETH, which keeps the top bid below the price cap minus 0.1 ETH. Bids are rate-limited per IP. A preview settlement still unlocks the site (owner decision). |
| 3 | MED | `liveOwners` treated any RPC error as "burned" (ZERO), so a Credit could show as unowned for the life of the instance. | Only a contract revert counts as ZERO. Any other failure makes the whole read fail, and the answer is 503. Ownership seen during a deposit is written to the in-memory holder map only after the request commits, so a rejected request changes nothing. |
| 4 | MED | Blind SSRF: viem's CCIP-read could make the server fetch any URL during an ENS lookup or `verifyMessage`. | The mainnet client runs with `ccipRead: false`. Name lookups have a 6 s limit, and `/api/ens` has a 7 s limit overall. A failed lookup returns 503, not a cached null. |
| 6 | MED | `/api/ens?a=` wrote a record for any address anyone sent. | The route is rate-limited per IP. It looks up and saves names only for addresses the site knows: Credit holders, hosts, depositors, card holders, bidders, owners, sellers, chat posters and addresses in the log. Unknown addresses are returned as `skipped` and are never saved. |
| 7 | MED | Proposals could pile up without limit. | Each member may make at most 12 proposals per party in 24 hours. Closed proposals are pruned, oldest first, beyond the last 200 per party. Pruning never removes open proposals, executed proposals (needed for the 30-day deadlock clock), counted blocks still in force, or proposals that can still be counted, so the tally and deadlock results do not change. Proposal ids stay unique after pruning. |
| 8 | MED | The site differed from Party.sol. | (a) A cancel vote always runs 24 hours. (b) A cancel with nothing listed is refused ("not listed"). (c) A buy wait must be a whole number of hours from 0 to 72, and at least 1 for a floor-based price. Invalid values are refused at party creation, in proposals and in settings, not silently changed. (d) When a party fills, its deadline moves to at least 2 days later (FILL_GRACE). (e) Manual parties: for 1 day after filling, only the host burns. After that, the host has no say, and any card holder, the host included, burns in Time order. |
| 9 | MED | Statements being auctioned showed "Not for sale · not listed". | `/api/market` includes running auctions (source `auction`, with the high bid or the opening bid and the clock). The gallery, the cards and the Statement page show the auction and link to the Minute page. Auctions are left out of the gallery floor. |
| 10 | MED | Gas figures were outdated. | Figures measured on a mainnet fork, one call per transaction: burn in Deposit order 7.37M, in Time order 7.61M (measured for this fix), Rarity 12.8M; redeem 173k–400k; propose 220k; vote 71k; claim 83k. Deposit, execute, raiseAsk, bid, settle and buy are marked as estimates. `arrange` was removed. Launch Rule 05 and the launch terms now say about 7.6M. |
| 11 | LOW | A chunked request skipped the 64 KB body limit. | The size is checked on the parsed body as well. `cards` and `ids` lists are cut to 80 everywhere. |
| 12 | LOW | A malformed Origin header caused a 500. | Any Origin that cannot be parsed gets 403. |
| 13 | LOW | The ownership read for a deposit ran before the route and launch gates. | It now runs only after those gates pass, on an unlocked copy of the state, and it is rate-limited per IP. |
| 14 | LOW | `floorInfo('avg24h')` threw when the last 24 hours had no readings, and a stale "latest" reading was still used. | Both cases now return no reading (nulls). A latest reading more than 2 hours old counts as missing. |
| 15 | LOW | `/sepolia/` returned 404 instead of a redirect. `/api/sepolia/floor` was public. | Everything under `/sepolia` redirects home. `/api/sepolia/floor` already returns 404 unless SEPOLIA_FLOOR_KEY and SEPOLIA_FACTORY are set. Production has them set, so it keeps answering. Env vars were not changed. |
| 16 | LOW | A settle path for auctions with no bids could never run, and its button was dead. | Both removed. With no bids, settle answers "no bids yet". |
| 17 | LOW | Preview settlement stored ETH floats, kept the rounding dust, had no `claimFor`, and limited `return` to members. | Sales store wei strings (`priceWei`, `feeWei`, `perCardWei`) next to ETH numbers for display. Rounding dust goes to the fee, as in Party.buy. `POST /parties/:id/claimFor` lets anyone pay out cards to their current holders; one invalid card fails the whole call. Anyone may call `return`. |
| 18 | LOW | Full-mode text was out of date. | Terms "Voting" now gives the 60 below-floor rule and the 54 deadlock override. "Burning is permanent" says Credits go to the card holder. Rule 10 says only price proposals count toward deadlock, and only once recorded with "Count as blocked". The gate no longer offers a simulation. Terms and Rules say Statement Maker's contracts are not deployed on mainnet yet. Versions: terms 2026-09-24.8 / L8, rules 2026-09-24.7 / L9. |
| 20 | LOW | A cold cron instance rescanned transfers from the snapshot and could write a lower block. | Sync reads the saved block first. The store never writes a lower block (Postgres: conditional UPDATE). OpenSea, Coinbase and gas-price fetches time out after 8 s. `/api/gas` does not retry a failed reading for 60 s. |
| 21 | INFO | The client's opening-bid preview rounded differently from the server. | The server sends `openingNowEth`, computed with the burn's own rounding. |

Local production-mode results: 49 checks passed, none failed. The two stale-floor checks ran in-process, because the running server fetched a fresh floor reading at startup. Covered: unbacked bid refused, bid cap, backed bid, settle split down to the wei, claimFor, market auction entries, Manual grace both ways, cancel rules, buy-wait validation, the 12-per-day limit, pruning to 200, fill grace, return by anyone, Origin 403s, ENS skip, RPC down giving 503 with nothing changed, stale floors giving nulls, the pre-parsed body limit, and the owners block never moving back.

---

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
