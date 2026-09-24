// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UnitBase} from "./UnitBase.t.sol";
import {Party} from "../../src/Party.sol";
import {PartyFactory} from "../../src/PartyFactory.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";
import {ICredits, IStatement} from "../../src/interfaces/IExternal.sol";

/// Floor signatures, exercised through assemble() on a FloorPct-default party and via isValidFloor().
contract FloorTest is UnitBase {
    Party party;
    uint256[] dep;
    address arranger;
    uint256 realChain;

    function setUp() public override {
        super.setUp();
        realChain = block.chainid;
        _mk(Party.FloorMode.Avg24h, false);
    }

    function _mk(Party.FloorMode mode, bool alt) internal {
        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.defaultPrice = Party.PriceSpec(Party.PriceMode.FloorPct, 0); // ask = floor
        p.floorMode = mode;
        if (alt) {
            party = scrambledParty(p);
        } else {
            party = newParty(p);
            fill(party);
        }
        dep = party.depositOrder();
        arranger = alt ? holders[3] : holders[0];
    }

    function _try(Party.Floor memory f, bytes memory err) internal {
        vm.prank(arranger);
        if (err.length > 0) vm.expectRevert(err);
        party.assemble(dep, f);
    }

    function test_valid() public {
        _try(floorSig(5 ether, 0), "");
        assertEq(party.ask(), 5 ether);
    }

    function test_wrongSigner() public {
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp), 0xB0B, factory);
        _try(f, bad("floor sig"));
    }

    function test_wrongMode_latestSigForAvgParty() public {
        _try(floorSig(5 ether, 1), bad("floor sig"));
    }

    function test_wrongMode_avgSigForLatestParty() public {
        _mk(Party.FloorMode.Latest, true);
        _try(floorSig(5 ether, 0), bad("floor sig"));
        _try(floorSig(5 ether, 1), "");
    }

    function test_tamperedValue() public {
        Party.Floor memory f = floorSig(5 ether, 0);
        f.floorWei = 6 ether;
        _try(f, bad("floor sig"));
    }

    function test_futureIssuedAt() public {
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp + 1), signerKey, factory);
        _try(f, bad("stale floor"));
    }

    function test_olderThanOneHour() public {
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp - 1 hours - 1), signerKey, factory);
        _try(f, bad("stale floor"));
    }

    function test_exactlyOneHourOld_ok() public {
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp - 1 hours), signerKey, factory);
        _try(f, "");
    }

    function test_floorZero() public {
        _try(floorSig(0, 0), bad("floor"));
    }

    function test_badSigBytes() public {
        Party.Floor memory f = floorSig(5 ether, 0);
        f.sig = hex"00";
        _try(f, bad("floor sig"));
    }

    function test_otherFactoryDomain() public {
        PartyFactory f2 = new PartyFactory(
            ICredits(address(credits)), IStatement(address(statement)), feeTo, vm.addr(signerKey), collectionOwner
        );
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp), signerKey, f2);
        assertTrue(f2.isValidFloor(5 ether, 0, f.issuedAt, f.sig));
        assertFalse(factory.isValidFloor(5 ether, 0, f.issuedAt, f.sig));
        _try(f, bad("floor sig"));
    }

    function test_otherChainDomain() public {
        uint256 id = realChain; // read in setUp: via-IR may defer a local block.chainid read past vm.chainId
        vm.chainId(5);
        Party.Floor memory f = floorAt(5 ether, 0, uint64(block.timestamp), signerKey, factory);
        vm.chainId(id);
        assertFalse(factory.isValidFloor(5 ether, 0, f.issuedAt, f.sig));
        _try(f, bad("floor sig"));
    }

    function test_isValidFloor_direct() public view {
        Party.Floor memory f = floorSig(1 ether, 1);
        assertTrue(factory.isValidFloor(1 ether, 1, f.issuedAt, f.sig));
        assertFalse(factory.isValidFloor(1 ether, 0, f.issuedAt, f.sig));
        assertFalse(factory.isValidFloor(1 ether, 1, f.issuedAt + 1, f.sig));
        assertFalse(factory.isValidFloor(1 ether, 1, f.issuedAt, hex""));
    }
}
