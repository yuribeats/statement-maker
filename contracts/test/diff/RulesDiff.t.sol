// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalBase} from "../LocalBase.t.sol";
import {Party} from "../../src/Party.sol";
import {CreditKeys} from "../../src/CreditKeys.sol";

/// @notice Pass rules and price resolution: runs each case of data/diff/rules.json (scripts/diff/gen-rules.mjs)
///         through a real Party on the local harness (Jack's Credits source, no RPC) and prints one result line per
///         case. scripts/diff/rules-compare.mjs compares these lines with the site's verdicts.
///         80 cards are spread over 80 voters (1 card each), so YES/NO counts are exact.
///         Line: RULE|i|proposeOk|executeOk|needFor|ask|revertData
contract RulesDiffTest is LocalBase {
    Party party;
    address[] voters;
    uint256 snapFull;
    uint256 t0;
    uint256 b0;

    uint256 n;
    uint256[] st;
    bool[] cancel;
    uint256[] mode;
    int256[] value;
    uint256[] floorWei;
    uint256[] yes;
    uint256[] no;
    bool[] deadlock;
    uint256[] cPrice;

    function setUp() public override {
        super.setUp();
        string memory json = vm.readFile("data/diff/rules.json");
        n = vm.parseJsonUint(json, ".n");
        st = vm.parseJsonUintArray(json, ".state");
        cancel = vm.parseJsonBoolArray(json, ".cancel");
        mode = vm.parseJsonUintArray(json, ".mode");
        value = vm.parseJsonIntArray(json, ".value");
        floorWei = vm.parseJsonUintArray(json, ".floorWei");
        yes = vm.parseJsonUintArray(json, ".yes");
        no = vm.parseJsonUintArray(json, ".no");
        deadlock = vm.parseJsonBoolArray(json, ".deadlock");
        cPrice = vm.parseJsonUintArray(json, ".cPrice");

        Party.Params memory p = params(CreditKeys.Preset.Deposit);
        p.durationDays = 60; // FULL must survive a 31-day warp for deadlock cases
        uint256[] memory a = ownedBy(holders[0]);
        uint256[] memory b = ownedBy(holders[1]);
        uint256[] memory b20 = new uint256[](20);
        for (uint256 i; i < 20; ++i) b20[i] = b[i];
        party = openParty(p, holders[0], a); // host opens with its 60
        deposit(party, holders[1], b20);
        require(party.count() == 80, "80");
        for (uint256 c = 1; c < cards.nextId(); ++c) {
            address v = makeAddr(string.concat("voter", vm.toString(voters.length)));
            voters.push(v);
            address o = cards.ownerOf(c);
            vm.prank(o);
            cards.transferFrom(o, v, c);
        }
        vm.roll(block.number + 2);
        vm.warp(block.timestamp + 60);
        t0 = block.timestamp;
        b0 = block.number;
        snapFull = vm.snapshotState();
    }

    function _case(uint256 i) internal {
        require(vm.revertToState(snapFull), "harness: revert");
        vm.roll(b0 + 1);
        vm.warp(t0 + 60);
        if (st[i] == 1) {
            uint256[] memory order = party.depositOrder();
            vm.prank(voters[0]);
            party.assemble(order, noFloor()); // default price: Fixed 3 ETH
            require(party.status() == Party.Status.ASSEMBLED && party.ask() == 3 ether, "harness: assembled");
        }
        vm.roll(block.number + 2);
        if (deadlock[i]) vm.warp(block.timestamp + 31 days);
        Party.PriceSpec memory ps = Party.PriceSpec(Party.PriceMode(mode[i]), value[i]);
        bool pOk;
        bool eOk;
        uint256 need;
        uint256 ask;
        bytes memory err;
        uint256 id;
        vm.prank(voters[0]);
        try party.propose(ps, cancel[i], 48, 24) returns (uint256 id_) {
            pOk = true;
            id = id_;
        } catch (bytes memory e) {
            err = e;
        }
        if (pOk) {
            require(party.proposal(id).deadlock == deadlock[i], "harness: deadlock flag");
            for (uint256 k = 1; k < yes[i]; ++k) { vm.prank(voters[k]); party.vote(id, true); }
            for (uint256 k = yes[i]; k < yes[i] + no[i]; ++k) { vm.prank(voters[k]); party.vote(id, false); }
            Party.Proposal memory pr = party.proposal(id);
            require(pr.yes == yes[i] && pr.no == no[i], "harness: tally");
            vm.warp(pr.endsAt);
            need = party.needFor(id, cPrice[i], floorWei[i]);
            Party.Floor memory f = floorSig(floorWei[i], 0);
            vm.prank(voters[0]);
            try party.execute(id, f) {
                eOk = true;
                ask = party.ask();
            } catch (bytes memory e) {
                err = e;
            }
        }
        emit log(string.concat("RULE|", vm.toString(i), "|", pOk ? "1" : "0", "|", eOk ? "1" : "0", "|", vm.toString(need), "|", vm.toString(ask), "|", vm.toString(err)));
    }

    function _range(uint256 k) internal {
        uint256 per = (n + 5) / 6;
        uint256 end = (k + 1) * per > n ? n : (k + 1) * per;
        for (uint256 i = k * per; i < end; ++i) _case(i);
    }

    function test_rules_0() public { _range(0); }
    function test_rules_1() public { _range(1); }
    function test_rules_2() public { _range(2); }
    function test_rules_3() public { _range(3); }
    function test_rules_4() public { _range(4); }
    function test_rules_5() public { _range(5); }
}
