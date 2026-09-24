// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, ICreditArt, ICreditTraits} from "../../src/interfaces/IExternal.sol";

interface IBurn {
    function burn(address owner_, uint256[] calldata ids) external returns (bytes21[] memory);
}

interface IMake {
    function make(uint256[] calldata ids) external returns (uint256);
}

/// Holds Credits and burns them / makes a Statement, so each step can be measured as its own transaction.
contract BurnHarness {
    function approve(address op) external {
        ICredits(0x97630aA70AB14ed9883B41dAfccBc11349723043).setApprovalForAll(op, true);
    }

    function burn(uint256[] calldata ids) external {
        IBurn(0x97630aA70AB14ed9883B41dAfccBc11349723043).burn(address(this), ids);
    }

    function make(address st, uint256[] calldata ids) external {
        IMake(st).make(ids);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// Party-shaped storage (deposit order + credit->card map) so verifyOrder runs exactly as in assemble, cold.
contract VerifyHarness {
    uint256[] internal dep;
    mapping(uint256 => uint256) internal cardOf;

    function setup(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) { dep.push(ids[i]); cardOf[ids[i]] = i + 1; }
    }

    function verify(CreditKeys.Preset p, ICreditTraits t, uint256[] calldata order, uint256 seed) external {
        CreditKeys.verifyOrder(p, t, dep, cardOf, order, seed);
    }

    /// The post-burn safety check alone: ownerOf must revert with ERC721NonexistentToken for each id.
    function burnedCheck(ICredits c, uint256[] calldata ids) external view {
        for (uint256 i; i < ids.length; ++i) {
            try c.ownerOf(ids[i]) returns (address) { revert("alive"); }
            catch (bytes memory r) { if (bytes4(r) != 0x7e273289) revert("other"); }
        }
    }
}

/// Cold per-preset burn cost and its breakdown on a mainnet fork. Run with --isolate so every top-level call is its
/// own transaction (cold accounts and storage), e.g.:
///   forge test --match-path test/gas/Breakdown.t.sol --isolate -vv
/// Reported gas is execution gas of the call (gasleft delta, excludes the 21,000 base and calldata, reported apart).
contract GasBreakdownTest is Base {
    VerifyHarness vh;

    function setUp() public override {
        super.setUp();
        vh = new VerifyHarness();
    }

    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i; i < data.length; ++i) g += data[i] == 0 ? 4 : 16;
    }

    function _order(CreditKeys.Preset pre, uint256[] memory dep, uint256 seed) internal view returns (uint256[] memory o) {
        o = new uint256[](dep.length);
        for (uint256 i; i < dep.length; ++i) o[i] = dep[i];
        if (pre == CreditKeys.Preset.Random) return probe.shuffle(o, seed);
        if (pre == CreditKeys.Preset.Deposit || pre == CreditKeys.Preset.Manual) return o;
        return sortBy(pre, o);
    }

    function test_breakdown_allPresets() public {
        uint256[] memory ids = take(holdings(WHALE), 0, 80);
        emit log("preset | total exec | intrinsic | burn(a) | verify(b) | ownerOf checks alone, cold(c) | mock mint(d) | rest incl. warm checks(e)");
        for (uint256 k; k <= 10; ++k) {
            CreditKeys.Preset pre = CreditKeys.Preset(k);
            uint256 snap = vm.snapshotState();
            Party.Params memory p = params(pre);
            p.seed = 42;
            Party party = openParty(p, WHALE, ids);
            uint256[] memory dep = party.depositOrder();
            uint256[] memory order = _order(pre, dep, 42);

            // (b) order verification alone (fresh harness each preset: cold storage, like the party)
            VerifyHarness v = new VerifyHarness();
            v.setup(dep);
            uint256 g = gasleft();
            v.verify(pre, traits, order, 42);
            uint256 gVerify = g - gasleft();

            // total: the real assemble
            bytes memory data = abi.encodeCall(Party.assemble, (order, noFloor()));
            uint256 snap2 = vm.snapshotState();
            vm.prank(WHALE);
            g = gasleft();
            party.assemble(order, noFloor());
            uint256 gTotal = g - gasleft();

            // (c) post-burn checks alone, on the burned ids
            g = gasleft();
            vh.burnedCheck(CREDITS, order);
            uint256 gCheck = g - gasleft();
            vm.revertToState(snap2);

            // (a) Credits.burn alone and (a)+(d) make, from a plain holder of the same 80 Credits
            BurnHarness bh = new BurnHarness();
            vm.startPrank(address(party)); // move the 80 to the harness (setup only)
            for (uint256 i; i < 80; ++i) CREDITS.transferFrom(address(party), address(bh), order[i]);
            vm.stopPrank();
            bh.approve(address(statement));
            uint256 snap3 = vm.snapshotState();
            g = gasleft();
            bh.burn(order);
            uint256 gBurn = g - gasleft();
            vm.revertToState(snap3);
            g = gasleft();
            bh.make(address(statement), order);
            uint256 gMake = g - gasleft();
            uint256 gMint = gMake > gBurn ? gMake - gBurn : 0;

            // rest = everything else in assemble: storage, events, approvals, and the ownerOf checks as they run there
            // (warm: the burn just touched those slots); gCheck is the same check alone in a cold transaction.
            uint256 used = gVerify + gMake;
            uint256 rest = gTotal > used ? gTotal - used : 0;
            emit log(string.concat(vm.toString(k), " | ", vm.toString(gTotal), " | ", vm.toString(_intrinsic(data)), " | ",
                vm.toString(gBurn), " | ", vm.toString(gVerify), " | ", vm.toString(gCheck), " | ", vm.toString(gMint), " | ", vm.toString(rest)));
            vm.revertToState(snap);
        }
    }
}
