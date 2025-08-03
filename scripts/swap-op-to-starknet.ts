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

// 统一配置
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

// 时间锁配置
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
        // 初始化提供者
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

        // 初始化钱包
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
        console.log('🚀 开始跨链token交换')
        console.log(`源token: ${params.srcToken} -> 目标token: ${params.dstToken}`)
        console.log(`交换金额: ${params.makingAmount} -> ${params.takingAmount}`)

        // 转换金额并验证
        const amounts = this.parseAmounts(params.makingAmount, params.takingAmount)
        await this.checkAndApproveTokens(params.srcToken, amounts.making)

        // 创建和签名订单
        const { secret, order, signature, orderHash } = await this.createAndSignOrder(params, amounts)

        // 执行跨链交换
        const { srcEscrowAddress, srcEscrowEvent, dstEscrowAddress, immutables } = await this.executeSwap(
            order, signature, orderHash, secret, params, amounts
        )

        // 执行提取操作
        await this.executeWithdrawals(srcEscrowAddress, srcEscrowEvent, dstEscrowAddress, secret, immutables, params.starknetResolverContract)

        return { orderHash, secret, order }
    }

    private parseAmounts(makingAmount: number, takingAmount: number): SwapAmounts {
        const amounts = {
            making: parseUnits(makingAmount.toString(), CONFIG.constants.DECIMALS),
            taking: parseUnits(takingAmount.toString(), CONFIG.constants.DECIMALS)
        }
        
        console.log(`实际金额: ${amounts.making} -> ${amounts.taking} (${CONFIG.constants.DECIMALS} decimals)`)
        return amounts
    }

    private async createAndSignOrder(params: SwapParams, amounts: SwapAmounts) {
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = await this.createCrossChainOrder(params, amounts, secret)
        const signature = await this.wallets.user.signOrder(CONFIG.op.chainId, order)
        const orderHash = order.getOrderHash(CONFIG.op.chainId)
        
        console.log('📝 订单已签名:', signature)
        console.log('📝 订单哈希:', orderHash)
        
        return { secret, order, signature, orderHash }
    }

    private async executeSwap(order: any, signature: string, orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts) {
        console.log('📤 提交订单给解析器...')
        
        // 在源链部署 escrow
        const srcDeployment = await this.deploySrcEscrow(order, signature)
        console.log(`[${CONFIG.op.chainId}] Order ${orderHash} filled for ${order.makingAmount} in tx ${srcDeployment.txHash}`)

        // 获取源链 escrow 信息
        const srcEscrowData = await this.getSrcEscrowData(srcDeployment.blockHash)
        
        // 在目标链部署 escrow
        const { dstEscrowAddress, immutables } = await this.deployDstEscrow(
            orderHash, secret, params, amounts, srcEscrowData.cancellation
        )

        return {
            srcEscrowAddress: srcEscrowData.address,
            srcEscrowEvent: srcEscrowData.event, // 添加这个
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

        console.log('Starknet dst created:', txResult)
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

    private async executeWithdrawals(srcEscrowAddress: string, srcEscrowEvent: any, dstEscrowAddress: string, secret: string, immutables: any, starknetResolverContract: string) {
        // 等待时间锁
        console.log(`⏰ 等待 ${CONFIG.constants.WAIT_TIME / 1000} 秒...`)
        await new Promise(resolve => setTimeout(resolve, CONFIG.constants.WAIT_TIME))

        // 源链提取
        const resolverSrc = new ResolverEVM(this.contracts.resolver, this.contracts.resolver)
        
        await this.wallets.resolver.send(
            resolverSrc.withdraw('src', srcEscrowAddress, secret + '00', srcEscrowEvent)
        )

        // 目标链提取
        // const starknetWithdrawResult1 = await this.wallets.starknetResolver.execute([{
        //     contractAddress: dstEscrowAddress,
        //     entrypoint: 'withdraw',
        //     calldata: CallData.compile({ secret, immutables })
        // }])

        const starknetWithdrawResult = await this.wallets.starknetResolver.execute([{
            contractAddress: starknetResolverContract,
            entrypoint: 'withdraw_dst',
            calldata: CallData.compile({ escrow: dstEscrowAddress, secret, immutables })
        }])

        await this.providers.starknet.waitForTransaction(starknetWithdrawResult.transaction_hash)
        console.log('✅ Starknet withdraw completed:', starknetWithdrawResult)
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

        // 设置非EVM链标志和自定义数据
        this.configureOrderForStarknet(order, secret, params)

        console.log('📋 创建跨链订单:', {
            orderHash: order.getOrderHash(CONFIG.op.chainId),
            makingAmount: amounts.making.toString(),
            takingAmount: amounts.taking.toString(),
            srcToken: params.srcToken,
            dstToken: params.dstToken
        })

        return order
    }

    private configureOrderForStarknet(order: any, secret: string, params: SwapParams) {
        // 设置非EVM链标志
        const originalMakerTraits = order.inner.inner.makerTraits.value.value
        order.inner.inner.makerTraits.value.value = originalMakerTraits | CONFIG.constants.DST_NOT_EVM_FLAG

        // 设置Starknet链ID
        order.inner.escrowExtension.dstChainId = CONFIG.starknet.chainId

        // 设置自定义数据
        const starknetHashlock = '0x' + hash.computePoseidonHashOnElements([secret]).slice(2).padStart(64, '0')
        const customData = this.encodeCustomData(
            getChecksumAddress(params.starknetUser),
            getChecksumAddress(params.dstToken),
            starknetHashlock
        )
        order.inner.inner.extension.customData = customData

        // 重新计算salt
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
        
        console.log(`💰 当前token余额: ${balance} (需要: ${amount})`)
        
        if (balance < amount) {
            throw new Error(`Token余额不足! 当前: ${balance}, 需要: ${amount}`)
        }

        const allowance = await tokenContract.allowance(userAddress, CONFIG.op.limitOrderProtocol)
        
        if (allowance < amount) {
            console.log('🔓 授权token给1inch限价订单协议...')
            const approveTx = await tokenContract.approve(CONFIG.op.limitOrderProtocol, MaxUint256)
            await approveTx.wait()
            console.log('✅ Token授权成功')
        }
    }
}

// 主函数
async function main() {
    try {
        // 解析命令行参数
        const args = process.argv.slice(2)
        
        if (args.length < 5) {
            console.log('❌ 参数不足')
            console.log('使用方法:')
            console.log('pnpm run swap <srcToken> <makingAmount> <dstToken> <takingAmount> <starknetUser>')
            console.log('')
            console.log('参数说明:')
            console.log('  srcToken     - 源链token地址 (如: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B)')
            console.log('  makingAmount - 源token数量 (如: 100)')
            console.log('  dstToken     - 目标链token地址 (如: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d)')
            console.log('  takingAmount - 目标token数量 (如: 1)')
            console.log('  starknetUser - Starknet用户地址 (如: 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae)')
            console.log('')
            console.log('示例:')
            console.log('pnpm run swap 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 100 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae')
            process.exit(1)
        }

        const [srcToken, makingAmountStr, dstToken, takingAmountStr, starknetUser] = args

        // 验证参数
        const validation = validateParameters(srcToken, makingAmountStr, dstToken, takingAmountStr, starknetUser)
        if (!validation.isValid) {
            console.error('❌ 参数验证失败:', validation.error)
            process.exit(1)
        }

        const makingAmount = parseFloat(makingAmountStr)
        const takingAmount = parseFloat(takingAmountStr)

        console.log('📋 交换参数:')
        console.log(`  源Token: ${srcToken}`)
        console.log(`  源数量: ${makingAmount}`)
        console.log(`  目标Token: ${dstToken}`)
        console.log(`  目标数量: ${takingAmount}`)
        console.log(`  Starknet用户: ${starknetUser}`)
        console.log('')

        const swapper = new OpToStarknetSwap()

        const swapParams: SwapParams = {
            srcToken,
            dstToken,
            makingAmount,
            takingAmount,
            starknetUser,
            starknetResolverContract: '0x56694ab2329b53a675c6308f145872f675f0f4364c9d1440ca53718bb5cb810' // 固定的resolver地址
        }

        const result = await swapper.swapTokens(swapParams)

        console.log('🎉 交换订单创建成功!')
        console.log('订单哈希:', result.orderHash)
        console.log('密钥:', result.secret)

    } catch (error) {
        console.error('❌ 交换失败:', error)
        process.exit(1)
    }
}

// 参数验证函数
function validateParameters(srcToken: string, makingAmountStr: string, dstToken: string, takingAmountStr: string, starknetUser: string) {
    // 验证地址格式
    if (!isValidEthereumAddress(srcToken)) {
        return { isValid: false, error: `无效的源token地址: ${srcToken}` }
    }

    if (!isValidStarknetAddress(dstToken)) {
        return { isValid: false, error: `无效的目标token地址: ${dstToken}` }
    }

    if (!isValidStarknetAddress(starknetUser)) {
        return { isValid: false, error: `无效的Starknet用户地址: ${starknetUser}` }
    }

    // 验证数量
    const makingAmount = parseFloat(makingAmountStr)
    const takingAmount = parseFloat(takingAmountStr)

    if (isNaN(makingAmount) || makingAmount <= 0) {
        return { isValid: false, error: `无效的源token数量: ${makingAmountStr}` }
    }

    if (isNaN(takingAmount) || takingAmount <= 0) {
        return { isValid: false, error: `无效的目标token数量: ${takingAmountStr}` }
    }

    return { isValid: true }
}

// 地址验证辅助函数
function isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address)
}

function isValidStarknetAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{1,64}$/.test(address) && address.length <= 66
}

await main()

export default OpToStarknetSwap


// pnpm run EVMTOSN 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 100 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 1 0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae