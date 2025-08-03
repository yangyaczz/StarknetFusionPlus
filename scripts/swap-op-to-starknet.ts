import * as Sdk from '@1inch/cross-chain-sdk'
import {
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    ethers,
} from 'ethers'
import { uint8ArrayToHex, UINT_40_MAX } from '@1inch/byte-utils'
import { Wallet } from './wallet'
import { RpcProvider, Account, cairo, CallData, hash, getChecksumAddress } from 'starknet'
import { EscrowFactory } from './escrow-factory'
import { ResolverEVM } from './resolverevm'
import dotenv from 'dotenv'

dotenv.config({})

// Unified configuration
const CONFIG = {
    op: {
        chainId: 10,
        url: 'https://optimism-mainnet.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6',
        limitOrderProtocol: '0x111111125421cA6dc452d289314280a0f8842A65',
        wrappedNative: '0x4200000000000000000000000000000000000006',
    },
    starknet: {
        chainId: 99999,
        url: 'https://starknet-sepolia.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6/rpc/v0_8',
        specVersion: '0.8.1',
    },
    contracts: {
        escrowFactory: '0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A',
        resolver: '0x55e723eE06b4bF69734EDe8e4d0CC443D85BDF93',
        starknetResolver: '0x048A6a340B41Ba1Be6e17F23881E924746aB7E84c05ff915F4eAe86890b78da1',
    },
    privateKeys: {
        user: process.env.PRIVATE_KEY_EVM_USER!,
        resolver: process.env.PRIVATE_KEY_EVM_RESOLVER!,
        starknetResolver: process.env.PRIVATE_KEY_STARKNET_RESOLVER!,
    },
    constants: {
        DST_NOT_EVM_FLAG: 1n << 253n,
        WAIT_TIME: 11000, // 11 seconds
        DECIMALS: 18,
        TARGET_EVENT_KEY: '0x252bcf5a90092533454ac4a06890ff6047c24aea8870f526e24da47fdfc3131',
    }
} as const

// Timelock configuration
const TIME_LOCKS = {
    srcWithdrawal: 10n,
    srcPublicWithdrawal: 120n,
    srcCancellation: 121n,
    srcPublicCancellation: 122n,
    dstWithdrawal: 10n,
    dstPublicWithdrawal: 100n,
    dstCancellation: 101n,
} as const

const { Address } = Sdk

interface SwapParams {
    srcToken: string
    dstToken: string
    makingAmount: number
    takingAmount: number
    starknetUser: string
    starknetResolverContract: string
}

interface SwapAmounts {
    making: bigint
    taking: bigint
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

export class OpToStarknetSwap {
    private readonly providers: {
        op: JsonRpcProvider
        starknet: RpcProvider
    }
    
    private readonly wallets: {
        user: Wallet
        resolver: Wallet
        starknetResolver: Account
    }
    
    private readonly contracts = CONFIG.contracts

    constructor() {
        // Initialize providers
        this.providers = {
            op: new JsonRpcProvider(CONFIG.op.url, CONFIG.op.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            }),
            starknet: new RpcProvider({ 
                nodeUrl: CONFIG.starknet.url, 
                specVersion: CONFIG.starknet.specVersion 
            })
        }

        // Initialize wallets
        this.wallets = {
            user: new Wallet(CONFIG.privateKeys.user, this.providers.op),
            resolver: new Wallet(CONFIG.privateKeys.resolver, this.providers.op),
            starknetResolver: new Account(
                this.providers.starknet, 
                CONFIG.contracts.starknetResolver, 
                CONFIG.privateKeys.starknetResolver
            )
        }
    }

    async swapTokens(params: SwapParams) {
        console.log('🚀 Starting OP to Starknet cross-chain token swap')
        console.log(`Source token: ${params.srcToken} -> Destination token: ${params.dstToken}`)
        console.log(`Swap amount: ${params.makingAmount} -> ${params.takingAmount}`)

        // Parse amounts and validate
        const amounts = this.parseAmounts(params.makingAmount, params.takingAmount)
        await this.checkAndApproveTokens(params.srcToken, amounts.making)

        // Step 1: User submits order
        logStep(1, "User submits order", {
            srcToken: params.srcToken,
            dstToken: params.dstToken,
            makingAmount: params.makingAmount,
            takingAmount: params.takingAmount
        })

        // Create and sign order
        const { secret, order, signature, orderHash } = await this.createAndSignOrder(params, amounts)

        // Step 2: Resolver receives order and deploys src & dst escrows
        logStep(2, "Resolver receives order and deploys src & dst escrows")

        // Execute cross-chain swap
        const { srcEscrowAddress, srcEscrowEvent, dstEscrowAddress, immutables } = await this.executeSwap(
            order, signature, orderHash, secret, params, amounts
        )

        // Step 3: Relayer checks completion and provides secret to resolver
        logStep(3, "Relayer checks completion and provides secret to resolver", {
            secret: secret,
            srcEscrowAddress: srcEscrowAddress.toString(),
            dstEscrowAddress: dstEscrowAddress
        })

        // Step 4: Resolver withdraws from src and dst escrows using secret
        logStep(4, "Resolver withdraws from src and dst escrows using secret")

        // Execute withdrawals
        await this.executeWithdrawals(srcEscrowAddress, srcEscrowEvent, dstEscrowAddress, secret, immutables, params.starknetResolverContract)

        // Step 5: Complete all steps and finish order
        logStep(5, "Complete all steps and finish order", {
            orderHash: orderHash,
            status: "SUCCESS"
        })

        return { orderHash, secret, order }
    }

    private parseAmounts(makingAmount: number, takingAmount: number): SwapAmounts {
        const amounts = {
            making: parseUnits(makingAmount.toString(), CONFIG.constants.DECIMALS),
            taking: parseUnits(takingAmount.toString(), CONFIG.constants.DECIMALS)
        }
        
        console.log(`Actual amounts: ${amounts.making} -> ${amounts.taking} (${CONFIG.constants.DECIMALS} decimals)`)
        return amounts
    }

    private async createAndSignOrder(params: SwapParams, amounts: SwapAmounts) {
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = await this.createCrossChainOrder(params, amounts, secret)
        const signature = await this.wallets.user.signOrder(CONFIG.op.chainId, order)
        const orderHash = order.getOrderHash(CONFIG.op.chainId)
        
        console.log('📝 Order signed:', signature)
        console.log('📝 Order hash:', orderHash)
        
        return { secret, order, signature, orderHash }
    }

    private async executeSwap(order: any, signature: string, orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts) {
        console.log('📤 Submitting order to resolver...')
        
        // Deploy escrow on source chain
        const srcDeployment = await this.deploySrcEscrow(order, signature)
        const opTxLink = getExplorerLink(CONFIG.op.chainId, srcDeployment.txHash)
        console.log(`[${CONFIG.op.chainId}] Order ${orderHash} filled for ${order.makingAmount} in tx:`)
        console.log(`🔗 ${opTxLink}`)

        // Get source chain escrow info
        const srcEscrowData = await this.getSrcEscrowData(srcDeployment.blockHash)
        
        // Deploy escrow on destination chain
        const { dstEscrowAddress, immutables } = await this.deployDstEscrow(
            orderHash, secret, params, amounts, srcEscrowData.cancellation
        )

        return {
            srcEscrowAddress: srcEscrowData.address,
            srcEscrowEvent: srcEscrowData.event,
            dstEscrowAddress,
            immutables
        }
    }

    private async deploySrcEscrow(order: any, signature: string) {
        const resolverSrc = new ResolverEVM(this.contracts.resolver, this.contracts.resolver)
        const takerTraits = Sdk.TakerTraits.default()
            .setExtension(order.extension)
            .setAmountMode(Sdk.AmountMode.maker)
            .setAmountThreshold(order.takingAmount)

        return await this.wallets.resolver.send(
            resolverSrc.deploySrc(CONFIG.op.chainId, order, signature, takerTraits, order.makingAmount)
        )
    }

    private async getSrcEscrowData(blockHash: string) {
        const opFactory = new EscrowFactory(this.providers.op, this.contracts.escrowFactory)
        const srcEscrowEvent = await opFactory.getSrcDeployEvent(blockHash)
        const dstImmutables = srcEscrowEvent[0]
        const cancellation = dstImmutables.timeLocks.toSrcTimeLocks().privateCancellation

        const escrowSrcImplementation = await opFactory.getSourceImpl()
        const address = new Sdk.EscrowFactory(new Address(this.contracts.escrowFactory))
            .getSrcEscrowAddress(srcEscrowEvent[0], escrowSrcImplementation)

        return { address, cancellation, event: srcEscrowEvent[0] }
    }

    private async deployDstEscrow(orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts, srcCancellation: any) {
        const immutables = this.createDstImmutables(orderHash, secret, params, amounts)
        
        const txResult = await this.wallets.starknetResolver.execute([
            {
                contractAddress: params.dstToken,
                entrypoint: 'transfer',
                calldata: [params.starknetResolverContract, cairo.uint256(amounts.taking.toString())]
            },
            {
                contractAddress: params.starknetResolverContract,
                entrypoint: 'deploy_dst',
                calldata: CallData.compile({
                    immutables,
                    src_cancellation_timestamp: srcCancellation
                })
            }
        ])

        const starknetTxLink = getExplorerLink(CONFIG.starknet.chainId, txResult.transaction_hash)
        console.log('Starknet dst created:')
        console.log(`🔗 ${starknetTxLink}`)
        
        const dstEscrowAddress = await this.extractDstEscrowAddress(txResult.transaction_hash)
        
        return { dstEscrowAddress, immutables }
    }

    private createDstImmutables(orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts) {
        return {
            order_hash: BigInt(orderHash) % (2n ** 251n - 1n),
            hash_lock: hash.computePoseidonHashOnElements([secret]),
            maker: params.starknetUser,
            taker: params.starknetResolverContract,
            token: params.dstToken,
            amount: cairo.uint256(amounts.taking),
            safety_deposit: cairo.uint256('0'),
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

    private async extractDstEscrowAddress(txHash: string): Promise<string> {
        const txReceipt = await this.providers.starknet.waitForTransaction(txHash)
        
        if (!txReceipt.isSuccess()) {
            throw new Error('Starknet transaction failed')
        }

        const targetEvent = txReceipt.value.events.find(event =>
            event.keys?.includes(CONFIG.constants.TARGET_EVENT_KEY)
        )

        if (!targetEvent) {
            throw new Error('Target event not found in transaction')
        }

        return targetEvent.data[0]
    }

    private async executeWithdrawals(srcEscrowAddress: any, srcEscrowEvent: any, dstEscrowAddress: string, secret: string, immutables: any, starknetResolverContract: string) {
        // Wait for timelock
        console.log(`⏰ Waiting ${CONFIG.constants.WAIT_TIME / 1000} seconds...`)
        await new Promise(resolve => setTimeout(resolve, CONFIG.constants.WAIT_TIME))

        // Source chain withdrawal
        const resolverSrc = new ResolverEVM(this.contracts.resolver, this.contracts.resolver)
        
        const srcWithdrawTx = await this.wallets.resolver.send(
            resolverSrc.withdraw('src', srcEscrowAddress, secret + '00', srcEscrowEvent)
        )

        const opWithdrawLink = getExplorerLink(CONFIG.op.chainId, srcWithdrawTx.txHash)
        console.log('✅ OP src withdraw completed:')
        console.log(`🔗 ${opWithdrawLink}`)

        // Destination chain withdrawal
        const starknetWithdrawResult = await this.wallets.starknetResolver.execute([{
            contractAddress: starknetResolverContract,
            entrypoint: 'withdraw_dst',
            calldata: CallData.compile({ escrow: dstEscrowAddress, secret, immutables })
        }])

        await this.providers.starknet.waitForTransaction(starknetWithdrawResult.transaction_hash)
        const starknetWithdrawLink = getExplorerLink(CONFIG.starknet.chainId, starknetWithdrawResult.transaction_hash)
        console.log('✅ Starknet withdraw completed:')
        console.log(`🔗 ${starknetWithdrawLink}`)
    }

    private async createCrossChainOrder(params: SwapParams, amounts: SwapAmounts, secret: string) {
        const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
        const userAddress = await this.wallets.user.getAddress()

        const order = Sdk.CrossChainOrder.new(
            new Address(this.contracts.escrowFactory),
            {
                salt: Sdk.randBigInt(1000n),
                maker: new Address(userAddress),
                makingAmount: amounts.making,
                takingAmount: amounts.taking,
                makerAsset: new Address(params.srcToken),
                takerAsset: new Address('0x0000000000000000000000000000000000000000')
            },
            {
                hashLock: Sdk.HashLock.forSingleFill(secret + '00'),
                timeLocks: Sdk.TimeLocks.new(TIME_LOCKS),
                srcChainId: CONFIG.op.chainId,
                dstChainId: 1,
                srcSafetyDeposit: parseEther('0'),
                dstSafetyDeposit: parseEther('0')
            },
            {
                auction: new Sdk.AuctionDetails({
                    initialRateBump: 0,
                    points: [],
                    duration: 3600n,
                    startTime: currentTimestamp
                }),
                whitelist: [{
                    address: new Address(this.contracts.resolver),
                    allowFrom: 0n
                }],
                resolvingStartTime: 0n
            },
            {
                nonce: Sdk.randBigInt(UINT_40_MAX),
                allowPartialFills: false,
                allowMultipleFills: false
            }
        ) as any

        // Configure for Starknet
        this.configureOrderForStarknet(order, secret, params)

        console.log('📋 Created cross-chain order:', {
            orderHash: order.getOrderHash(CONFIG.op.chainId),
            makingAmount: amounts.making.toString(),
            takingAmount: amounts.taking.toString(),
            srcToken: params.srcToken,
            dstToken: params.dstToken
        })

        return order
    }

    private configureOrderForStarknet(order: any, secret: string, params: SwapParams) {
        // Set non-EVM chain flag
        const originalMakerTraits = order.inner.inner.makerTraits.value.value
        order.inner.inner.makerTraits.value.value = originalMakerTraits | CONFIG.constants.DST_NOT_EVM_FLAG

        // Set Starknet chain ID
        order.inner.escrowExtension.dstChainId = CONFIG.starknet.chainId

        // Set custom data
        const starknetHashlock = '0x' + hash.computePoseidonHashOnElements([secret]).slice(2).padStart(64, '0')
        const customData = this.encodeCustomData(
            getChecksumAddress(params.starknetUser),
            getChecksumAddress(params.dstToken),
            starknetHashlock
        )
        order.inner.inner.extension.customData = customData

        // Recalculate salt
        const extensionBytes = order.extension.encode()
        const extensionHash = ethers.keccak256(extensionBytes)
        order.inner.inner._salt = BigInt(extensionHash) & ((1n << 160n) - 1n)
    }

    private encodeCustomData(receiver: string, asset: string, hashLock: string): string {
        return '0x' + [receiver, asset, hashLock]
            .map(addr => addr.replace(/^0x/, ''))
            .join('')
    }

    private async checkAndApproveTokens(tokenAddress: string, amount: bigint) {
        const tokenContract = new ethers.Contract(
            tokenAddress,
            [
                'function balanceOf(address) view returns (uint256)',
                'function approve(address,uint256) returns (bool)',
                'function allowance(address,address) view returns (uint256)'
            ],
            this.wallets.user
        )

        const userAddress = await this.wallets.user.getAddress()
        const balance = await tokenContract.balanceOf(userAddress)
        
        console.log(`💰 Current token balance: ${balance} (needed: ${amount})`)
        
        if (balance < amount) {
            throw new Error(`Insufficient token balance! Current: ${balance}, needed: ${amount}`)
        }

        const allowance = await tokenContract.allowance(userAddress, CONFIG.op.limitOrderProtocol)
        
        if (allowance < amount) {
            console.log('🔓 Approving token for 1inch limit order protocol...')
            const approveTx = await tokenContract.approve(CONFIG.op.limitOrderProtocol, MaxUint256)
            await approveTx.wait()
            console.log('✅ Token approval successful')
        }
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
            console.log('pnpm run swap <srcToken> <makingAmount> <dstToken> <takingAmount> <starknetUser>')
            console.log('')
            console.log('Parameter description:')
            console.log('  srcToken     - Source chain token address (e.g.: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B)')
            console.log('  makingAmount - Source token amount (e.g.: 100)')
            console.log('  dstToken     - Destination chain token address (e.g.: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d)')
            console.log('  takingAmount - Destination token amount (e.g.: 1)')
            console.log('  starknetUser - Starknet user address (e.g.: 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae)')
            console.log('')
            console.log('Example:')
            console.log('pnpm run swap 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 100 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae')
            process.exit(1)
        }

        const [srcToken, makingAmountStr, dstToken, takingAmountStr, starknetUser] = args

        // Validate parameters
        const validation = validateParameters(srcToken, makingAmountStr, dstToken, takingAmountStr, starknetUser)
        if (!validation.isValid) {
            console.error('❌ Parameter validation failed:', validation.error)
            process.exit(1)
        }

        const makingAmount = parseFloat(makingAmountStr)
        const takingAmount = parseFloat(takingAmountStr)

        console.log('📋 Swap parameters:')
        console.log(`  Source Token: ${srcToken}`)
        console.log(`  Source Amount: ${makingAmount}`)
        console.log(`  Destination Token: ${dstToken}`)
        console.log(`  Destination Amount: ${takingAmount}`)
        console.log(`  Starknet User: ${starknetUser}`)
        console.log('')

        const swapper = new OpToStarknetSwap()

        const swapParams: SwapParams = {
            srcToken,
            dstToken,
            makingAmount,
            takingAmount,
            starknetUser,
            starknetResolverContract: '0x56694ab2329b53a675c6308f145872f675f0f4364c9d1440ca53718bb5cb810' // Fixed resolver address
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
function validateParameters(srcToken: string, makingAmountStr: string, dstToken: string, takingAmountStr: string, starknetUser: string) {
    // Validate address format
    if (!isValidEthereumAddress(srcToken)) {
        return { isValid: false, error: `Invalid source token address: ${srcToken}` }
    }

    if (!isValidStarknetAddress(dstToken)) {
        return { isValid: false, error: `Invalid destination token address: ${dstToken}` }
    }

    if (!isValidStarknetAddress(starknetUser)) {
        return { isValid: false, error: `Invalid Starknet user address: ${starknetUser}` }
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

export default OpToStarknetSwap


// pnpm run EVMTOSN 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae