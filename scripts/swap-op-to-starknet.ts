import * as Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
} from 'ethers'
import { uint8ArrayToHex, UINT_40_MAX } from '@1inch/byte-utils'
import { ethers } from 'ethers'
import { hash, getChecksumAddress } from 'starknet'
import { Wallet } from './wallet'

import { EscrowFactory } from './escrow-factory'

const { Address } = Sdk
import { ResolverEVM } from './resolverevm'
import dotenv from 'dotenv'
dotenv.config({})

// OP 链配置
const OP_CONFIG = {
    chainId: 10,
    url: 'https://optimism-mainnet.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6',
    limitOrderProtocol: '0x111111125421cA6dc452d289314280a0f8842A65', // 1inch LOP on OP
    wrappedNative: '0x4200000000000000000000000000000000000006', // WETH on OP
}

// Starknet 配置 - 使用chainId 99999表示非EVM链
const STARKNET_CONFIG = {
    chainId: 99999, // 非EVM链标识
    realChainId: 'SN_MAIN', // Starknet主网
    rpcUrl: 'https://starknet-mainnet.public.blastapi.io/rpc/v0_7' // Starknet RPC URL
}

// 用户和解析器私钥
const USER_PRIVATE_KEY = process.env.PRIVATE_KEY_EVM_USER
const RESOLVER_PRIVATE_KEY = process.env.PRIVATE_KEY_EVM_RESOLVER



export class OpToStarknetSwap {
    private opProvider: JsonRpcProvider
    private userWallet: Wallet
    private resolverWallet: Wallet
    private escrowFactory: string
    private resolver: string

    constructor() {


        this.opProvider = new JsonRpcProvider(OP_CONFIG.url, OP_CONFIG.chainId, {
            cacheTimeout: -1,
            staticNetwork: true
        })

        this.userWallet = new Wallet(USER_PRIVATE_KEY as string, this.opProvider)
        this.resolverWallet = new Wallet(RESOLVER_PRIVATE_KEY as string, this.opProvider)

        // 这些地址需要预先部署
        this.escrowFactory = '0xa7bCb4EAc8964306F9e3764f67Db6A7af6DdF99A'
        this.resolver = '0x55e723eE06b4bF69734EDe8e4d0CC443D85BDF93'
    }



    async swapTokens(
        srcTokenAddress: string,      // 源链token地址
        dstTokenAddress: string,      // 目标链token地址
        makingAmount: number,         // 源token数量（整数）
        takingAmount: number,         // 目标token数量（整数）
        starknetUserAddress: string,  // Starknet用户地址
        starknetResolverAddress: string // Starknet解析器地址
    ) {
        console.log('🚀 开始跨链token交换')
        console.log(`源token: ${srcTokenAddress}`)
        console.log(`目标token: ${dstTokenAddress}`)
        console.log(`交换金额: ${makingAmount} -> ${takingAmount}`)

        // 2. 转换金额
        const makingAmountBig = parseUnits(makingAmount.toString(), 18)
        const takingAmountBig = parseUnits(takingAmount.toString(), 18)

        console.log(`实际金额: ${makingAmountBig} (${18} decimals) -> ${takingAmountBig} (${18} decimals)`)

        // 3. 检查余额和授权
        await this.checkAndApproveTokens(srcTokenAddress, makingAmountBig)

        // 4. 创建跨链订单
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = await this.createCrossChainOrder(
            srcTokenAddress,
            dstTokenAddress,
            makingAmountBig,
            takingAmountBig,
            secret,
            starknetUserAddress,
            starknetResolverAddress
        )

        // 5. 签名订单
        const signature = await this.userWallet.signOrder(OP_CONFIG.chainId, order)
        console.log('📝 订单已签名:', signature)

        const orderHash = order.getOrderHash(OP_CONFIG.chainId)
        console.log('📝 订单哈希:', orderHash)

        // 6. 提交订单给解析器
        console.log('📤 提交订单给解析器...')

        const resolverSrc = new ResolverEVM(this.resolver, this.resolver)

        const fillAmount = order.makingAmount

        // 创建src escrow
        const { txHash: orderFillHash, blockHash: srcDeployBlock } = await this.resolverWallet.send(
            resolverSrc.deploySrc(
                OP_CONFIG.chainId,
                order,
                signature,
                Sdk.TakerTraits.default()
                    .setExtension(order.extension)
                    .setAmountMode(Sdk.AmountMode.maker)
                    .setAmountThreshold(order.takingAmount),
                fillAmount
            )
        )

        console.log(`[${OP_CONFIG.chainId}]`, `Order ${orderHash} filled for ${fillAmount} in tx ${orderFillHash}`)


        // get src escrow address and event

        let opFactory = new EscrowFactory(this.opProvider, this.escrowFactory)

        const srcEscrowEvent = await opFactory.getSrcDeployEvent(srcDeployBlock)

        const dstImmutables = srcEscrowEvent[0]
        const srcCancellation =  dstImmutables.timeLocks.toSrcTimeLocks().privateCancellation


        const ESCROW_SRC_IMPLEMENTATION = await opFactory.getSourceImpl()
        const srcEscrowAddress = new Sdk.EscrowFactory(new Address(this.escrowFactory)).getSrcEscrowAddress(
            srcEscrowEvent[0],
            ESCROW_SRC_IMPLEMENTATION
        )


        // wait for 11 seconds
        await new Promise(resolve => setTimeout(resolve, 11000))
        const { txHash: resolverWithdrawHash } = await this.resolverWallet.send(
            resolverSrc.withdraw('src', srcEscrowAddress, secret+ '00', srcEscrowEvent[0])
        )




        return {
            orderHash: order.getOrderHash(OP_CONFIG.chainId),
            secret,
            order
        }
    }

    private async createCrossChainOrder(
        srcTokenAddress: string,
        dstTokenAddress: string,
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
                makerAsset: new Address(srcTokenAddress),
                takerAsset: new Address('0x0000000000000000000000000000000000000000')
            },
            {
                hashLock: Sdk.HashLock.forSingleFill(secret + '00'),
                timeLocks: Sdk.TimeLocks.new({
                    srcWithdrawal: 10n, // 10分钟最终性锁定
                    srcPublicWithdrawal: 120n, // 2小时私人提取
                    srcCancellation: 121n, // 1分钟公共提取
                    srcPublicCancellation: 122n, // 1分钟私人取消
                    dstWithdrawal: 10n, // 10分钟最终性锁定
                    dstPublicWithdrawal: 100n, // 100分钟私人提取
                    dstCancellation: 101n // 1分钟公共提取
                }),
                srcChainId: OP_CONFIG.chainId,
                dstChainId: 1,
                srcSafetyDeposit: parseEther('0'), // 0.01 ETH
                dstSafetyDeposit: parseEther('0') // 0.01 ETH等值
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

        let starkentHashlock = '0x' + hash.computePoseidonHashOnElements([secret]).slice(2).padStart(64, '0')

        // 将Starknet地址编码到customData中
        const customData = this.encodeCustomData(getChecksumAddress(starknetUserAddress), getChecksumAddress(dstTokenAddress), starkentHashlock)
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
            srcToken: srcTokenAddress,
            dstToken: dstTokenAddress,
            srcChain: 'Optimism',
            dstChain: 'Starknet'
        })

        return order
    }

    private encodeCustomData(receiver: string, asset: string, hashLock: string): string {
        // 去掉0x再拼接
        const r = receiver.replace(/^0x/, '');
        const a = asset.replace(/^0x/, '');
        const h = hashLock.replace(/^0x/, '');

        // 拼成一长串 hex
        return '0x' + r + a + h;
    }

    private async checkAndApproveTokens(tokenAddress: string, amount: bigint) {
        const tokenContract = new ethers.Contract(
            tokenAddress,
            [
                'function balanceOf(address) view returns (uint256)',
                'function approve(address,uint256) returns (bool)',
                'function allowance(address,address) view returns (uint256)'
            ],
            this.userWallet
        )

        const userAddress = await this.userWallet.getAddress()
        const balance = await tokenContract.balanceOf(userAddress)
        console.log(`💰 当前token余额: ${balance} (需要: ${amount})`)

        if (balance < amount) {
            throw new Error(`token余额不足! 当前: ${balance}, 需要: ${amount}`)
        }

        // 检查授权
        const allowance = await tokenContract.allowance(userAddress, OP_CONFIG.limitOrderProtocol)

        if (allowance < amount) {
            console.log('🔓 授权token给1inch限价订单协议...')
            const approveTx = await tokenContract.approve(OP_CONFIG.limitOrderProtocol, MaxUint256)
            await approveTx.wait()
            console.log('✅ token授权成功')
        }
    }

}

// 主函数
async function main() {
    try {

        console.log('USER_PRIVATE_KEY', USER_PRIVATE_KEY)
        const swapper = new OpToStarknetSwap()

        // 示例：交换100 OP USDC -> 99 Starknet USDC
        const result = await swapper.swapTokens(
            '0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B', // OP stFusion
            '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', // Starknet strk
            100, // 100 stFusion
            10,  // 10 strk
            '0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae', // Starknet user address
            '0x047578c716eb4724097f9ca85e30997a4655b0ce44f9259e19e6fd81bb7a72b9'  // Starknet resolver ??
        )

        console.log('🎉 交换订单创建成功!')
        console.log('订单哈希:', result.orderHash)
        console.log('密钥:', result.secret)

    } catch (error) {
        console.error('❌ 交换失败:', error)
        process.exit(1)
    }
}

await main()

export default OpToStarknetSwap