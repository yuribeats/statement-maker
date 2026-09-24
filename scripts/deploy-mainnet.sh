#!/usr/bin/env bash
# Statement Maker MAINNET deployment + Etherscan source verification. DOCUMENTATION: do not run until the launch is
# approved (nothing is on mainnet yet). Refuses to run unless CONFIRM_MAINNET=yes.
#
# Needs: ETH_RPC_URL (mainnet), ETHERSCAN_API_KEY, a deployer key (--account / --private-key / --ledger via DEPLOY_SIGNER_ARGS),
#        and CREDITS, STATEMENT, FEE_RECIPIENT, FLOOR_SIGNER, COLLECTION_OWNER for contracts/script/DeployMainnet.s.sol.
#
# What gets verified:
#   1. `forge script --broadcast --verify` verifies every contract the script's own transactions create: the CreditKeys
#      library (forge deploys it first, CREATE2, and links it into Party), PartyFactory and StatementMarket.
#   2. PartyFactory's constructor creates CreditCards and the Party implementation internally. They are verified
#      explicitly below with `forge verify-contract` (Party needs the CreditKeys link; CreditCards needs its
#      constructor args), so this does not depend on whether forge picks up internal creations.
#   3. Every party is an EIP-1167 minimal clone of the verified Party implementation. Etherscan recognises minimal
#      proxies and shows the implementation's source; if a clone page does not, use "More > Is this a proxy?" on it.
set -euo pipefail
[[ "${CONFIRM_MAINNET:-}" == "yes" ]] || { echo "refusing: set CONFIRM_MAINNET=yes to deploy to mainnet"; exit 1; }
cd "$(dirname "$0")/../contracts"
: "${ETH_RPC_URL:?}" "${ETHERSCAN_API_KEY:?}" "${CREDITS:?}" "${STATEMENT:?}" "${FEE_RECIPIENT:?}" "${FLOOR_SIGNER:?}" "${COLLECTION_OWNER:?}"
[[ "$(cast chain-id --rpc-url "$ETH_RPC_URL")" == "1" ]] || { echo "ETH_RPC_URL is not mainnet"; exit 1; }

forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url "$ETH_RPC_URL" --broadcast --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" --slow ${DEPLOY_SIGNER_ARGS:-}

RUN=broadcast/DeployMainnet.s.sol/1/run-latest.json
FACTORY=$(jq -r '.transactions[] | select(.contractName=="PartyFactory") | .contractAddress' "$RUN")
KEYS=$(jq -r '.transactions[] | select(.contractName=="CreditKeys") | .contractAddress' "$RUN" | head -1)
IMPL=$(cast call "$FACTORY" "implementation()(address)" --rpc-url "$ETH_RPC_URL")
CARDS=$(cast call "$FACTORY" "cards()(address)" --rpc-url "$ETH_RPC_URL")
echo "factory $FACTORY  keys $KEYS  implementation $IMPL  cards $CARDS"

forge verify-contract "$IMPL" src/Party.sol:Party --chain mainnet --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --libraries "src/CreditKeys.sol:CreditKeys:$KEYS" --watch
forge verify-contract "$CARDS" src/CreditCards.sol:CreditCards --chain mainnet --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$FACTORY" "$COLLECTION_OWNER")" --watch
# Anything the --verify pass above missed (e.g. an Etherscan timeout) can be re-run the same way:
#   forge verify-contract <addr> src/PartyFactory.sol:PartyFactory --chain mainnet --constructor-args \
#     "$(cast abi-encode 'constructor(address,address,address,address,address)' $CREDITS $STATEMENT $FEE_RECIPIENT $FLOOR_SIGNER $COLLECTION_OWNER)"
