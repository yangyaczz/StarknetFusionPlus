# Starknet <-> EVM Fusion+

A cross-chain token swap implementation between Starknet and EVM-compatible chains, enabling seamless token exchanges across different blockchain networks.

## Overview

This project demonstrates a cross-chain atomic swap mechanism that allows users to exchange tokens between Starknet and EVM chains (like Optimism) using escrow contracts and a resolver system.

## Features

- ✅ Bi-directional swaps (Starknet ↔ EVM)
- ✅ Atomic transactions with escrow protection(HLTC)
- ✅ Cairo smart contracts for Starknet integration
- ✅ Automated secret-based resolution system
- ✅ Support for multiple EVM chains

## Installation

### Prerequisites

- Node.js and pnpm
- [Foundry](https://book.getfoundry.sh/getting-started/installation) for smart contract development

### Setup

1. Install project dependencies:
```bash
pnpm install
```

2. Install Foundry:
```bash
curl -L https://foundry.paradigm.xyz | bash
```

3. Install contract dependencies:
```bash
forge install
```

## Usage

### Starknet to EVM Swap

Swap tokens from Starknet to an EVM chain (e.g., Optimism):

```bash
pnpm run SNTOEVM <starknetToken> <sourceAmount> <evmToken> <destinationAmount> <evmUserAddress>
```

**Example:**
```bash
pnpm run SNTOEVM 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 0.01 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25
```

### EVM to Starknet Swap

Swap tokens from an EVM chain to Starknet:

```bash
pnpm run EVMTOSN <evmToken> <sourceAmount> <starknetToken> <destinationAmount> <starknetUserAddress>
```

**Example:**
```bash
pnpm run EVMTOSN 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae
```

## Smart Contracts

### Cairo Contracts (Starknet)

Cairo smart contracts are located in `contracts/cairo/`:

- `EscrowSrc.cairo` - Source escrow contract for Starknet
- `EscrowDst.cairo` - Destination escrow contract for Starknet  
- `EscrowFactory.cairo` - Factory contract for creating escrow instances
- `Resolver` - Resolver contract for resolver

### Solidity Contracts (EVM)

EVM-compatible contracts are in `contracts/src/`:

- `Resolver.sol` - Main resolver contract

## Example Transaction Flow

Here's a successful EVM to Starknet swap example:

```
yycz@yyczdeMacBook-Pro cross-chain-resolver-example % pnpm run EVMTOSN 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae

> cross-chain-resolver-example@1.0.0 EVMTOSN /Users/yycz/ethglobal/1inch/cross-chain-resolver-example
> tsx scripts/swap-op-to-starknet.ts 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae

📋 Swap parameters:
  Source Token: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B
  Source Amount: 8
  Destination Token: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
  Destination Amount: 1
  Starknet User: 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae

🚀 Starting OP to Starknet cross-chain token swap
Source token: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B -> Destination token: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
Swap amount: 8 -> 1
Actual amounts: 8000000000000000000 -> 1000000000000000000 (18 decimals)
💰 Current token balance: 24000000000000000000 (needed: 8000000000000000000)

=== STEP 1: User submits order ===
{
  srcToken: '0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B',
  dstToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  makingAmount: 8,
  takingAmount: 1
}
📋 Created cross-chain order: {
  orderHash: '0x1184508c5dafb1ab2c0c6d4a3b3dc8743faaeb4a031cdc0d9d017f3fdd21b4a4',
  makingAmount: '8000000000000000000',
  takingAmount: '1000000000000000000',
  srcToken: '0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B',
  dstToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
}
📝 Order signed: 0xa1a851467feeed802ec528289138e28fa409ff0c0dbbd8b475175f052054b6c10bf0362ed3be5f312ca3d080dd90e66e2af20ba982c8255a094397e1664ff29a1c
📝 Order hash: 0x1184508c5dafb1ab2c0c6d4a3b3dc8743faaeb4a031cdc0d9d017f3fdd21b4a4

=== STEP 2: Resolver receives order and deploys src & dst escrows ===
📤 Submitting order to resolver...
[10] Order 0x1184508c5dafb1ab2c0c6d4a3b3dc8743faaeb4a031cdc0d9d017f3fdd21b4a4 filled for 8000000000000000000 in tx:
🔗 https://optimistic.etherscan.io/tx/0x16db9026971ca570ce26f686b6d434ed3804e9b45c14a58988b3b0e75f674740
Starknet dst created:
🔗 https://sepolia.voyager.online/tx/0x6edab596e7826fac35582d3f40d2bc8cb7a97f23f6f3c376c7d841abdb71412

=== STEP 3: Relayer checks completion and provides secret to resolver ===
{
  secret: '0x1f7330b0bc01ad901404ccd65a6528f1496f90a260a943401cec8622e7012c',
  srcEscrowAddress: '0xb4d8b16b1d01252382de163395a7e86ccc349fac',
  dstEscrowAddress: '0x216b4abd9a7ea1b56eefca6061385697e75b248389f8a0ac2990f73c8de56e2'
}

=== STEP 4: Resolver withdraws from src and dst escrows using secret ===
⏰ Waiting 11 seconds...
✅ OP src withdraw completed:
🔗 https://optimistic.etherscan.io/tx/0xc83b64e1c9117324d73601f1b08d0373f6a8cf1200cd6f7383f6463b62b1f7aa
✅ Starknet withdraw completed:
🔗 https://sepolia.voyager.online/tx/0x56340079e18b18beb146513915688941ee57cc26574ff45ab1478ebd50c9191

=== STEP 5: Complete all steps and finish order ===
{
  orderHash: '0x1184508c5dafb1ab2c0c6d4a3b3dc8743faaeb4a031cdc0d9d017f3fdd21b4a4',
  status: 'SUCCESS'
}
🎉 Swap order created successfully!
Order hash: 0x1184508c5dafb1ab2c0c6d4a3b3dc8743faaeb4a031cdc0d9d017f3fdd21b4a4
Secret: 0x1f7330b0bc01ad901404ccd65a6528f1496f90a260a943401cec8622e7012c
yycz@yyczdeMacBook-Pro cross-chain-resolver-example % 
                                                                                                                                                         
yycz@yyczdeMacBook-Pro cross-chain-resolver-example % 
yycz@yyczdeMacBook-Pro cross-chain-resolver-example % 
yycz@yyczdeMacBook-Pro cross-chain-resolver-example %  pnpm run SNTOEVM 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 0.01 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25

> cross-chain-resolver-example@1.0.0 SNTOEVM /Users/yycz/ethglobal/1inch/cross-chain-resolver-example
> tsx scripts/swap-starknet-to-op.ts 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 0.01 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25

📋 Swap parameters:
  Source Token (Starknet): 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
  Source Amount: 0.01
  Destination Token (OP): 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B
  Destination Amount: 8
  OP User: 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25

🚀 Starting Starknet to OP cross-chain token swap
Source token: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d -> Destination token: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B
Swap amount: 0.01 -> 8
Actual amounts: 0.01 -> 8 (18 decimals)
Safety deposit: 110000000000000
🔓 Checking and approving Starknet token...
✅ Starknet token approval successful

=== STEP 1: User submits order ===
{
  srcToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  dstToken: '0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B',
  makingAmount: 0.01,
  takingAmount: 8
}
📝 Starknet order created
📝 Order hash: 0x15f44cd02df99092feafa016c6589fe963b3ea01189a0aa8e09a12adb0865d8

=== STEP 2: Resolver receives order and deploys src & dst escrows ===
📤 Deploying src escrow on Starknet...
Starknet src escrow deployed:
🔗 https://sepolia.voyager.online/tx/0x2ce51316fb5330f8f9ce4b77fe5c8df8f5995a3d4b2b7f57cd43b6c2877e9ff
[Starknet] Order 0x15f44cd02df99092feafa016c6589fe963b3ea01189a0aa8e09a12adb0865d8 src escrow deployed at 0x748b318710905c553cbeb427b97a14bf56a49651b5d4201ee21fb749a10f16c
taker 0x09253DbFBd2B9e98F342AEBA88884cC1a84aaBe4
[OP] Created dst deposit in tx:
🔗 https://optimistic.etherscan.io/tx/0x2b05ef6c0c7ebecf252cf3d7ad06868cdd393ac5a9ac1bc09d8f22a321797285
DST Escrow Address: 0x59f8c0ba0ff6c723054dabcbea84e2d2d9d162dc

=== STEP 3: Relayer checks completion and provides secret to resolver ===
{
  secret: '0x04063aec91e52e33e19b4abdb4cd323d77e2ffa1ac7e11d2b4f9355136fbdb',
  srcEscrowAddress: '0x748b318710905c553cbeb427b97a14bf56a49651b5d4201ee21fb749a10f16c',
  dstEscrowAddress: '0x59f8c0ba0ff6c723054dabcbea84e2d2d9d162dc'
}

=== STEP 4: Resolver withdraws from src and dst escrows using secret ===
⏰ Waiting 11 seconds...
💰 Withdrawing funds from OP dst escrow: 0x59f8c0ba0ff6c723054dabcbea84e2d2d9d162dc
✅ OP dst withdraw completed:
🔗 https://optimistic.etherscan.io/tx/0x5398261a3d53a56d90f1ce6ee4f34eafd4670b33cbbf958b9b05c2a4c2f13e2e
💰 Withdrawing funds from Starknet src escrow: 0x748b318710905c553cbeb427b97a14bf56a49651b5d4201ee21fb749a10f16c
✅ Starknet src withdraw completed:

=== STEP 5: Complete all steps and finish order ===
{
  orderHash: '0x15f44cd02df99092feafa016c6589fe963b3ea01189a0aa8e09a12adb0865d8',
  status: 'SUCCESS'
}
🎉 Swap order created successfully!
Order hash: 0x15f44cd02df99092feafa016c6589fe963b3ea01189a0aa8e09a12adb0865d8
Secret: 0x04063aec91e52e33e19b4abdb4cd323d77e2ffa1ac7e11d2b4f9355136fbdb
```

## Development

### Testing

Run the test suite:
```bash
forge test
```