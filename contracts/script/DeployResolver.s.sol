// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script, console} from "forge-std/Script.sol";
import {Resolver} from "../src/Resolver.sol";
import {IEscrowFactory} from "../lib/cross-chain-swap/contracts/interfaces/IEscrowFactory.sol";
import {IOrderMixin} from "limit-order-protocol/contracts/interfaces/IOrderMixin.sol";


contract DeployResolver is Script {
    function setUp() public {}

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY_EVM_RESOLVER");
        
        vm.startBroadcast(deployerPrivateKey);

        Resolver resolver = new Resolver(
            IEscrowFactory(0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A),
            IOrderMixin(0x111111125421cA6dc452d289314280a0f8842A65),
            0x09253DbFBd2B9e98F342AEBA88884cC1a84aaBe4
        );

        console.log("Resolver successfully deployed to:", address(resolver));

        vm.stopBroadcast();
    }
}