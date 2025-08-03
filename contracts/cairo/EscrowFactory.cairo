use contracts::objects::{Immutables, ImmutablesTrait, Order};
use starknet::{ClassHash, ContractAddress};


#[starknet::interface]
pub trait IEscrowFactory<TContractState> {
    fn create_dst_escrow(
        ref self: TContractState, dst_immutables: Immutables, src_cancellation_timestamp: u64,
    );

    fn address_of_escrow_src(self: @TContractState, immutables: Immutables) -> ContractAddress;

    fn address_of_escrow_dst(self: @TContractState, immutables: Immutables) -> ContractAddress;

    fn post_interaction(
        ref self: TContractState,
        order: Order,
        order_hash: felt252,
        making_amount: u256,
        taking_amount: u256,
        immutables: Immutables,
        extraData: felt252,
    );
}


#[starknet::contract]
pub mod EscrowFactory {
    pub const NATIVE_TOKEN_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    use contracts::EscrowDst::EscrowDst;
    use contracts::objects::{Immutables, ImmutablesTrait, Order, OrderTrait, Timelocks};
    use core::hash::HashStateTrait;
    use core::pedersen::PedersenTrait;
    use core::poseidon::{PoseidonTrait, poseidon_hash_span};
    use core::starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use openzeppelin_token::erc20::interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, contract_address_const, get_block_timestamp,
        get_caller_address, get_contract_address,
    };
    #[storage]
    struct Storage {
        escrow_src_class_hash: ClassHash,
        escrow_dst_class_hash: ClassHash,
        limit_order_protocol: ContractAddress,
        strk_token: ERC20ABIDispatcher,
        immutables_hash_to_address: Map<felt252, ContractAddress>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        DstEscrowCreated: DstEscrowCreated,
        SrcEscrowCreated: SrcEscrowCreated,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DstEscrowCreated {
        pub escrow: ContractAddress,
        pub dst_immutables_hashlock: felt252,
        pub dst_immutables_taker: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SrcEscrowCreated {
        pub escrow: ContractAddress,
        pub src_cancellation: u64,
    }


    #[constructor]
    fn constructor(
        ref self: ContractState,
        limit_order_protocol: ContractAddress,
        escrow_src_class_hash: ClassHash,
        escrow_dst_class_hash: ClassHash,
    ) {
        self.escrow_src_class_hash.write(escrow_src_class_hash);
        self.escrow_dst_class_hash.write(escrow_dst_class_hash);
        self.limit_order_protocol.write(limit_order_protocol);

        self
            .strk_token
            .write(
                ERC20ABIDispatcher { contract_address: NATIVE_TOKEN_ADDRESS.try_into().unwrap() },
            );
    }


    #[abi(embed_v0)]
    impl EscrowFactory of super::IEscrowFactory<ContractState> {
        fn create_dst_escrow(
            ref self: ContractState, dst_immutables: Immutables, src_cancellation_timestamp: u64,
        ) {
            let mut immutables: Immutables = dst_immutables;

            // immutables.timelocks.deployed_at = get_block_timestamp();
            immutables.timelocks = Timelocks {
                deployed_at: get_block_timestamp(),
                src_withdrawal: get_block_timestamp() + dst_immutables.timelocks.src_withdrawal,
                src_public_withdrawal: get_block_timestamp() + dst_immutables.timelocks.src_public_withdrawal,
                src_cancellation: get_block_timestamp() + dst_immutables.timelocks.src_cancellation,
                src_public_cancellation: get_block_timestamp() + dst_immutables.timelocks.src_public_cancellation,
                dst_withdrawal: get_block_timestamp() + dst_immutables.timelocks.dst_withdrawal,
                dst_public_withdrawal: get_block_timestamp() + dst_immutables.timelocks.dst_public_withdrawal,
                dst_cancellation: get_block_timestamp() + dst_immutables.timelocks.dst_cancellation,
            };

            assert(
                immutables.timelocks.dst_cancellation < src_cancellation_timestamp,
                'InvalidCreationTime',
            );

            let salt: felt252 = immutables.hash();

            let escrow = self._deploy_escrow(salt, self.escrow_dst_class_hash.read(), immutables);

            let caller = get_caller_address();
            let strk = self.strk_token.read();
            strk.transfer_from(caller, escrow, dst_immutables.safety_deposit);

            let token = ERC20ABIDispatcher { contract_address: dst_immutables.token };
            token.transfer_from(caller, escrow, dst_immutables.amount);

            self.immutables_hash_to_address.entry(dst_immutables.hash()).write(escrow);

            self
                .emit(
                    DstEscrowCreated {
                        escrow,
                        dst_immutables_hashlock: dst_immutables.hash_lock,
                        dst_immutables_taker: dst_immutables.taker,
                    },
                );
        }

        fn address_of_escrow_src(self: @ContractState, immutables: Immutables) -> ContractAddress {
            let salt: felt252 = immutables.hash();

            let mut calldata = ArrayTrait::new();
            get_contract_address().serialize(ref calldata);
            let constructor_calldata_hash = poseidon_hash_span(calldata.span());

            let mut address_data = ArrayTrait::new();
            'STARKNET_CONTRACT_ADDRESS'.serialize(ref address_data);
            get_contract_address().serialize(ref address_data);
            salt.serialize(ref address_data);
            self.escrow_src_class_hash.read().serialize(ref address_data);
            constructor_calldata_hash.serialize(ref address_data);

            let address_hash = poseidon_hash_span(address_data.span());
            let compute_address: ContractAddress = address_hash.try_into().unwrap();

            self.immutables_hash_to_address.entry(salt).read()
        }

        fn address_of_escrow_dst(self: @ContractState, immutables: Immutables) -> ContractAddress {
            let salt: felt252 = immutables.hash();

            let mut calldata = ArrayTrait::new();
            get_contract_address().serialize(ref calldata);
            let constructor_calldata_hash = poseidon_hash_span(calldata.span());

            let mut address_data = ArrayTrait::new();
            'STARKNET_CONTRACT_ADDRESS'.serialize(ref address_data);
            get_contract_address().serialize(ref address_data);
            salt.serialize(ref address_data);
            self.escrow_dst_class_hash.read().serialize(ref address_data);
            constructor_calldata_hash.serialize(ref address_data);

            let address_hash = poseidon_hash_span(address_data.span());
            let compute_address: ContractAddress = address_hash.try_into().unwrap();

            self.immutables_hash_to_address.entry(salt).read()
        }

        fn post_interaction(
            ref self: ContractState,
            order: Order,
            order_hash: felt252,
            making_amount: u256,
            taking_amount: u256,
            immutables: Immutables,
            extraData: felt252,
        ) {
            // assert caller is LOP
            let salt: felt252 = immutables.hash();

            let mut calldata = ArrayTrait::new();
            get_contract_address().serialize(ref calldata);

            let (escrow_address, _) = deploy_syscall(
                self.escrow_src_class_hash.read(), salt, calldata.span(), false,
            )
                .unwrap_syscall();

            let strk = self.strk_token.read();
            strk.transfer_from(immutables.taker, escrow_address, immutables.safety_deposit);

            self.immutables_hash_to_address.entry(immutables.hash()).write(escrow_address);

            self.emit(
                SrcEscrowCreated {
                    escrow: escrow_address,
                    src_cancellation: immutables.timelocks.src_cancellation
                }
            );
        }
    }


    #[generate_trait]
    pub(crate) impl InternalEscrowFactoryFunctions of InternalEscrowFactoryFunctionsTrait {
        // create a new escrow for maker on source chain
        // the caller must pre-send the safety deposit to external postInteraction
        // function call will be made from the Limit Order Protocol

        fn _deploy_escrow(
            ref self: ContractState,
            salt: felt252,
            escrow_class_hash: ClassHash,
            immutables: Immutables,
        ) -> ContractAddress {
            let mut calldata = ArrayTrait::new();
            get_contract_address().serialize(ref calldata);

            let (escrow_address, _) = deploy_syscall(
                escrow_class_hash, salt, calldata.span(), false,
            )
                .unwrap_syscall();
            escrow_address
        }
    }
}
