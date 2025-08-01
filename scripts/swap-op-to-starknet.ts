import 'dotenv/config'
import Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import { uint8ArrayToHex, UINT_40_MAX } from '@1inch/byte-utils'
import { ethers } from 'ethers'

const { Address } = Sdk

// OP 链配置
const OP_CONFIG = {
    chainId: 10,
    url: process.env.OP_RPC_URL || 'https://mainnet.optimism.io',
    limitOrderProtocol: '0x111111125421cA6dc452d289314280a0f8842A65', // 1inch LOP on OP
    wrappedNative: '0x4200000000000000000000000000000000000006', // WETH on OP
    tokens: {
        USDC: {
            address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // USDC on OP
            donor: '0x625E7708f30cA75bfd92586e17077590C60eb4cD' // Rich USDC holder on OP
        }
    },
    ownerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000001'
}

// Starknet 配置 - 使用chainId 99999表示非EVM链
const STARKNET_CONFIG = {
    chainId: 99999, // 非EVM链标识
    realChainId: 'SN_MAIN', // Starknet主网
    tokens: {
        USDC: {
            // Starknet USDC地址（需要转换为felt格式）
            address: '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8'
        }
    }
}

// 用户和解析器私钥
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const RESOLVER_PRIVATE_KEY = process.env.RESOLVER_PRIVATE_KEY || '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

export class OpToStarknetSwap {
    private opProvider: JsonRpcProvider
    private userWallet: SignerWallet
    private resolverWallet: SignerWallet
    private escrowFactory: string
    private resolver: string

    constructor() {
        this.opProvider = new JsonRpcProvider(OP_CONFIG.url, OP_CONFIG.chainId, {
            cacheTimeout: -1,
            staticNetwork: true
        })
        
        this.userWallet = new SignerWallet(USER_PRIVATE_KEY, this.opProvider)
        this.resolverWallet = new SignerWallet(RESOLVER_PRIVATE_KEY, this.opProvider)
        
        // 这些地址需要预先部署
        this.escrowFactory = process.env.OP_ESCROW_FACTORY || ''
        this.resolver = process.env.OP_RESOLVER || ''
    }

    async swapOpUsdcToStarknetUsdc(
        makingAmount: bigint, // OP USDC amount (6 decimals)
        takingAmount: bigint, // Starknet USDC amount (6 decimals) 
        starknetUserAddress: string, // Starknet用户地址
        starknetResolverAddress: string // Starknet解析器地址
    ) {
        console.log('🚀 开始 OP USDC -> Starknet USDC 跨链交换')
        console.log(`交换金额: ${makingAmount} OP USDC -> ${takingAmount} Starknet USDC`)

        // 1. 检查余额和授权
        await this.checkAndApproveTokens(makingAmount)

        // 2. 创建跨链订单
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = await this.createCrossChainOrder(makingAmount, takingAmount, secret, starknetUserAddress, starknetResolverAddress)

        // 3. 签名订单
        const signature = await this.userWallet.signMessage(ethers.getBytes(order.getOrderHash(OP_CONFIG.chainId)))
        console.log('📝 订单已签名:', signature)

        // 4. 提交订单给解析器
        console.log('📤 提交订单给解析器...')
        // 这里应该调用解析器的API或合约方法来处理订单
        // 实际实现中，解析器会：
        // - 在OP链上创建源escrow
        // - 在Starknet上创建目标escrow  
        // - 处理资金交换

        return {
            orderHash: order.getOrderHash(OP_CONFIG.chainId),
            secret,
            order
        }
    }

    private async createCrossChainOrder(
        makingAmount: bigint,
        takingAmount: bigint, 
        secret: string,
        starknetUserAddress: string,
        starknetResolverAddress: string
    ) {
        const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))

        const order = Sdk.CrossChainOrder.new(
            new Address(this.escrowFactory),
            {
                salt: Sdk.randBigInt(1000n),
                maker: new Address(await this.userWallet.getAddress()),
                makingAmount,
                takingAmount,
                makerAsset: new Address(OP_CONFIG.tokens.USDC.address),
                takerAsset: new Address(STARKNET_CONFIG.tokens.USDC.address)
            },
            {
                hashLock: Sdk.HashLock.forSingleFill(secret),
                timeLocks: Sdk.TimeLocks.new({
                    srcWithdrawal: 600n, // 10分钟最终性锁定
                    srcPublicWithdrawal: 7200n, // 2小时私人提取
                    srcCancellation: 7260n, // 1分钟公共提取
                    srcPublicCancellation: 7320n, // 1分钟私人取消
                    dstWithdrawal: 600n, // 10分钟最终性锁定
                    dstPublicWithdrawal: 6000n, // 100分钟私人提取
                    dstCancellation: 6060n // 1分钟公共提取
                }),
                srcChainId: OP_CONFIG.chainId,
                dstChainId: STARKNET_CONFIG.chainId,
                srcSafetyDeposit: parseEther('0.01'), // 0.01 ETH
                dstSafetyDeposit: parseEther('0.01') // 0.01 ETH等值
            },
            {
                auction: new Sdk.AuctionDetails({
                    initialRateBump: 0,
                    points: [],
                    duration: 3600n, // 1小时
                    startTime: currentTimestamp
                }),
                whitelist: [
                    {
                        address: new Address(this.resolver),
                        allowFrom: 0n
                    }
                ],
                resolvingStartTime: 0n
            },
            {
                nonce: Sdk.randBigInt(UINT_40_MAX),
                allowPartialFills: false,
                allowMultipleFills: false
            }
        ) as any

        // 设置非EVM链标志
        const DST_NOT_EVM_FLAG = 1n << 253n
        const originalMakerTraits = order.inner.inner.makerTraits.value.value
        order.inner.inner.makerTraits.value.value = originalMakerTraits | DST_NOT_EVM_FLAG

        // 设置Starknet链ID
        order.inner.escrowExtension.dstChainId = STARKNET_CONFIG.chainId

        // 将Starknet地址编码到customData中
        const customData = this.encodeStarknetAddresses(starknetUserAddress, starknetResolverAddress)
        order.inner.inner.extension.customData = customData

        // 重新计算salt
        const extensionBytes = order.extension.encode()
        const extensionHash = ethers.keccak256(extensionBytes)
        const newSalt = BigInt(extensionHash) & ((1n << 160n) - 1n)
        order.inner.inner._salt = newSalt

        console.log('📋 创建跨链订单:', {
            orderHash: order.getOrderHash(OP_CONFIG.chainId),
            makingAmount: makingAmount.toString(),
            takingAmount: takingAmount.toString(),
            srcChain: 'Optimism',
            dstChain: 'Starknet'
        })

        return order
    }

    private encodeStarknetAddresses(userAddress: string, resolverAddress: string): string {
        // 将Starknet地址编码为customData
        // 移除0x前缀并确保地址长度正确
        const cleanUserAddr = userAddress.replace('0x', '').padStart(64, '0')
        const cleanResolverAddr = resolverAddress.replace('0x', '').padStart(64, '0')
        
        return '0x' + cleanUserAddr + cleanResolverAddr
    }

    private async checkAndApproveTokens(amount: bigint) {
        const usdcContract = new ethers.Contract(
            OP_CONFIG.tokens.USDC.address,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            this.userWallet
        )

        const balance = await usdcContract.balanceOf(await this.userWallet.getAddress())
        console.log(`💰 当前USDC余额: ${balance} (需要: ${amount})`)

        if (balance < amount) {
            throw new Error(`USDC余额不足! 当前: ${balance}, 需要: ${amount}`)
        }

        // 检查授权
        const allowance = await usdcContract.allowance(
            await this.userWallet.getAddress(),
            OP_CONFIG.limitOrderProtocol
        )

        if (allowance < amount) {
            console.log('🔓 授权USDC给1inch限价订单协议...')
            const approveTx = await usdcContract.approve(OP_CONFIG.limitOrderProtocol, MaxUint256)
            await approveTx.wait()
            console.log('✅ USDC授权成功')
        }
    }
}

// 主函数
async function main() {
    try {
        const swapper = new OpToStarknetSwap()
        
        // 示例：交换100 OP USDC -> 99 Starknet USDC
        const result = await swapper.swapOpUsdcToStarknetUsdc(
            parseUnits('100', 6), // 100 USDC
            parseUnits('99', 6),  // 99 USDC (考虑费用)
            '0x047578c716eb4724097f9ca85e30997a4655b0ce44f9259e19e6fd81bb7a72b8', // Starknet用户地址
            '0x047578c716eb4724097f9ca85e30997a4655b0ce44f9259e19e6fd81bb7a72b9'  // Starknet解析器地址
        )

        console.log('🎉 交换订单创建成功!')
        console.log('订单哈希:', result.orderHash)
        console.log('密钥:', result.secret)
        
    } catch (error) {
        console.error('❌ 交换失败:', error)
        process.exit(1)
    }
}

if (require.main === module) {
    main()
}

export default OpToStarknetSwap