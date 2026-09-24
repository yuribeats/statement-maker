// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// Worst-case single transactions vs the 16,777,216 per-transaction gas cap (EIP-7825), on real mainnet Credits,
/// measured COLD: before each measured call every contract it touches (and their storage) is marked cold with
/// vm.cool, as in a fresh transaction. Reported = execution gas before refunds + intrinsic (21,000 + calldata).
/// Every preset is measured on the same 80 Credits (state reverted between presets). The Statement contract here
/// is MockStatement: Jack's real make() cost is unknown until it ships (docs/audit/PRE_MAINNET.md).
contract GasCapTest is Base {
    uint256 constant CAP = 16_777_216;

    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i; i < data.length; ++i) g += data[i] == 0 ? 4 : 16;
    }

    function _coolAll(Party party) internal {
        vm.cool(address(party));
        vm.cool(address(CREDITS));
        vm.cool(address(cards));
        vm.cool(address(statement));
        vm.cool(address(factory));
        vm.cool(address(factory.implementation()));
        vm.cool(address(traits));
        for (uint256 i; i < traits.chunkCount(); ++i) vm.cool(traits.chunkAt(i));
    }

    function test_gas_open80_and_burnEveryPreset_cold() public {
        uint256[] memory ids = take(holdings(WHALE), 0, 80);
        uint256 worst;
        for (uint256 k; k <= 10; ++k) {
            CreditKeys.Preset pre = CreditKeys.Preset(k);
            uint256 snap = vm.snapshotState();
            Party.Params memory p = params(pre);
            p.seed = 42;
            vm.startPrank(WHALE);
            CREDITS.setApprovalForAll(address(factory), true);
            vm.cool(address(factory));
            vm.cool(address(CREDITS));
            vm.cool(address(cards));
            bytes memory openData = abi.encodeCall(factory.createParty, (p, ids, new bytes32[][](0)));
            uint256 g = gasleft();
            Party party = factory.createParty(p, ids, new bytes32[][](0));
            uint256 gOpen = g - gasleft() + _intrinsic(openData);
            vm.stopPrank();

            uint256[] memory order = party.depositOrder();
            if (pre == CreditKeys.Preset.Random) order = probe.shuffle(order, 42);
            else if (pre != CreditKeys.Preset.Deposit && pre != CreditKeys.Preset.Manual) order = sortBy(pre, order);
            bytes memory data = abi.encodeCall(Party.assemble, (order, noFloor()));
            _coolAll(party);
            vm.prank(WHALE);
            g = gasleft();
            party.assemble(order, noFloor());
            uint256 gBurn = g - gasleft() + _intrinsic(data);

            emit log_named_uint(string.concat("preset ", vm.toString(k), " open + deposit 80 (cold)"), gOpen);
            emit log_named_uint(string.concat("preset ", vm.toString(k), " burn (cold, mock Statement)"), gBurn);
            assertLt(gOpen, CAP, "open over cap");
            assertLt(gBurn, CAP, "burn over cap");
            if (gBurn > worst) worst = gBurn;
            vm.revertToState(snap);
        }
        emit log_named_uint("worst burn", worst);
        emit log_named_uint("headroom under the cap for the real Statement mint", CAP - worst);
    }
}
