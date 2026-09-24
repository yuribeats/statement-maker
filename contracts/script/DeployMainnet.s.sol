// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PartyFactory} from "../src/PartyFactory.sol";
import {StatementMarket, IERC721Min} from "../src/StatementMarket.sol";
import {ICredits, IStatement} from "../src/interfaces/IExternal.sol";

/// @notice Mainnet deployment of Statement Maker. NOT RUN YET: nothing is on mainnet. See scripts/deploy-mainnet.sh
///         for the full command (broadcast + Etherscan verification) and the post-deploy verification steps.
///         Deploys, in order: the CreditKeys library (forge links it automatically, CREATE2), PartyFactory (its
///         constructor deploys CreditCards and the Party implementation), and StatementMarket.
/// env: CREDITS, STATEMENT, FEE_RECIPIENT, FLOOR_SIGNER, COLLECTION_OWNER (all required, all non-zero).
contract DeployMainnet is Script {
    address constant MAINNET_CREDITS = 0x97630aA70AB14ed9883B41dAfccBc11349723043;

    function run() external {
        require(block.chainid == 1, "mainnet only");
        address credits = vm.envAddress("CREDITS");
        address statement = vm.envAddress("STATEMENT");
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        address signer = vm.envAddress("FLOOR_SIGNER");
        address collectionOwner = vm.envAddress("COLLECTION_OWNER");
        require(credits == MAINNET_CREDITS, "CREDITS is not the live Credits contract");
        require(statement.code.length > 0, "STATEMENT has no code");
        require(feeTo != address(0) && signer != address(0) && collectionOwner != address(0), "zero address");

        vm.startBroadcast();
        PartyFactory factory = new PartyFactory(ICredits(credits), IStatement(statement), feeTo, signer, collectionOwner);
        StatementMarket market = new StatementMarket(IERC721Min(statement), feeTo);
        vm.stopBroadcast();

        console2.log("PartyFactory", address(factory));
        console2.log("CreditCards", address(factory.cards()));
        console2.log("Party implementation", address(factory.implementation()));
        console2.log("StatementMarket", address(market));
    }
}
