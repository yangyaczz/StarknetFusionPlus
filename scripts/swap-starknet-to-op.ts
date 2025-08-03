import * as Sdk from '@1inch/cross-chain-sdk'
import {
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    ethers,
    Interface
} from 'ethers'
import { uint8ArrayToHex, UINT_40_MAX } from '@1inch/byte-utils'
import { Wallet } from './wallet'
import { RpcProvider, Account, cairo, CallData, hash, getChecksumAddress, Contract } from 'starknet'
import { EscrowFactory } from './escrow-factory'
import { ResolverEVM } from './resolverevm'
import resolverABI from '../starknetABI/ResolverABI.json' with { type: "json" }
import dotenv from 'dotenv'
import { compileBundleOptions } from '@swc/core/spack'

dotenv.config({})

// Unified configuration
const CONFIG = {
    starknet: {
        chainId: 99999,
        url: 'https://starknet-sepolia.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6/rpc/v0_8',
        specVersion: '0.8.1',
        limitOrderProtocol: '0x4beec109b7712b2f5576c63af17da0966756438d2a6bbaf894f48b8d17a72f',
    },
    op: {
        chainId: 10,
        url: 'https://optimism-mainnet.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6',
        limitOrderProtocol: '0x111111125421cA6dc452d289314280a0f8842A65',
        wrappedNative: '0x4200000000000000000000000000000000000006',
    },
    contracts: {
        escrowFactory: '0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A',
        resolver: '0x55e723eE06b4bF69734EDe8e4d0CC443D85BDF93',
        starknetResolverContract: '0x16d599d9fc0476dfe847c454f57349a563703be12852cda3ddf5183400fc334',
    },
    privateKeys: {
        user: process.env.PRIVATE_KEY_STARKNET_USER!,
        resolver: process.env.PRIVATE_KEY_EVM_RESOLVER!,
        starknetResolver: process.env.PRIVATE_KEY_STARKNET_RESOLVER!,
    },
    constants: {
        DST_NOT_EVM_FLAG: 1n << 253n,
        WAIT_TIME: 11000, // 11 seconds
        DECIMALS: 18,
        SRC_DEPLOY_EVENT_KEY: '0xf323845026b2be2da82fc16476961f810f279069ce9e128eabc1023a87ade0',
        SAFETY_DEPOSIT: '110000000000000', // Add safety_deposit config  0.0006600
    }
} as const

// Timelock configuration
const TIME_LOCKS = {
    srcWithdrawal: 5n,
    srcPublicWithdrawal: 440n,
    srcCancellation: 642n,
    srcPublicCancellation: 644n,
    dstWithdrawal: 5n,
    dstPublicWithdrawal: 400n,
    dstCancellation: 402n,
} as const

const { Address } = Sdk

interface SwapParams {
    srcToken: string
    dstToken: string
    makingAmount: number
    takingAmount: number
    opUser: string
}

interface SwapAmounts {
    making: any // cairo.uint256
    taking: any // cairo.uint256 - Fixed to cairo.uint256
    safetyDeposit: any // cairo.uint256 - Add safety_deposit
}

// Helper function to generate blockchain explorer links
function getExplorerLink(chainId: number, txHash: string): string {
    if (chainId === 10) {
        return `https://optimistic.etherscan.io/tx/${txHash}`
    } else if (chainId === 99999) {
        return `https://sepolia.voyager.online/tx/${txHash}`
    }
    return `Transaction: ${txHash}`
}

// Step logging function
function logStep(stepNumber: number, description: string, details?: any) {
    console.log(`\n=== STEP ${stepNumber}: ${description} ===`)
    if (details) {
        console.log(details)
    }
}

export class StarknetToOpSwap {
    private readonly providers: {
        starknet: RpcProvider
        op: JsonRpcProvider
    }

    private readonly wallets: {
        starknetUser: Account
        resolver: Wallet
        starknetResolver: Account
    }

    private readonly contracts = CONFIG.contracts

    private lastStarknetImmutables: any; // Store last created Starknet immutables

    constructor() {
        // Initialize providers
        this.providers = {
            starknet: new RpcProvider({
                nodeUrl: CONFIG.starknet.url,
                specVersion: CONFIG.starknet.specVersion
            }),
            op: new JsonRpcProvider(CONFIG.op.url, CONFIG.op.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            })
        }

        // Initialize wallets
        this.wallets = {
            starknetUser: new Account(
                this.providers.starknet,
                process.env.STARKNET_USER_ADDRESS!,
                CONFIG.privateKeys.user
            ),
            resolver: new Wallet(CONFIG.privateKeys.resolver, this.providers.op),
            starknetResolver: new Account(
                this.providers.starknet,
                process.env.STARKNET_RESOLVER_ADDRESS!, // Use account address, not contract address
                CONFIG.privateKeys.starknetResolver
            )
        }


    }

    async swapTokens(params: SwapParams) {

        console.log('🚀 Starting Starknet to OP cross-chain token swap')
        console.log(`Source token: ${params.srcToken} -> Destination token: ${params.dstToken}`)
        console.log(`Swap amount: ${params.makingAmount} -> ${params.takingAmount}`)

        // Parse amounts and validate
        const amounts = this.parseAmounts(params.makingAmount, params.takingAmount)
        await this.checkAndApproveStarknetTokens(params.srcToken, amounts.making)

        // Step 1: User submits order
        logStep(1, "User submits order", {
            srcToken: params.srcToken,
            dstToken: params.dstToken,
            makingAmount: params.makingAmount,
            takingAmount: params.takingAmount
        })

        // Create and sign order
        const { secret, order, signature, orderHash } = await this.createAndSignStarknetOrder(params, amounts)

        // Wait 5s
        await new Promise(resolve => setTimeout(resolve, 5000))

        // Step 2: Resolver receives order and deploys src & dst escrows
        logStep(2, "Resolver receives order and deploys src & dst escrows")

        // Execute cross-chain swap
        const { srcEscrowAddress, srcCancellation, dstEscrowAddress, dstImmutables } = await this.executeSwap(
            order, signature, orderHash, secret, params, amounts
        )

        // Step 3: Relayer checks completion and provides secret to resolver
        logStep(3, "Relayer checks completion and provides secret to resolver", {
            secret: secret,
            srcEscrowAddress: srcEscrowAddress,
            dstEscrowAddress: dstEscrowAddress
        })

        // Step 4: Resolver withdraws from src and dst escrows using secret
        logStep(4, "Resolver withdraws from src and dst escrows using secret")

        // Execute withdrawals
        await this.executeWithdrawals(srcEscrowAddress, srcCancellation, dstEscrowAddress, secret, dstImmutables, params)

        // Step 5: Complete all steps and finish order
        logStep(5, "Complete all steps and finish order", {
            orderHash: orderHash,
            status: "SUCCESS"
        })

        return { orderHash, secret, order }
    }

    private parseAmounts(makingAmount: number, takingAmount: number): SwapAmounts {
        const amounts = {
            making: cairo.uint256(parseUnits(makingAmount.toString(), CONFIG.constants.DECIMALS).toString()),
            taking: cairo.uint256(parseUnits(takingAmount.toString(), CONFIG.constants.DECIMALS).toString()), // Fixed to cairo.uint256
            safetyDeposit: cairo.uint256(CONFIG.constants.SAFETY_DEPOSIT) // Add safety_deposit
        }

        console.log(`Actual amounts: ${makingAmount} -> ${takingAmount} (${CONFIG.constants.DECIMALS} decimals)`)
        console.log(`Safety deposit: ${CONFIG.constants.SAFETY_DEPOSIT}`)
        return amounts
    }

    private async createAndSignStarknetOrder(params: SwapParams, amounts: SwapAmounts) {
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = this.createStarknetOrder(params, amounts)
        const signature = this.signStarknetOrder(order)
        const orderHash = hash.computeHashOnElements(this.getOrderArray(order))

        console.log('📝 Starknet order created')
        console.log('📝 Order hash:', orderHash)

        return { secret, order, signature, orderHash }
    }

    private createStarknetOrder(params: SwapParams, amounts: SwapAmounts) {
        return {
            salt: uint8ArrayToHex(randomBytes(8)),
            maker: this.wallets.starknetUser.address,
            receiver: params.opUser,
            maker_asset: params.srcToken,
            taker_asset: params.dstToken,
            making_amount: amounts.making,
            taking_amount: amounts.taking,
        }
    }

    private signStarknetOrder(order: any): string {
        const orderArray = this.getOrderArray(order)
        return hash.computeHashOnElements(orderArray)
    }

    private getOrderArray(order: any): string[] {
        return [
            order.salt,
            order.maker,
            order.receiver,
            order.maker_asset,
            order.taker_asset,
            ...Object.values(order.making_amount),
            ...Object.values(order.taking_amount)
        ]
    }

    private async executeSwap(order: any, signature: string, orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts) {
        console.log('📤 Deploying src escrow on Starknet...')

        // Deploy src escrow on Starknet
        const { srcEscrowAddress, srcCancellation } = await this.deployStarknetSrcEscrow(order, signature, secret, amounts)
        console.log(`[Starknet] Order ${orderHash} src escrow deployed at ${srcEscrowAddress}`)

        // Deploy dst escrow on OP
        const { dstEscrowAddress, dstImmutables } = await this.deployOpDstEscrow(
            orderHash, secret, params, amounts, srcCancellation
        )

        return {
            srcEscrowAddress,
            srcCancellation,
            dstEscrowAddress,
            dstImmutables
        }
    }

    private async deployStarknetSrcEscrow(order: any, signature: string, secret: string, amounts: SwapAmounts) {
        const immutables = this.createStarknetImmutables(order, secret, amounts)
        this.lastStarknetImmutables = immutables; // Store for later use

        const result = await this.wallets.starknetResolver.execute([
            {
                contractAddress: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
                entrypoint: 'transfer',
                calldata: [
                    CONFIG.contracts.starknetResolverContract,
                    amounts.safetyDeposit
                ]
            },
            {
                contractAddress: CONFIG.contracts.starknetResolverContract,
                entrypoint: 'deploy_src',
                calldata: CallData.compile({
                    immutables: immutables,
                    order: order,
                    signature: signature
                })
            }
        ])

        const txReceipt = await this.providers.starknet.waitForTransaction(result.transaction_hash)

        if (!txReceipt.isSuccess()) {
            throw new Error('Starknet src escrow deployment failed')
        }

        const starknetSrcTxLink = getExplorerLink(CONFIG.starknet.chainId, result.transaction_hash)
        console.log('Starknet src escrow deployed:')
        console.log(`🔗 ${starknetSrcTxLink}`)

        const targetEvent = txReceipt.value.events.find(event =>
            event.keys?.includes(CONFIG.constants.SRC_DEPLOY_EVENT_KEY)
        )

        if (!targetEvent) {
            throw new Error('Src deploy event not found')
        }

        return {
            srcEscrowAddress: targetEvent.data[0],
            srcCancellation: targetEvent.data[1]
        }
    }

    private createStarknetImmutables(order: any, secret: string, amounts: SwapAmounts) {
        return {
            order_hash: hash.computeHashOnElements(this.getOrderArray(order)),
            hash_lock: hash.computePoseidonHashOnElements([secret]),
            maker: order.maker,
            taker: CONFIG.contracts.starknetResolverContract,
            token: order.maker_asset,
            amount: amounts.making,
            safety_deposit: amounts.safetyDeposit, // Use configured safety_deposit
            timelocks: {
                deployed_at: 0,
                src_withdrawal: Number(TIME_LOCKS.srcWithdrawal),
                src_public_withdrawal: Number(TIME_LOCKS.srcPublicWithdrawal),
                src_cancellation: Number(TIME_LOCKS.srcCancellation),
                src_public_cancellation: Number(TIME_LOCKS.srcPublicCancellation),
                dst_withdrawal: Number(TIME_LOCKS.dstWithdrawal),
                dst_public_withdrawal: Number(TIME_LOCKS.dstPublicWithdrawal),
                dst_cancellation: Number(TIME_LOCKS.dstCancellation),
            }
        }
    }

    private async deployOpDstEscrow(orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts, srcCancellation: string) {
        // Create EVM-compatible dst immutables
        const dstImmutables = await this.createOpDstImmutables(orderHash, secret, params, amounts, BigInt(srcCancellation));

        const resolverContract = new ResolverEVM(this.contracts.resolver, this.contracts.resolver);

        // createDstEscrow  EscrowFactory
        let factory = new EscrowFactory(this.providers.op, this.contracts.escrowFactory);
        const { txHash: dstDepositHash, blockTimestamp: dstDeployedAt } = await this.wallets.resolver.send({
            to: this.contracts.escrowFactory,
            data: factory.iface.encodeFunctionData('createDstEscrow', [
                dstImmutables,
                BigInt(srcCancellation)
            ]),
            value: dstImmutables[6]
        });

        const opDstTxLink = getExplorerLink(CONFIG.op.chainId, dstDepositHash)
        console.log(`[OP] Created dst deposit in tx:`)
        console.log(`🔗 ${opDstTxLink}`)

        // Query all transaction events
        const txReceipt = await this.providers.op.getTransactionReceipt(dstDepositHash);

        if (!txReceipt) {
            throw new Error(`Transaction receipt not found for hash: ${dstDepositHash}`);
        }

        txReceipt.logs.forEach((log, index) => {
            // console.log(`Log ${index}:`, {
            //     address: log.address,
            //     topics: log.topics,
            //     data: log.data
            // });
        });

        // Find specific topic
        const targetTopic = '0xc30e111dcc74fddc2c3a4d98ffb97adec4485c0a687946bf5b22c2a99c7ff96d';
        const targetEvent = txReceipt.logs.find(log =>
            log.topics.includes(targetTopic)
        );

        if (!targetEvent) {
            console.error('❌ Target event not found');
            throw new Error(`Event with topic ${targetTopic} not found`);
        }

        // Decode data field to get dst escrow address
        const dstEscrowAddress = targetEvent.data;

        const parsedAddress = '0x' + dstEscrowAddress.slice(26, 66); // Extract address part
        console.log('DST Escrow Address:', parsedAddress);

        // Calculate dst escrow address
        // const opFactory = new EscrowFactory(this.providers.op, this.contracts.escrowFactory);
        // const ESCROW_DST_IMPLEMENTATION = await opFactory.getDestinationImpl();

        dstImmutables[7] = Sdk.TimeLocks.new(TIME_LOCKS).setDeployedAt(dstDeployedAt).build()

        return {
            dstEscrowAddress: parsedAddress,
            dstImmutables: dstImmutables
        };
    }

    private async createOpDstImmutables(orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts, srcCancellation: bigint) {
        // 1. Process orderHash - convert to suitable format
        const processedOrderHash = BigInt(orderHash) & ((1n << 256n) - 1n);

        // 2. Convert cairo.uint256 to bigint
        const amountBigInt = BigInt(amounts.taking.low) + (BigInt(amounts.taking.high) << 128n);
        const safetyDepositBigInt = BigInt(amounts.safetyDeposit.low) + (BigInt(amounts.safetyDeposit.high) << 128n);

        // 3. Create SDK-compatible components
        const hashLock = Sdk.HashLock.forSingleFill(secret + '00');
        const timeLocks = Sdk.TimeLocks.new(TIME_LOCKS).toDstTimeLocks(srcCancellation - TIME_LOCKS.srcCancellation);

        let taker = await this.wallets.resolver.getAddress()
        console.log('taker', taker)


        return [
            '0x' + processedOrderHash.toString(16).padStart(64, '0'),           // bytes32 orderHash
            hashLock.toString(),            // bytes32 hashlock
            params.opUser,               // address maker
            taker,                        // address taker  
            params.dstToken,             // address token
            amountBigInt,                // uint256 amount
            safetyDepositBigInt,         // uint256 safetyDeposit (0)
            Sdk.TimeLocks.new(TIME_LOCKS).build()            // uint256 timelocks (encoded value)
        ];
    }

    // Helper function: convert cairo.uint256 to bigint
    private cairoUint256ToBigInt(cairoUint256: any): bigint {
        return BigInt(cairoUint256.low) + (BigInt(cairoUint256.high) << 128n);
    }

    // Update executeWithdrawals method to properly pass immutables
    private async executeWithdrawals(srcEscrowAddress: string, srcCancellation: string, dstEscrowAddress: string, secret: string, dstImmutables: any, params: SwapParams) {
        // Wait for timelock
        console.log(`⏰ Waiting ${CONFIG.constants.WAIT_TIME / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.constants.WAIT_TIME));

        // Destination chain withdrawal (OP) - use correct format
        console.log(`💰 Withdrawing funds from OP dst escrow: ${dstEscrowAddress}`);

        let interfaceEscrowDst = new Interface([{ "inputs": [{ "internalType": "uint32", "name": "rescueDelay", "type": "uint32" }, { "internalType": "contract IERC20", "name": "accessToken", "type": "address" }], "stateMutability": "nonpayable", "type": "constructor" }, { "inputs": [], "name": "InvalidCaller", "type": "error" }, { "inputs": [], "name": "InvalidImmutables", "type": "error" }, { "inputs": [], "name": "InvalidSecret", "type": "error" }, { "inputs": [], "name": "InvalidTime", "type": "error" }, { "inputs": [], "name": "NativeTokenSendingFailure", "type": "error" }, { "inputs": [], "name": "SafeTransferFailed", "type": "error" }, { "anonymous": false, "inputs": [], "name": "EscrowCancelled", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "bytes32", "name": "secret", "type": "bytes32" }], "name": "EscrowWithdrawal", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "address", "name": "token", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" }], "name": "FundsRescued", "type": "event" }, { "inputs": [], "name": "FACTORY", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "PROXY_BYTECODE_HASH", "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "RESCUE_DELAY", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "cancel", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "secret", "type": "bytes32" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "publicWithdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "rescueFunds", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "secret", "type": "bytes32" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }])

        const { txHash: dstWithdrawHash } = await this.wallets.resolver.send({
            to: dstEscrowAddress,
            data: interfaceEscrowDst.encodeFunctionData('withdraw', [
                secret + '00',
                dstImmutables,
            ])
        });

        const opWithdrawTxLink = getExplorerLink(CONFIG.op.chainId, dstWithdrawHash)
        console.log('✅ OP dst withdraw completed:')
        console.log(`🔗 ${opWithdrawTxLink}`)

        // Source chain withdrawal (Starknet) - need to rebuild immutables
        console.log(`💰 Withdrawing funds from Starknet src escrow: ${srcEscrowAddress}`);

        // Store original order and amount info as class properties to avoid recreation
        const starknetImmutables = this.lastStarknetImmutables; // Need to store this in the class

        const withdrawSrcResult = await this.wallets.starknetResolver.execute([{
            contractAddress: CONFIG.contracts.starknetResolverContract,
            entrypoint: 'withdraw_src',
            calldata: CallData.compile({
                escrow: srcEscrowAddress,
                secret: secret,
                immutables: starknetImmutables
            })
        }]);

        await this.providers.starknet.waitForTransaction(withdrawSrcResult.transaction_hash);
        const starknetWithdrawTxLink = getExplorerLink(CONFIG.starknet.chainId, withdrawSrcResult.transaction_hash)
        console.log('✅ Starknet src withdraw completed:')
        console.log(`🔗 ${starknetWithdrawTxLink}`)
    }

    private async checkAndApproveStarknetTokens(tokenAddress: string, amount: any) {
        console.log('🔓 Checking and approving Starknet token...')

        // Need to approve making_amount for LOP
        const approveResult = await this.wallets.starknetUser.execute([{
            contractAddress: tokenAddress,
            entrypoint: 'approve',
            calldata: [
                CONFIG.starknet.limitOrderProtocol,
                amount // This is making_amount
            ]
        }])

        const txReceipt = await this.providers.starknet.waitForTransaction(approveResult.transaction_hash)

        if (!txReceipt.isSuccess()) {
            throw new Error('Starknet token approval failed')
        }

        console.log('✅ Starknet token approval successful')
    }
}

// Main function
async function main() {
    try {
        // Parse command line arguments
        const args = process.argv.slice(2)

        if (args.length < 5) {
            console.log('❌ Insufficient parameters')
            console.log('Usage:')
            console.log('pnpm run swap-starknet-to-op <srcToken> <makingAmount> <dstToken> <takingAmount> <opUser>')
            console.log('')
            console.log('Parameter description:')
            console.log('  srcToken     - Starknet source token address (e.g.: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d)')
            console.log('  makingAmount - Source token amount (e.g.: 100)')
            console.log('  dstToken     - OP destination token address (e.g.: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B)')
            console.log('  takingAmount - Destination token amount (e.g.: 1)')
            console.log('  opUser       - OP user address (e.g.: 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25)')
            console.log('')
            console.log('Example:')
            console.log('pnpm run swap-starknet-to-op 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 100 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 1 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25')
            process.exit(1)
        }

        const [srcToken, makingAmountStr, dstToken, takingAmountStr, opUser] = args

        // Validate parameters
        const validation = validateParameters(srcToken, makingAmountStr, dstToken, takingAmountStr, opUser)
        if (!validation.isValid) {
            console.error('❌ Parameter validation failed:', validation.error)
            process.exit(1)
        }

        const makingAmount = parseFloat(makingAmountStr)
        const takingAmount = parseFloat(takingAmountStr)

        console.log('📋 Swap parameters:')
        console.log(`  Source Token (Starknet): ${srcToken}`)
        console.log(`  Source Amount: ${makingAmount}`)
        console.log(`  Destination Token (OP): ${dstToken}`)
        console.log(`  Destination Amount: ${takingAmount}`)
        console.log(`  OP User: ${opUser}`)
        console.log('')

        const swapper = new StarknetToOpSwap()

        const swapParams: SwapParams = {
            srcToken,
            dstToken,
            makingAmount,
            takingAmount,
            opUser
        }

        const result = await swapper.swapTokens(swapParams)

        console.log('🎉 Swap order created successfully!')
        console.log('Order hash:', result.orderHash)
        console.log('Secret:', result.secret)

    } catch (error) {
        console.error('❌ Swap failed:', error)
        process.exit(1)
    }
}

// Parameter validation function
function validateParameters(srcToken: string, makingAmountStr: string, dstToken: string, takingAmountStr: string, opUser: string) {
    // Validate address format
    if (!isValidStarknetAddress(srcToken)) {
        return { isValid: false, error: `Invalid Starknet source token address: ${srcToken}` }
    }

    if (!isValidEthereumAddress(dstToken)) {
        return { isValid: false, error: `Invalid OP destination token address: ${dstToken}` }
    }

    if (!isValidEthereumAddress(opUser)) {
        return { isValid: false, error: `Invalid OP user address: ${opUser}` }
    }

    // Validate amounts
    const makingAmount = parseFloat(makingAmountStr)
    const takingAmount = parseFloat(takingAmountStr)

    if (isNaN(makingAmount) || makingAmount <= 0) {
        return { isValid: false, error: `Invalid source token amount: ${makingAmountStr}` }
    }

    if (isNaN(takingAmount) || takingAmount <= 0) {
        return { isValid: false, error: `Invalid destination token amount: ${takingAmountStr}` }
    }

    return { isValid: true }
}

// Address validation helper functions
function isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address)
}

function isValidStarknetAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{1,64}$/.test(address) && address.length <= 66
}

await main()

export default StarknetToOpSwap


// pnpm run SNTOEVM <starknetToken> <amount1> <opToken> <amount2> <opUserAddress>

// pnpm run SNTOEVM 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 0.01 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25