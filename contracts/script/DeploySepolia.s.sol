// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Credits} from "../test/credits/Credits.sol";
import {TestnetPartyFactory} from "../src/testnet/TestnetPartyFactory.sol";
import {KeyProbe} from "../src/testnet/KeyProbe.sol";
import {StatementMarket, IERC721Min} from "../src/StatementMarket.sol";
import {MockStatement} from "../src/mocks/MockStatement.sol";
import {ICredits, IStatement, ICreditArt} from "../src/interfaces/IExternal.sol";
import {CreditTraits} from "../src/CreditTraits.sol";
import {TraitsTable} from "./TraitsTable.sol";
import {CreditKeysRef} from "../test/ref/CreditKeysRef.sol";

/// @notice Sepolia rehearsal: Jack's verified Credits source (identical code), test Credits, the Statement stand-in,
///         and Statement Maker. Refuses to run on any chain but Sepolia.
/// env: TEST_HOLDERS (comma-separated addresses), PER_HOLDER, FLOOR_SIGNER, FEE_RECIPIENT, TIME_UNIT (seconds per rule-hour)
contract DeploySepolia is Script {
    function run() external {
        require(block.chainid == 11155111, "Sepolia only");
        address[] memory holders = vm.envAddress("TEST_HOLDERS", ",");
        uint256 per = vm.envUint("PER_HOLDER");
        address signer = vm.envAddress("FLOOR_SIGNER");
        address feeTo = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast();
        // Reuse an already-deployed test Credits + Statement stand-in when given (EXISTING_CREDITS/EXISTING_STATEMENT).
        address existing = vm.envOr("EXISTING_CREDITS", address(0));
        if (existing != address(0)) {
            vm.stopBroadcast();
            bytes memory t0 = _table(ICredits(existing));
            vm.startBroadcast();
            CreditTraits tr0 = TraitsTable.deploy(t0);
            TestnetPartyFactory f = new TestnetPartyFactory(ICredits(existing), IStatement(vm.envAddress("EXISTING_STATEMENT")), feeTo, signer, vm.envAddress("COLLECTION_OWNER"), tr0, vm.envUint("TIME_UNIT"));
            KeyProbe kp = new KeyProbe(tr0);
            StatementMarket mk = new StatementMarket(IERC721Min(vm.envAddress("EXISTING_STATEMENT")), feeTo);
            vm.stopBroadcast();
            console2.log("StatementMarket", address(mk));
            console2.log("PartyFactory", address(f));
            console2.log("CreditCards", address(f.cards()));
            console2.log("KeyProbe", address(kp));
            console2.log("CreditTraits", address(tr0));
            return;
        }
        // Resume with an already-deployed, unsealed test Credits (EXISTING_UNSEALED_CREDITS) if a previous run stopped early.
        address resume = vm.envOr("EXISTING_UNSEALED_CREDITS", address(0));
        Credits credits = resume != address(0) ? Credits(resume) : new Credits(msg.sender);
        uint256 n = holders.length * per;
        uint256 batch = 40; // keeps each distribute call well under the 16,777,216 per-transaction gas cap
        for (uint256 start; start < n; start += batch) {
            uint256 m = start + batch > n ? n - start : batch;
            address[] memory to = new address[](m);
            bytes21[] memory seeds = new bytes21[](m);
            uint64[] memory ts = new uint64[](m);
            for (uint256 i; i < m; ++i) {
                uint256 k = start + i;
                to[i] = holders[k / per];
                seeds[i] = _seed(k);
                ts[i] = uint64(block.timestamp - 3 days + k * 7);
            }
            credits.distribute(to, seeds, ts);
        }
        credits.seal();
        MockStatement statement = new MockStatement(address(credits));
        vm.stopBroadcast();
        bytes memory table = _table(ICredits(address(credits)));
        vm.startBroadcast();
        CreditTraits traits = TraitsTable.deploy(table); // this collection's own trait table (derived from its art)
        TestnetPartyFactory factory = new TestnetPartyFactory(ICredits(address(credits)), IStatement(address(statement)), feeTo, signer, vm.envAddress("COLLECTION_OWNER"), traits, vm.envUint("TIME_UNIT"));
        KeyProbe probe = new KeyProbe(traits);
        StatementMarket market = new StatementMarket(IERC721Min(address(statement)), feeTo);
        vm.stopBroadcast();

        console2.log("Credits (test copy)", address(credits));
        console2.log("Statement (stand-in)", address(statement));
        console2.log("PartyFactory", address(factory));
        console2.log("CreditCards", address(factory.cards()));
        console2.log("KeyProbe", address(probe));
        console2.log("StatementMarket", address(market));
        console2.log("CreditTraits", address(traits));
    }

    /// Packed traits of every Credit of `c` (ids 1..supply), from its own art contract (CreditKeysRef.packed).
    function _table(ICredits c) internal view returns (bytes memory t) {
        (, bytes memory r) = address(c).staticcall(abi.encodeWithSignature("supply()"));
        uint256 n = abi.decode(r, (uint256));
        ICreditArt art = ICreditArt(c.art());
        t = new bytes(n * 5);
        for (uint256 id = 1; id <= n; ++id) {
            uint256 v = CreditKeysRef.packed(c, art, id); // test collection: stand-in rarity class (no official rating)
            for (uint256 b; b < 5; ++b) t[5 * id - 5 + b] = bytes1(uint8(v >> (8 * (4 - b))));
        }
    }

    function _seed(uint256 i) internal pure returns (bytes21 s) {
        bytes memory alpha = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        bytes memory b = new bytes(21);
        uint256 x = uint256(keccak256(abi.encode("sepolia", i)));
        for (uint256 k; k < 21; ++k) { b[k] = alpha[x % 62]; x /= 62; if (x == 0) x = uint256(keccak256(abi.encode(i, k))); }
        assembly { s := mload(add(b, 32)) }
    }
}
