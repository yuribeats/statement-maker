// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PartyFactory} from "../src/PartyFactory.sol";
import {StatementMarket, IERC721Min} from "../src/StatementMarket.sol";
import {ICredits, IStatement} from "../src/interfaces/IExternal.sol";
import {CreditTraits} from "../src/CreditTraits.sol";
import {TraitsTable} from "./TraitsTable.sol";

/// @notice Mainnet deployment of Statement Maker. NOT RUN YET: nothing is on mainnet. See scripts/deploy-mainnet.sh
///         for the full command (broadcast + Etherscan verification) and the post-deploy verification steps.
///         Deploys, in order: the CreditKeys library (forge links it automatically, CREATE2), the sealed CreditTraits
///         table (25 SSTORE2 data contracts from data/keytable/table.bin, refused unless its keccak256 equals the
///         committed TABLE_KECCAK, then CreditTraits; its Rarity field is a frozen snapshot of Jack Butcher's official
///         rating, re-fetched and re-verified right before deploy per docs/audit/PRE_MAINNET.md), PartyFactory (its constructor deploys CreditCards and the Party
///         implementation), and StatementMarket.
/// env: CREDITS, STATEMENT, FEE_RECIPIENT, FLOOR_SIGNER, COLLECTION_OWNER (all required, all non-zero).
contract DeployMainnet is Script {
    address constant MAINNET_CREDITS = 0x97630aA70AB14ed9883B41dAfccBc11349723043;
    /// keccak256 of data/keytable/table.bin (scripts/keytable/build.sh + verify.sh; also in data/keytable/table.keccak).
    /// Built from the rating snapshot data/jack-rating.json.gz fetched 2026-09-25T03:38:24Z (methodology 3.4.0).
    bytes32 constant TABLE_KECCAK = 0xe512b2f1c0dcf923a427e0bdb4c9f791066f3841e4ff18e214ad91c1037dfc72;

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

        bytes memory table = vm.readFileBinary("data/keytable/table.bin");
        require(keccak256(table) == TABLE_KECCAK && table.length == 122154 * 5, "key table differs from the committed one");

        vm.startBroadcast();
        CreditTraits traits = TraitsTable.deploy(table);
        PartyFactory factory = new PartyFactory(ICredits(credits), IStatement(statement), feeTo, signer, collectionOwner, traits);
        StatementMarket market = new StatementMarket(IERC721Min(statement), feeTo);
        vm.stopBroadcast();

        console2.log("CreditTraits", address(traits));
        console2.log("CreditTraits.tableHash");
        console2.logBytes32(traits.tableHash());
        console2.log("PartyFactory", address(factory));
        console2.log("CreditCards", address(factory.cards()));
        console2.log("Party implementation", address(factory.implementation()));
        console2.log("StatementMarket", address(market));
    }
}
