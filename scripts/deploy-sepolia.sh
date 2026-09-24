#!/usr/bin/env bash
# Statement Maker Sepolia rehearsal deployment WITH Etherscan source verification (earlier Sepolia deploys were not
# verified). Needs: SEPOLIA_RPC_URL, ETHERSCAN_API_KEY, a deployer key (DEPLOY_SIGNER_ARGS), and the env that
# contracts/script/DeploySepolia.s.sol reads (TEST_HOLDERS, PER_HOLDER, FLOOR_SIGNER, FEE_RECIPIENT, COLLECTION_OWNER,
# TIME_UNIT; optional EXISTING_CREDITS/EXISTING_STATEMENT). Internal creations (CreditCards, Party implementation) are
# verified explicitly afterwards, as in deploy-mainnet.sh.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
: "${SEPOLIA_RPC_URL:?}" "${ETHERSCAN_API_KEY:?}" "${COLLECTION_OWNER:?}"
forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow ${DEPLOY_SIGNER_ARGS:-}
RUN=broadcast/DeploySepolia.s.sol/11155111/run-latest.json
FACTORY=$(jq -r '.transactions[] | select(.contractName=="TestnetPartyFactory") | .contractAddress' "$RUN")
KEYS=$(jq -r '.transactions[] | select(.contractName=="CreditKeys") | .contractAddress' "$RUN" | head -1)
[[ -n "$KEYS" && "$KEYS" != null ]] || KEYS=${CREDIT_KEYS:?"CreditKeys was not deployed in this run: set CREDIT_KEYS to the linked library address"}
IMPL=$(cast call "$FACTORY" "implementation()(address)" --rpc-url "$SEPOLIA_RPC_URL")
CARDS=$(cast call "$FACTORY" "cards()(address)" --rpc-url "$SEPOLIA_RPC_URL")
forge verify-contract "$IMPL" src/Party.sol:Party --chain sepolia --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --libraries "src/CreditKeys.sol:CreditKeys:$KEYS" --watch
forge verify-contract "$CARDS" src/CreditCards.sol:CreditCards --chain sepolia --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$FACTORY" "$COLLECTION_OWNER")" --watch
