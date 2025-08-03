use contracts::objects::{Immutables, ImmutablesTrait};
use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait IEscrowDst<TContractState> {
    fn withdraw(ref self: TContractState, secret: felt252, immutables: Immutables);

    fn public_withdraw(ref self: TContractState, secret: felt252, immutables: Immutables);

    fn cancel(ref self: TContractState, immutables: Immutables);
}


#[starknet::contract]
pub mod EscrowDst {
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

    pub const NATIVE_TOKEN_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;

    #[storage]
    struct Storage {
        factory: IEscrowFactoryDispatcher,
        strk_token: ERC20ABIDispatcher,
    }


    #[constructor]
    fn constructor(ref self: ContractState, factory: ContractAddress) {
        self.factory.write(IEscrowFactoryDispatcher { contract_address: factory });
        self
            .strk_token
            .write(
                ERC20ABIDispatcher { contract_address: NATIVE_TOKEN_ADDRESS.try_into().unwrap() },
            );
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Withdrawal: Withdrawal,
        EscrowCancelled: EscrowCancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawal {
        pub secret: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct EscrowCancelled {}


    #[abi(embed_v0)]
    impl EscrowDst of super::IEscrowDst<ContractState> {
        fn withdraw(ref self: ContractState, secret: felt252, immutables: Immutables) {
            // self._only_taker(immutables);
            // self._only_after(immutables.timelocks.dst_withdrawal + immutables.timelocks.deployed_at);
            // self._only_before(immutables.timelocks.dst_cancellation + immutables.timelocks.deployed_at);

            self._withdraw(secret, immutables);
        }

        fn public_withdraw(ref self: ContractState, secret: felt252, immutables: Immutables) {
            self._only_after(immutables.timelocks.dst_public_withdrawal + immutables.timelocks.deployed_at);
            self._only_before(immutables.timelocks.dst_cancellation + immutables.timelocks.deployed_at);

            self._withdraw(secret, immutables);
        }

        fn cancel(ref self: ContractState, immutables: Immutables) {
            self._only_taker(immutables);
            self._only_valid_immutables(immutables);
            self._only_after(immutables.timelocks.dst_cancellation + immutables.timelocks.deployed_at);

            let token = ERC20ABIDispatcher { contract_address: immutables.token };
            let to = immutables.taker;
            token.transfer(to, immutables.amount);

            let strk = self.strk_token.read();
            strk.transfer(get_caller_address(), immutables.safety_deposit);

            self.emit(EscrowCancelled {});
        }
    }


    #[generate_trait]
    pub(crate) impl InternalEscrowFunctions of InternalEscrowFunctionsTrait {
        fn _only_taker(self: @ContractState, immutables: Immutables) {
            let taker = immutables.taker;
            let caller = get_caller_address();

            assert(taker == caller, 'Not taker');
        }

        fn _only_valid_immutables(self: @ContractState, immutables: Immutables) {
            let address = self.factory.read().address_of_escrow_dst(immutables);

            assert(get_contract_address() == address, 'Invalid immutables');
        }

        fn _only_valid_secret(self: @ContractState, secret: felt252, immutables: Immutables) {
            let hash_lock = immutables.hash_lock;

            let hash_secret = PoseidonTrait::new().update(secret).finalize();

            assert(hash_lock == hash_secret, 'Invalid secret');
        }

        fn _only_after(self: @ContractState, start: u64) {
            let current_time = get_block_timestamp();

            assert(current_time >= start, 'Not after start time');
        }

        fn _only_before(self: @ContractState, stop: u64) {
            let current_time = get_block_timestamp();

            assert(current_time < stop, 'Not before stop time');
        }

        fn _withdraw(ref self: ContractState, secret: felt252, immutables: Immutables) {
            self._only_valid_immutables(immutables);
            self._only_valid_secret(secret, immutables);

            let token = ERC20ABIDispatcher { contract_address: immutables.token };
            let to = immutables.maker;

            token.transfer(to, immutables.amount);

            self.emit(Withdrawal { secret });
        }
    }
}
