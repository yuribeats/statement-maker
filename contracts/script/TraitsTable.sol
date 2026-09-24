// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CreditTraits} from "../src/CreditTraits.sol";

/// @notice Deploys a CreditTraits table from its packed bytes (3 bytes per id, ids 1..n): one SSTORE2 data contract per
///         8,191 ids (each about 5.4M gas, under the per-transaction cap), then CreditTraits over them.
library TraitsTable {
    function deploy(bytes memory data) internal returns (CreditTraits) {
        require(data.length % 3 == 0 && data.length > 0, "table length");
        uint256 n = data.length / 3;
        uint256 per = 8191;
        uint256 chunks = (n + per - 1) / per;
        address[] memory a = new address[](chunks);
        for (uint256 i; i < chunks; ++i) {
            uint256 from = i * per * 3;
            uint256 len = (i + 1 < chunks ? per : n - i * per) * 3;
            a[i] = deployChunk(data, from, len);
        }
        return new CreditTraits(a, n);
    }

    /// SSTORE2: init code returns code = 0x00 ++ data[from : from + len].
    function deployChunk(bytes memory data, uint256 from, uint256 len) internal returns (address c) {
        uint256 rt = len + 1;
        bytes memory init = abi.encodePacked(hex"61", uint16(rt), hex"80600a3d393df3", hex"00", slice(data, from, len));
        assembly {
            c := create(0, add(init, 32), mload(init))
        }
        require(c != address(0) && c.code.length == rt, "chunk deploy");
    }

    function slice(bytes memory data, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = data[from + i];
    }
}
