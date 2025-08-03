use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockToken<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockToken {
    use openzeppelin_token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState // name: ByteArray,
    // symbol: ByteArray,
    // initial_supply: u256,
    // amount_to_mint: u256,
    // recipient: ContractAddress
    ) {
        self.erc20.initializer("tsFusion", "tsFusion");
    }

    #[abi(embed_v0)]
    impl MockTokenImpl of super::IMockToken<ContractState> {
        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.erc20.mint(recipient, amount);
        }
    }
}
