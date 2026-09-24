# Credits → Statement: research (2026-09-23)

## Verified facts
- Contract: Credits (CREDIT), Ethereum mainnet, 0x97630aa70ab14ed9883b41dafccbc11349723043, ERC-721, source verified on Sourcify (copy in research/Credits.sol).
- Supply 122,154. Sealed 2026-09-23 12:41:47 EDT (sealedAt 1790181707). Assembly "opens in 8 days" per jack.art/credits → roughly 2026-10-01.
- `burn(address owner_, uint256[] ids)` is ALREADY live (requires isSealed = true). Caller must be owner_ or setApprovalForAll operator. All ids in one call must belong to the single owner_. Returns the burned seeds in call order.
- No Statement contract is public yet. Its rules (one wallet vs many, order meaning, contract callers allowed) are UNKNOWN.
- jack.art preview renders a Statement as an 8×10 sheet of 80 Credits, in two modes: Random, and Ordered = all 80 share one trait value. Traits: Colors (CMYK plate combo), Print (Registered/Nudge/Slip/Drift/Skew/Loose), Weight (sparse/lean/even/extreme), Eights (0/1/2…).
- OpenSea: slug `credits`, 1% required fee, trait offers + collection offers enabled. Floor 0.0276 ETH at time of check.

## Holder distribution (Alchemy getOwnersForContract, 2026-09-23)
- 17,337 holders, median 1. 10,532 hold exactly 1.
- ≥80: 213 wallets. ≥40: 855. ≥20: 1,546.
- Statements makeable with zero transfers: 328 of 1,526 max (21%).
- 90,948 credits (74%) sit in 17,124 wallets holding fewer than 80.

## Costs
- Gas 0.059 gwei; ERC-721 transfer ≈ 60k gas ≈ $0.01. ETH $2,688.
- 80 × floor ≈ 2.21 ETH ≈ $5,900 per Statement.
