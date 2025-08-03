use contracts::objects::{Immutables, ImmutablesTrait, Order, OrderTrait};
use starknet::{ClassHash, ContractAddress};


#[starknet::interface]
pub trait ILimitOrderProtocol<TContractState> {
    fn fill_order_args(ref self: TContractState, order: Order, immutables: Immutables, factory_address: ContractAddress);
}


#[starknet::contract]
pub mod LimitOrderProtocol {
    use contracts::EscrowFactory::{IEscrowFactoryDispatcher, IEscrowFactoryDispatcherTrait};
    use contracts::objects::{Immutables, ImmutablesTrait};
    use core::hash::HashStateTrait;
    use core::poseidon::PoseidonTrait;
    use core::starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use openzeppelin_token::erc20::interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, contract_address_const, get_block_timestamp,
        get_caller_address, get_contract_address,
    };
    use super::*;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl LimitOrderProtocol of super::ILimitOrderProtocol<ContractState> {
        fn fill_order_args(
            ref self: ContractState, order: Order, immutables: Immutables, factory_address: ContractAddress,
        ) {
            let caller = get_caller_address();

            let token = ERC20ABIDispatcher { contract_address: order.maker_asset };
            token.transfer_from(order.maker, caller, order.making_amount);

            let factory = IEscrowFactoryDispatcher { contract_address: factory_address };

            factory
                .post_interaction(
                    order, order.hash(), order.making_amount, order.taking_amount, immutables, '0x00'.into(),
                );
        }
    }
}
