use contracts::objects::{Immutables, ImmutablesTrait, Order};
use starknet::{ClassHash, ContractAddress};


#[starknet::interface]
pub trait IResolver<TContractState> {
    fn deploy_src(
        ref self: TContractState, immutables: Immutables, order: Order, signature: felt252,
    );

    fn deploy_dst(
        ref self: TContractState, immutables: Immutables, src_cancellation_timestamp: u64,
    );

    fn withdraw_src(
        ref self: TContractState, escrow: ContractAddress, secret: felt252, immutables: Immutables,
    );

    fn withdraw_dst(
        ref self: TContractState, escrow: ContractAddress, secret: felt252, immutables: Immutables,
    );

    fn cancel_src(ref self: TContractState, escrow: ContractAddress, immutables: Immutables);

    fn cancel_dst(ref self: TContractState, escrow: ContractAddress, immutables: Immutables);
}


#[starknet::contract]
pub mod Resolver {
    pub const NATIVE_TOKEN_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    use contracts::EscrowDst::{IEscrowDstDispatcher, IEscrowDstDispatcherTrait};
    use contracts::EscrowFactory::{IEscrowFactoryDispatcher, IEscrowFactoryDispatcherTrait};
    use contracts::EscrowSrc::{IEscrowSrcDispatcher, IEscrowSrcDispatcherTrait};
    use contracts::LimitOrderProtocol::{
        ILimitOrderProtocolDispatcher, ILimitOrderProtocolDispatcherTrait,
    };
    use contracts::objects::{Immutables, ImmutablesTrait, Order, Timelocks};
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

    #[storage]
    struct Storage {
        LOP: ILimitOrderProtocolDispatcher,
        factory: IEscrowFactoryDispatcher,
        owner: ContractAddress,
        strk_token: ERC20ABIDispatcher,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        factory: ContractAddress,
        LOP: ContractAddress,
        owner: ContractAddress,
    ) {
        self.factory.write(IEscrowFactoryDispatcher { contract_address: factory });
        self.LOP.write(ILimitOrderProtocolDispatcher { contract_address: LOP });
        self.owner.write(owner);
        self
            .strk_token
            .write(
                ERC20ABIDispatcher { contract_address: NATIVE_TOKEN_ADDRESS.try_into().unwrap() },
            );
    }


    #[abi(embed_v0)]
    impl Resolver of super::IResolver<ContractState> {
        fn deploy_src(
            ref self: ContractState, immutables: Immutables, order: Order, signature: felt252,
        ) {
            self._only_owner();

            let mut immutables_mem = immutables;
            immutables_mem.timelocks = Timelocks {
                deployed_at: get_block_timestamp(),
                src_withdrawal: get_block_timestamp() + immutables.timelocks.src_withdrawal,
                src_public_withdrawal: get_block_timestamp() + immutables.timelocks.src_public_withdrawal,
                src_cancellation: get_block_timestamp() + immutables.timelocks.src_cancellation,
                src_public_cancellation: get_block_timestamp() + immutables.timelocks.src_public_cancellation,
                dst_withdrawal: get_block_timestamp() + immutables.timelocks.dst_withdrawal,
                dst_public_withdrawal: get_block_timestamp() + immutables.timelocks.dst_public_withdrawal,
                dst_cancellation: get_block_timestamp() + immutables.timelocks.dst_cancellation,
            };

            let factory = self.factory.read();
            let strk = self.strk_token.read();
            strk.approve(factory.contract_address, immutables.safety_deposit);

            let LOP = self.LOP.read();

            LOP.fill_order_args(order, immutables_mem, factory.contract_address);
        }

        fn deploy_dst(
            ref self: ContractState, immutables: Immutables, src_cancellation_timestamp: u64,
        ) {
            self._only_owner();

            let factory = self.factory.read();

            let token = ERC20ABIDispatcher { contract_address: immutables.token };
            token.approve(factory.contract_address, immutables.amount);

            let strk = self.strk_token.read();
            if (strk.contract_address == token.contract_address) {
                strk.approve(factory.contract_address, immutables.safety_deposit + immutables.amount);
            } else {
                strk.approve(factory.contract_address, immutables.safety_deposit);
            }


            factory.create_dst_escrow(immutables, src_cancellation_timestamp);
        }

        fn withdraw_src(
            ref self: ContractState,
            escrow: ContractAddress,
            secret: felt252,
            immutables: Immutables,
        ) {
            let escrow_src = IEscrowSrcDispatcher { contract_address: escrow };
            escrow_src.withdraw(secret, immutables);
        }

        fn withdraw_dst(
            ref self: ContractState,
            escrow: ContractAddress,
            secret: felt252,
            immutables: Immutables,
        ) {
            let escrow_dst = IEscrowDstDispatcher { contract_address: escrow };
            escrow_dst.withdraw(secret, immutables);
        }

        fn cancel_src(ref self: ContractState, escrow: ContractAddress, immutables: Immutables) {
            let escrow_src = IEscrowSrcDispatcher { contract_address: escrow };
            escrow_src.cancel(immutables);
        }

        fn cancel_dst(ref self: ContractState, escrow: ContractAddress, immutables: Immutables) {
            let escrow_dst = IEscrowDstDispatcher { contract_address: escrow };
            escrow_dst.cancel(immutables);
        }
    }

    #[generate_trait]
    pub(crate) impl InternalResolverFunctions of InternalResolverFunctionsTrait {
        fn _only_owner(self: @ContractState) {
            let owner = self.owner.read();
            let caller = get_caller_address();
            assert(owner == caller, 'Not owner');
        }
    }
}
