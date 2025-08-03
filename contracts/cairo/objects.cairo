use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use starknet::{ClassHash, ContractAddress};

#[derive(Serde, Drop, Copy, Debug)]
pub struct Timelocks {
    pub deployed_at: u64,
    pub src_withdrawal: u64,
    pub src_public_withdrawal: u64,
    pub src_cancellation: u64,
    pub src_public_cancellation: u64,
    pub dst_withdrawal: u64,
    pub dst_public_withdrawal: u64,
    pub dst_cancellation: u64,
}


#[derive(Serde, Drop, Copy, Debug)]
pub struct Immutables {
    pub order_hash: felt252,
    pub hash_lock: felt252,
    pub maker: ContractAddress,
    pub taker: ContractAddress,
    pub token: ContractAddress,
    pub amount: u256,
    pub safety_deposit: u256,
    pub timelocks: Timelocks,
}

#[generate_trait]
pub impl ImmutablesImpl of ImmutablesTrait {
    fn new(
        order_hash: felt252,
        hash_lock: felt252,
        maker: ContractAddress,
        taker: ContractAddress,
        token: ContractAddress,
        amount: u256,
        safety_deposit: u256,
        timelocks: Timelocks,
    ) -> Immutables {
        Immutables { order_hash, hash_lock, maker, taker, token, amount, safety_deposit, timelocks }
    }

    fn hash(self: @Immutables) -> felt252 {
        let hash = PoseidonTrait::new()
            .update(*self.order_hash.into())
            .update(*self.hash_lock.into())
            .finalize();
        return hash;
    }
}


// IEscrowFactory

#[derive(Serde, Drop, Copy, Debug)]
pub struct ExtraDataArgs {
    hash_lock_info: felt252,
    dst_chain_id: u128,
    dst_token: ContractAddress,
    deposits: u256,
    timelocks: Timelocks,
}


#[derive(Serde, Drop, Copy, Debug)]
pub struct DstImmutablesComplement {
    maker: ContractAddress,
    amount: u256,
    token: ContractAddress,
    safety_deposit: u256,
    chain_id: u128,
}


#[derive(Serde, Drop, Copy, Debug)]
pub struct Order {
    pub salt: felt252,
    pub maker: ContractAddress,
    pub receiver: ContractAddress,
    pub maker_asset: ContractAddress,
    pub taker_asset: ContractAddress,
    pub making_amount: u256,
    pub taking_amount: u256,
}

#[generate_trait]
pub impl OrderImpl of OrderTrait {
    fn hash(self: @Order) -> felt252 {
        let hash = PoseidonTrait::new()
            .update(*self.salt.into())
            .finalize();
        return hash;
    }
}
