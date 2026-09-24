# Statement Maker: audit outreach drafts

**Drafts only. Nothing here has been sent.** Fill the `[brackets]` before use. Prices and timelines are unknown: get a quote from each firm.

## 0. Verified intake links (checked 2026-09-24 UTC)

Each URL returned HTTP 200 when checked. The link texts come from each site's own pages.

| Provider | Intake | Notes |
|---|---|---|
| Cantina (includes Spearbit) | https://www.cantina.security/get-a-demo · https://www.cantina.security/contact | `cantina.xyz` now redirects to `cantina.security`. spearbit.com says "Spearbit now lives on Cantina". Competitions: https://cantina.xyz/opportunities/competitions. Bounties product: https://www.cantina.security/bounties |
| OpenZeppelin | https://www.openzeppelin.com/request?id=security_audits | Linked as "Request an audit" from https://www.openzeppelin.com/security-audits. Readiness guide: https://www.openzeppelin.com/readiness-guide |
| Trail of Bits | https://www.trailofbits.com/contact/ | General contact form. No audit-specific form found. |
| Zellic | https://www.zellic.io/contact | `/contact-us` redirects here |
| Code4rena | https://go.code4rena.com/start | Linked from https://docs.code4rena.com/sponsors ("complete this form and we will reach out to set up a meeting or send over a scoping questionnaire"). The docs say a deposit locks the date and all code and docs must be in the repo at least 2 business days before start. |
| Sherlock | https://www.sherlock.xyz/contact | Service pages: https://www.sherlock.xyz/solutions/audit-contests, https://www.sherlock.xyz/solutions/collaborative-audits, https://www.sherlock.xyz/solutions/bug-bounties |
| Immunefi | https://immunefi.com/projects/get-started/ · https://immunefi.com/contact/ | Severity standard: https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/ |

Not verified: direct email addresses for any firm. Use the forms.

## 1. Private audit request (generic template)

Subject: Audit request: Statement Maker (≈750 nSLOC Solidity, Ethereum mainnet)

> Hi [Firm] team,
>
> We're requesting a quote for a private security review of Statement Maker, a small set of contracts that pools holders' Credits (Jack Butcher's sealed ERC-721 at 0x97630aa70ab14ed9883b41dafccbc11349723043), burns 80 of them into one Statement through the artist's Statement contract, sells it at a price the pool voted for, and pays out 1/80 per Credit.
>
> - Scope: 5 files, 931 lines / about 752 code lines. Party.sol (456), CreditKeys.sol (121), CreditCards.sol (96), PartyFactory.sol (45), IExternal.sol (34). Solidity 0.8.28, via-IR, Cancun, OpenZeppelin 5.4.0. No proxies beyond EIP-1167 clones, and no admin keys.
> - Main areas: custody of pooled ERC-721s, snapshot voting with a zero-NO veto and deadlock escape, on-chain verification of 10 sort presets, an EIP-712 floor oracle, and ETH sale splitting (royalty, 1% fee, 80 shares).
> - External dependency: the artist's Statement contract is not published yet (expected about [date]). We test against a stand-in and would like the review to cover the integration once the real ABI ships. That may mean a short follow-up.
> - Materials: a scope doc, architecture, 41 numbered invariants, a threat model with known open issues, Foundry unit, fork, differential, and Halmos tests, and Slither/Aderyn output.
> - Repo: [github.com/yuribeats/statement-maker @ tag] (we can grant private access).
> - Target window: [dates]. Please send availability, team size, duration, and price.
>
> Thanks,
> [Name] · [contact]

### Firm-specific notes
- **Cantina / Spearbit:** submit through https://www.cantina.security/get-a-demo. Say "Spearbit review" in the message. Also ask about a Cantina competition as an alternative or follow-on.
- **OpenZeppelin:** use https://www.openzeppelin.com/request?id=security_audits. Read the readiness guide first and state that we meet it (frozen commit, docs, tests).
- **Trail of Bits:** use https://www.trailofbits.com/contact/. Note that the code base is small and the invariants and Halmos harness are ready for property-based or fuzzing work.
- **Zellic:** use https://www.zellic.io/contact.

## 2. Contest intake summary (Code4rena / Sherlock / Cantina)

For https://go.code4rena.com/start, https://www.sherlock.xyz/contact, or https://cantina.xyz/opportunities/competitions.

> **Project:** Statement Maker. Pools Credits (ERC-721) to burn 80 into one Statement and sell it by vote.
> **Chain:** Ethereum mainnet. **Compiler:** solc 0.8.28, via-IR, Cancun.
> **In scope:** `contracts/src/Party.sol`, `PartyFactory.sol`, `CreditCards.sol`, `CreditKeys.sol`, `interfaces/IExternal.sol`. 752 code lines.
> **Out of scope:** `src/mocks/`, `test/`, `script/`, `lib/`, the website and server, and the third-party Credits and Statement contracts.
> **Trusted roles:** the floor signer (EIP-712, immutable), the artist's Statement contract, the fee recipient (receive-only), and the host (params at creation; Manual-arrangement burn within 1 day of FULL; `transferHost`).
> **Known issues, not eligible for rewards:** THREAT_MODEL.md R-1 to R-19. Includes proposal-cap exhaustion, the permanent deadlock counter, the CANCEL/BUY_DELAY race, floor signer compromise, floor cherry-picking inside 10 min, and stray tokens sent directly.
> **Main invariants:** INVARIANTS.md I-1 to I-41.
> **Areas of concern:** vote-weight checkpoints across parties; any path for Credits or the Statement to leave outside redeem, assemble, or buy; ETH conservation in buy, claim, and withdraw; preset verification accepting more than one order; governance liveness.
> **Tests:** `forge test` (local harness); mainnet-fork tests need `ETH_RPC_URL`; Halmos in `test/halmos`.
> **Budget / dates:** [get a quote] / [dates]. **Contact:** [ ].

## 3. Immunefi bug bounty program draft

Submit through https://immunefi.com/projects/get-started/. Severity follows the Immunefi Vulnerability Severity Classification System v2.3.

### Program overview
Statement Maker lets holders of Credits pool 80 tokens into a party. The party burns them into one Statement, sells it at a price its members voted for, and splits the proceeds 1/80 per card. Contracts have no admin and no upgrade path.

### Assets in scope
| Asset | Type | Address |
|---|---|---|
| PartyFactory | Smart contract | `[mainnet address]` |
| Party (implementation) and every clone created by the factory | Smart contract | `[implementation address]` |
| CreditCards | Smart contract | `[mainnet address]` |
| CreditKeys (library, inlined in Party) | Smart contract | n/a |

### Out of scope
- The Credits contract (`0x97630aa7…3043`) and the Statement contract (third party).
- The website, server, indexer, and floor-signing service, except where a contract-level impact is shown.
- Every item listed in THREAT_MODEL.md §4 as known or accepted.
- Attacks that need the floor-signer key, the host acting within its documented powers, or the Statement contract acting maliciously.
- Standard exclusions under Immunefi's defaults (third-party oracle data, governance attacks needing a majority, gas-optimization-only reports, best-practice suggestions, front-end issues).

### Impacts in scope
| Severity | Impact |
|---|---|
| Critical | Direct theft of deposited Credits, the Statement, or sale ETH. Permanent freezing of Credits in OPEN/EXPIRED parties or of sale proceeds. Selling the Statement below the ask or without `buy`. |
| High | Temporary freezing of funds or NFTs. Casting votes or passing a proposal without the required snapshot weight. Claiming more than 1/80 per card. |
| Medium | Griefing that blocks a party from assembling, selling, or paying out with no profit motive (beyond the known issues). Payouts diverted to the wrong party member through rounding or accounting errors. |
| Low | Contract fails to deliver promised returns without losing value. Incorrect metadata or preset ordering that does not affect funds. |

### Rewards (placeholders)
| Severity | Reward |
|---|---|
| Critical | `[USD X, or Y% of funds at risk, capped at Z]` |
| High | `[USD]` |
| Medium | `[USD]` |
| Low | `[USD]` |

Payment in `[USDC / ETH]`. KYC: `[required / not required]`. PoC required for Critical and High. Primacy of impact: `[yes / no]`.

### Rules
- Test only on a local fork. Do not interact with live parties.
- Reports go through Immunefi only. No public disclosure before a fix and an agreed date.
- Funds at risk scale with the ETH and NFT value held across all parties at the time of the report.
