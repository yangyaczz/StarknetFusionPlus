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

// 统一配置
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
        SAFETY_DEPOSIT: '110000000000000', // 添加 safety_deposit 配置  0.0006600
    }
} as const

// 时间锁配置
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
    taking: any // cairo.uint256 - 修正为 cairo.uint256
    safetyDeposit: any // cairo.uint256 - 添加 safety_deposit
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

    private lastStarknetImmutables: any; // 存储最后创建的 Starknet immutables

    constructor() {
        // 初始化提供者
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

        // 初始化钱包
        this.wallets = {
            starknetUser: new Account(
                this.providers.starknet,
                process.env.STARKNET_USER_ADDRESS!,
                CONFIG.privateKeys.user
            ),
            resolver: new Wallet(CONFIG.privateKeys.resolver, this.providers.op),
            starknetResolver: new Account(
                this.providers.starknet,
                process.env.STARKNET_RESOLVER_ADDRESS!, // 使用账户地址，不是合约地址
                CONFIG.privateKeys.starknetResolver
            )
        }


    }

    async swapTokens(params: SwapParams) {

        console.log('🚀 开始从Starknet到OP的跨链token交换')
        console.log(`源token: ${params.srcToken} -> 目标token: ${params.dstToken}`)
        console.log(`交换金额: ${params.makingAmount} -> ${params.takingAmount}`)

        // 转换金额并验证
        const amounts = this.parseAmounts(params.makingAmount, params.takingAmount)
        await this.checkAndApproveStarknetTokens(params.srcToken, amounts.making)

        // 创建和签名订单
        const { secret, order, signature, orderHash } = await this.createAndSignStarknetOrder(params, amounts)

        // 等待5s
        await new Promise(resolve => setTimeout(resolve, 5000))

        // 执行跨链交换
        const { srcEscrowAddress, srcCancellation, dstEscrowAddress, dstImmutables } = await this.executeSwap(
            order, signature, orderHash, secret, params, amounts
        )

        // 执行提取操作
        await this.executeWithdrawals(srcEscrowAddress, srcCancellation, dstEscrowAddress, secret, dstImmutables, params)

        return { orderHash, secret, order }
    }

    private parseAmounts(makingAmount: number, takingAmount: number): SwapAmounts {
        const amounts = {
            making: cairo.uint256(parseUnits(makingAmount.toString(), CONFIG.constants.DECIMALS).toString()),
            taking: cairo.uint256(parseUnits(takingAmount.toString(), CONFIG.constants.DECIMALS).toString()), // 修正为 cairo.uint256
            safetyDeposit: cairo.uint256(CONFIG.constants.SAFETY_DEPOSIT) // 添加 safety_deposit
        }

        console.log(`实际金额: ${makingAmount} -> ${takingAmount} (${CONFIG.constants.DECIMALS} decimals)`)
        console.log(`Safety deposit: ${CONFIG.constants.SAFETY_DEPOSIT}`)
        return amounts
    }

    private async createAndSignStarknetOrder(params: SwapParams, amounts: SwapAmounts) {
        const secret = uint8ArrayToHex(randomBytes(31))
        const order = this.createStarknetOrder(params, amounts)
        const signature = this.signStarknetOrder(order)
        const orderHash = hash.computeHashOnElements(this.getOrderArray(order))

        console.log('📝 Starknet订单已创建')
        console.log('📝 订单哈希:', orderHash)

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
        console.log('📤 在Starknet上部署源escrow...')

        // 在Starknet上部署 src escrow
        const { srcEscrowAddress, srcCancellation } = await this.deployStarknetSrcEscrow(order, signature, secret, amounts)
        console.log(`[Starknet] Order ${orderHash} src escrow deployed at ${srcEscrowAddress}`)

        // 在OP上部署 dst escrow
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
        this.lastStarknetImmutables = immutables; // 存储以便后续使用

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
            safety_deposit: amounts.safetyDeposit, // 使用配置的 safety_deposit
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
        // 创建符合EVM格式的dst immutables
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

        console.log(`[OP] Created dst deposit in tx ${dstDepositHash}`);

        // 查询交易的所有事件
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

        // 查找特定的 topic
        const targetTopic = '0xc30e111dcc74fddc2c3a4d98ffb97adec4485c0a687946bf5b22c2a99c7ff96d';
        const targetEvent = txReceipt.logs.find(log =>
            log.topics.includes(targetTopic)
        );

        if (!targetEvent) {
            console.error('❌ 未找到目标事件');
            throw new Error(`Event with topic ${targetTopic} not found`);
        }

        // 解码 data 字段获取 dst escrow 地址
        const dstEscrowAddress = targetEvent.data;

        const parsedAddress = '0x' + dstEscrowAddress.slice(26, 66); // 取地址部分
        console.log('DST Escrow 地址:', parsedAddress);

        // 计算dst escrow地址
        // const opFactory = new EscrowFactory(this.providers.op, this.contracts.escrowFactory);
        // const ESCROW_DST_IMPLEMENTATION = await opFactory.getDestinationImpl();

        dstImmutables[7] = Sdk.TimeLocks.new(TIME_LOCKS).setDeployedAt(dstDeployedAt).build()

        return {
            dstEscrowAddress: parsedAddress,
            dstImmutables: dstImmutables
        };
    }

    private async createOpDstImmutables(orderHash: string, secret: string, params: SwapParams, amounts: SwapAmounts, srcCancellation: bigint) {
        // 1. 处理 orderHash - 转换为适合的格式
        const processedOrderHash = BigInt(orderHash) & ((1n << 256n) - 1n);

        // 2. 将 cairo.uint256 转换为 bigint
        const amountBigInt = BigInt(amounts.taking.low) + (BigInt(amounts.taking.high) << 128n);
        const safetyDepositBigInt = BigInt(amounts.safetyDeposit.low) + (BigInt(amounts.safetyDeposit.high) << 128n);

        // 3. 创建符合 SDK 格式的组件
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
            Sdk.TimeLocks.new(TIME_LOCKS).build()            // uint256 timelocks (编码后的值)
        ];
    }

    // 辅助函数：将 cairo.uint256 转换为 bigint
    private cairoUint256ToBigInt(cairoUint256: any): bigint {
        return BigInt(cairoUint256.low) + (BigInt(cairoUint256.high) << 128n);
    }

    // 更新 executeWithdrawals 方法，正确传递 immutables
    private async executeWithdrawals(srcEscrowAddress: string, srcCancellation: string, dstEscrowAddress: string, secret: string, dstImmutables: any, params: SwapParams) {
        // 等待时间锁
        console.log(`⏰ 等待 ${CONFIG.constants.WAIT_TIME / 1000} 秒...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.constants.WAIT_TIME));

        // 目标链提取 (OP) - 使用正确的格式
        console.log(`💰 从OP dst escrow提取资金: ${dstEscrowAddress}`);

        let interfaceEscrowDst = new Interface([{ "inputs": [{ "internalType": "uint32", "name": "rescueDelay", "type": "uint32" }, { "internalType": "contract IERC20", "name": "accessToken", "type": "address" }], "stateMutability": "nonpayable", "type": "constructor" }, { "inputs": [], "name": "InvalidCaller", "type": "error" }, { "inputs": [], "name": "InvalidImmutables", "type": "error" }, { "inputs": [], "name": "InvalidSecret", "type": "error" }, { "inputs": [], "name": "InvalidTime", "type": "error" }, { "inputs": [], "name": "NativeTokenSendingFailure", "type": "error" }, { "inputs": [], "name": "SafeTransferFailed", "type": "error" }, { "anonymous": false, "inputs": [], "name": "EscrowCancelled", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "bytes32", "name": "secret", "type": "bytes32" }], "name": "EscrowWithdrawal", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "address", "name": "token", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" }], "name": "FundsRescued", "type": "event" }, { "inputs": [], "name": "FACTORY", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "PROXY_BYTECODE_HASH", "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "RESCUE_DELAY", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "cancel", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "secret", "type": "bytes32" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "publicWithdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "rescueFunds", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "secret", "type": "bytes32" }, { "components": [{ "internalType": "bytes32", "name": "orderHash", "type": "bytes32" }, { "internalType": "bytes32", "name": "hashlock", "type": "bytes32" }, { "internalType": "Address", "name": "maker", "type": "uint256" }, { "internalType": "Address", "name": "taker", "type": "uint256" }, { "internalType": "Address", "name": "token", "type": "uint256" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "uint256", "name": "safetyDeposit", "type": "uint256" }, { "internalType": "Timelocks", "name": "timelocks", "type": "uint256" }], "internalType": "struct IBaseEscrow.Immutables", "name": "immutables", "type": "tuple" }], "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }])

        const { txHash: dstWithdrawHash } = await this.wallets.resolver.send({
            to: dstEscrowAddress,
            data: interfaceEscrowDst.encodeFunctionData('withdraw', [
                secret + '00',
                dstImmutables,
            ])
        });

        console.log('✅ op dst withdraw completed:', dstWithdrawHash);

        // 源链提取 (Starknet) - 需要重新构建 immutables
        console.log(`💰 从Starknet src escrow提取资金: ${srcEscrowAddress}`);

        // 存储原始订单和金额信息作为类属性，避免重新创建
        const starknetImmutables = this.lastStarknetImmutables; // 需要在类中存储这个

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
        console.log('✅ Starknet src withdraw completed:', withdrawSrcResult);
    }

    private async checkAndApproveStarknetTokens(tokenAddress: string, amount: any) {
        console.log('🔓 检查并授权Starknet token...')

        // 需要授权 making_amount，用于LOP
        const approveResult = await this.wallets.starknetUser.execute([{
            contractAddress: tokenAddress,
            entrypoint: 'approve',
            calldata: [
                CONFIG.starknet.limitOrderProtocol,
                amount // 这里是 making_amount
            ]
        }])

        const txReceipt = await this.providers.starknet.waitForTransaction(approveResult.transaction_hash)

        if (!txReceipt.isSuccess()) {
            throw new Error('Starknet token approval failed')
        }

        console.log('✅ Starknet token授权成功')
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
            console.log('pnpm run swap-starknet-to-op <srcToken> <makingAmount> <dstToken> <takingAmount> <opUser>')
            console.log('')
            console.log('参数说明:')
            console.log('  srcToken     - Starknet源token地址 (如: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d)')
            console.log('  makingAmount - 源token数量 (如: 100)')
            console.log('  dstToken     - OP目标token地址 (如: 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B)')
            console.log('  takingAmount - 目标token数量 (如: 1)')
            console.log('  opUser       - OP用户地址 (如: 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25)')
            console.log('')
            console.log('示例:')
            console.log('pnpm run swap-starknet-to-op 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 100 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 1 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25')
            process.exit(1)
        }

        const [srcToken, makingAmountStr, dstToken, takingAmountStr, opUser] = args

        // 验证参数
        const validation = validateParameters(srcToken, makingAmountStr, dstToken, takingAmountStr, opUser)
        if (!validation.isValid) {
            console.error('❌ 参数验证失败:', validation.error)
            process.exit(1)
        }

        const makingAmount = parseFloat(makingAmountStr)
        const takingAmount = parseFloat(takingAmountStr)

        console.log('📋 交换参数:')
        console.log(`  源Token (Starknet): ${srcToken}`)
        console.log(`  源数量: ${makingAmount}`)
        console.log(`  目标Token (OP): ${dstToken}`)
        console.log(`  目标数量: ${takingAmount}`)
        console.log(`  OP用户: ${opUser}`)
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

        console.log('🎉 交换订单创建成功!')
        console.log('订单哈希:', result.orderHash)
        console.log('密钥:', result.secret)

    } catch (error) {
        console.error('❌ 交换失败:', error)
        process.exit(1)
    }
}

// 参数验证函数
function validateParameters(srcToken: string, makingAmountStr: string, dstToken: string, takingAmountStr: string, opUser: string) {
    // 验证地址格式
    if (!isValidStarknetAddress(srcToken)) {
        return { isValid: false, error: `无效的Starknet源token地址: ${srcToken}` }
    }

    if (!isValidEthereumAddress(dstToken)) {
        return { isValid: false, error: `无效的OP目标token地址: ${dstToken}` }
    }

    if (!isValidEthereumAddress(opUser)) {
        return { isValid: false, error: `无效的OP用户地址: ${opUser}` }
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

export default StarknetToOpSwap


// pnpm run SNTOEVM <starknetToken> <amount1> <opToken> <amount2> <opUserAddress>

// pnpm run SNTOEVM 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d 0.01 0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B 8 0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25