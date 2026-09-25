# Statement Maker

Parties for [Credits](https://jack.art/credits) holders. Eighty Credits burn into one Statement; most holders have one. A party pools them.

Live preview: https://statement-maker.vercel.app

**Status: preview.** The Statement contract is not published yet, so nothing here moves Credits or ETH. Independent project, not affiliated with Jack Butcher.

## How it works
- A host opens a party and sets defaults: eligible Credits (on-chain traits, rarity by Jack Butcher's official Credits rating, misregistration detail), minimum deposit, default arrangement, default price, voting window.
- Each deposited Credit returns one Credit Card (ERC-721). The card carries the vote, the right to redeem its Credit before the burn, and 1/80 of the sale. Everything follows the card.
- At 80 the default arrangement applies; the host arranges (auto or manual) without a vote; card holders can challenge by vote.
- Votes: 41/80 yes and zero no. Below the floor: 60/80. Deadlock escape: 54/80 after 3 blocked proposals or 30 days.
- The Statement sells only at the party's own ask, only here. No offers, no auctions, no marketplaces. Artist royalty first, then 1%, the rest to card holders.

Full design: [SPEC.md](SPEC.md). Verified facts about the Credits contract: [RESEARCH.md](RESEARCH.md).

## Run
```
npm ci
node scripts/fetch-chain.mjs   # needs ALCHEMY_API_KEY; writes data/credits.json
node scripts/traits.mjs        # traits via the art contract's own describe(), needs Foundry's anvil
node scripts/slips.mjs         # exact plate shifts via the art library's slips()
node server.mjs                # http://localhost:8088 (dev: simulated wallets on)
```
Production: `NODE_ENV=production` turns off simulated wallets and the dev clock; sign-in is EIP-4361 with the terms as the signed statement.

Credits contract sources in `research/` and `tools/slips/src/` are MIT-licensed, from the verified deployment on Sourcify.
