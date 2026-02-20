// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import {SimpleAccount} from "../src/SimpleAccount.sol";
import {SimpleAccountFactory} from "../src/SimpleAccountFactory.sol";

contract MockEntryPoint {
    mapping(address => mapping(uint192 => uint256)) internal nonces;

    function setNonce(address sender, uint192 key, uint256 value) external {
        nonces[sender][key] = value;
    }

    function getNonce(address sender, uint192 key) external view returns (uint256) {
        return nonces[sender][key];
    }

    function callExecute(SimpleAccount account, address dest, uint256 value, bytes calldata func) external {
        account.execute(dest, value, func);
    }
}

contract Target {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }
}

contract UnauthorizedCaller {
    function callExecute(
        SimpleAccount account,
        address dest,
        uint256 value,
        bytes calldata func
    ) external {
        account.execute(dest, value, func);
    }

    function callTransferOwnership(SimpleAccount account, address newOwner) external {
        account.transferOwnership(newOwner);
    }
}

contract SimpleAccountTest {
    MockEntryPoint internal entryPoint;
    Target internal target;
    UnauthorizedCaller internal unauthorized;

    function setUp() public {
        entryPoint = new MockEntryPoint();
        target = new Target();
        unauthorized = new UnauthorizedCaller();
    }

    function testOwnerCanExecute() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));

        account.execute(address(target), 0, abi.encodeWithSelector(Target.setValue.selector, 7));
        require(target.value() == 7, "owner execute failed");
    }

    function testEntryPointCanExecute() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));

        entryPoint.callExecute(account, address(target), 0, abi.encodeWithSelector(Target.setValue.selector, 11));
        require(target.value() == 11, "entrypoint execute failed");
    }

    function testUnauthorizedExecuteReverts() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));

        (bool ok,) = address(unauthorized).call(
            abi.encodeWithSelector(
                UnauthorizedCaller.callExecute.selector,
                account,
                address(target),
                0,
                abi.encodeWithSelector(Target.setValue.selector, 3)
            )
        );
        require(!ok, "expected unauthorized execute revert");
    }

    function testExecuteBatchLengthMismatchReverts() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));

        address[] memory destinations = new address[](1);
        destinations[0] = address(target);
        bytes[] memory payloads = new bytes[](0);
        (bool ok,) = address(account).call(
            abi.encodeWithSelector(SimpleAccount.executeBatch.selector, destinations, payloads)
        );
        require(!ok, "expected executeBatch length mismatch revert");
    }

    function testTransferOwnershipRequiresOwner() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));

        (bool unauthorizedOk,) = address(unauthorized).call(
            abi.encodeWithSelector(UnauthorizedCaller.callTransferOwnership.selector, account, address(0xBEEF))
        );
        require(!unauthorizedOk, "expected transferOwnership revert for non-owner");

        account.transferOwnership(address(0xBEEF));
        require(account.owner() == address(0xBEEF), "owner not updated");
    }

    function testGetNonceDelegatesToEntryPoint() public {
        SimpleAccount account = new SimpleAccount(address(this), address(entryPoint));
        entryPoint.setNonce(address(account), 0, 9);
        require(account.getNonce() == 9, "nonce mismatch");
    }

    function testFactoryCreateAccountIsDeterministicAndIdempotent() public {
        SimpleAccountFactory factory = new SimpleAccountFactory(address(entryPoint));
        address owner = address(0xABCD);
        uint256 salt = 42;

        address predicted = factory.getAddress(owner, salt);
        SimpleAccount first = factory.createAccount(owner, salt);
        SimpleAccount second = factory.createAccount(owner, salt);

        require(address(first) == predicted, "factory first address mismatch");
        require(address(second) == predicted, "factory second address mismatch");
    }
}
