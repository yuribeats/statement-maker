# STATEMENT POOL — spec draft v0.1 (2026-09-23)

Model: PartyDAO (Party Protocol). Facts in RESEARCH.md.

## 1. Objects
- **Sheet**: one pending Statement. Has a creator, an optional theme (trait filter), 80 slots, a deadline.
- **Deposit token**: ERC-1155, token id = sheet id. Depositing 1 Credit into sheet N mints 1 of token N.
  Balance = credits contributed = vote weight on that sheet = share of any proceeds.
- **Vault**: holds deposited Credits, then the assembled Statement.

## 2. Sheet lifecycle
| State | Enters when | Allowed |
|---|---|---|
| OPEN | creator opens sheet | deposit (must match theme); withdraw (burns deposit token, returns the same Credit) |
| FULL | 80th deposit | no withdraw; arrangement set (see §4) |
| ASSEMBLED | vault calls Statement contract; Credits burned | governance on the Statement |
| LISTED / SOLD | passed proposal | buy / accept |
| DISTRIBUTED | sale settles | holders claim ETH pro rata; claim burns deposit tokens |
| EXPIRED | deadline passes unfilled, or assembly impossible | every depositor withdraws their original Credit |

Credits are never burned before assembly. If the Statement contract rejects contract callers, nothing is lost: sheets expire and Credits return.

## 3. Per-sheet governance (binding, on-chain) — Party-style
Borrowed from PartyGovernance.sol: propose → vote → passThresholdBps → executionDelay → execute; host veto; rage quit.
Proposal types (closed set, no arbitrary calls):
- LIST (price, venue, duration) — Seaport/OpenSea
- ACCEPT_OFFER (offer id, min price)
- AUCTION (reserve, duration)
- CANCEL_LISTING
- DISTRIBUTE (sweep sale ETH to claimable)
- DISPLAY/LEND (optional, later)
Vote weight snapshotted at proposal creation (stops buy-vote-sell).

## 4. Arrangement (the 8×10 order)
Burn returns seeds in call order and the preview renders an ordered sheet. Order is likely part of the work (unverified until Statement contract ships).
Options: deposit order / creator arranges / arrangement vote while FULL.

## 5. Collection-wide votes (signaling, off-chain)
- Electorate: every Credit, burned or not. Power = Credits held + deposit tokens held (1 burned Credit = 1 deposit token = 1 vote).
- Credits contract has no vote checkpoints → power computed by our indexer at a fixed block; snapshot published as a Merkle root so anyone can verify.
- Signed messages, zero gas.
- Binding scope: only pool-level settings (fees, default thresholds, theme calendar). Nothing binds Jack's contracts.

## 6. UI — match jack.art/credits (copy in research/jack-credits-style.css)
- White #fff, ink #111, muted #929292/#999, hairlines 1px #e3e3e3 / #e8e8e8. No other color; the art supplies CMYK.
- One type size: 11px/1.65 SF Mono → Menlo, all uppercase; bold 700 for headings only.
- Header 30px 40px, nav gap 28px; main max-width 1440px; two-column works grid, 64px gap.
- Statement frame: aspect 4:5, 8% padding, 8 cols × 10 rows. Each sheet page shows its 80 slots in this frame: filled slots render the Credit SVG, empty slots are hairline cells.
- Credit detail = 2×2 metadata overlay (Colors / Print / Weight / Eights), toggled like #metadata-toggle.
- Text buttons only (underline when pressed), no fills, no rounded corners.

## 7. Unknowns
- Statement contract ABI/rules (single-owner? contract callers? order semantics?). Ships ~2026-10-01.
- Whether Party Protocol's mainnet factory is still maintained (repo last commit 2024-12-20). Reusing its audited governance per sheet would cut custom code to the depositor + assembly adapter.
