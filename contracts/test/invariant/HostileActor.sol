// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A contract card holder driven by the invariant handler.
///         mode 1 (REENTER): on ETH receipt, re-enters the paying party (claim / withdraw / buy / redeem).
///         mode 2 (REVERT): reverts on any ETH receipt.
///         mode 3 (CALLBACK): on ETH receipt, tries assemble / redeem / redeemFor / execute / deposit.
///         Every re-entry attempt targets the party that is paying; any success is a violation because every
///         function that can pay ETH is nonReentrant and the pokes are all nonReentrant functions.
contract HostileActor {
    uint8 public constant REENTER = 1;
    uint8 public constant REVERT = 2;
    uint8 public constant CALLBACK = 3;

    uint8 public immutable mode;
    address public immutable owner;
    address public target;
    bytes[] internal _pokes;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;
    bytes public lastSuccess;

    constructor(uint8 m) {
        mode = m;
        owner = msg.sender;
    }

    function arm(address t, bytes[] calldata pokes) external {
        require(msg.sender == owner, "owner");
        target = t;
        delete _pokes;
        for (uint256 i; i < pokes.length; ++i) _pokes.push(pokes[i]);
    }

    function act(address to, bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        require(msg.sender == owner, "owner");
        (ok, ret) = to.call{value: msg.value}(data);
    }

    receive() external payable {
        if (mode == REVERT) revert("no ETH");
        address t = target;
        if (t == address(0) || msg.sender != t) return;
        for (uint256 i; i < _pokes.length; ++i) {
            ++reentryAttempts;
            (bool ok,) = t.call(_pokes[i]);
            if (ok) {
                ++reentrySuccesses;
                lastSuccess = _pokes[i];
            }
        }
    }
}
