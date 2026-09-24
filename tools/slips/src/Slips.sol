// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {CreditDrawing} from "./CreditDrawing.sol";
/// Exposes the Credits art library's internal plate-shift function so we read the exact on-chain values.
contract Slips {
    function slips(bytes21 seed) external pure returns (int8[4] memory dxs, int8[4] memory dys) {
        return CreditDrawing.slips(seed);
    }
}
