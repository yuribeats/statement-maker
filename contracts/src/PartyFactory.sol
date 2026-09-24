// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CreditCards} from "./CreditCards.sol";
import {Party} from "./Party.sol";
import {ICredits, IStatement, ICreditTraits} from "./interfaces/IExternal.sol";

/// @title Statement Maker factory
/// @notice Deploys one Party per party (minimal clone) and the shared Credit Card collection.
///         No owner, no admin, no upgrade path: every address below is fixed at deployment.
contract PartyFactory is EIP712 {
    ICredits public immutable credits;
    IStatement public immutable statement;
    CreditCards public immutable cards;
    Party public immutable implementation;
    address public immutable feeRecipient;
    address public immutable floorSigner;
    ICreditTraits public immutable traits; // sealed per-Credit trait table the sorted presets verify against
    uint16 public constant FEE_BPS = 100; // 1%

    bytes32 public constant FLOOR_TYPEHASH = keccak256("Floor(uint256 floorWei,uint8 mode,uint64 issuedAt)");

    address[] public parties;
    mapping(address => bool) public isParty;
    mapping(address host => uint256) public nonces;
    event PartyCreated(address indexed party, address indexed host, uint256 index);

    /// @param collectionOwner_ becomes CreditCards.owner(): marketplace collection-page editing only, no protocol powers.
    constructor(ICredits credits_, IStatement statement_, address feeRecipient_, address floorSigner_, address collectionOwner_, ICreditTraits traits_) EIP712("Statement Maker", "1") {
        require(address(credits_) != address(0) && address(statement_) != address(0) && feeRecipient_ != address(0) && floorSigner_ != address(0) && address(traits_).code.length > 0, "zero");
        traits = traits_;
        credits = credits_;
        statement = statement_;
        feeRecipient = feeRecipient_;
        floorSigner = floorSigner_;
        cards = new CreditCards(address(this), collectionOwner_);
        implementation = new Party();
    }

    /// @notice Opens a party and makes the host's opening deposit in one transaction: at least the party's minimum,
    ///         every Credit meeting its criteria. The only approval users ever give is setApprovalForAll(this factory)
    ///         on Credits; the factory moves Credits only from its own caller, and only into one of its parties.
    function createParty(Party.Params calldata p, uint256[] calldata ids, bytes32[][] calldata proofs) external returns (Party party) {
        party = Party(payable(Clones.cloneDeterministic(address(implementation), _salt(msg.sender, nonces[msg.sender]++))));
        isParty[address(party)] = true;
        cards.registerParty(address(party));
        party.initialize(msg.sender, p);
        _deposit(party, ids, proofs);
        parties.push(address(party));
        emit PartyCreated(address(party), msg.sender, parties.length - 1);
    }

    /// @notice Deposit `ids` from the caller into `party` (one of this factory's parties): one Credit Card per Credit.
    ///         Needs setApprovalForAll(this factory) on Credits.
    function deposit(Party party, uint256[] calldata ids, bytes32[][] calldata proofs) external {
        require(isParty[address(party)], "not a party");
        _deposit(party, ids, proofs);
    }

    function _deposit(Party party, uint256[] calldata ids, bytes32[][] calldata proofs) internal {
        for (uint256 i; i < ids.length; ++i) credits.transferFrom(msg.sender, address(party), ids[i]); // caller's own only
        party.onDeposit(msg.sender, ids, proofs); // eligibility, slots, status, receipt; mints the cards
    }

    /// @notice Seconds per "hour" for party rule windows. Always 1 hour here; TestnetPartyFactory overrides it.
    function timeUnit() public view virtual returns (uint256) {
        return 1 hours;
    }

    /// @notice The address `host`'s next party will have (informational; nothing is ever approved to a party).
    function predictParty(address host) external view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), _salt(host, nonces[host]), address(this));
    }

    function _salt(address host, uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode(host, n));
    }

    function partiesCount() external view returns (uint256) {
        return parties.length;
    }

    /// @notice Recovers the signer of a floor reading; parties accept only `floorSigner`.
    function floorDigest(uint256 floorWei, uint8 mode, uint64 issuedAt) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(FLOOR_TYPEHASH, floorWei, mode, issuedAt)));
    }

    function isValidFloor(uint256 floorWei, uint8 mode, uint64 issuedAt, bytes calldata sig) external view returns (bool) {
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(floorDigest(floorWei, mode, issuedAt), sig);
        return err == ECDSA.RecoverError.NoError && who == floorSigner;
    }
}
