


import { RpcProvider, Contract, Account, ec, json, cairo, CallData, hash } from 'starknet';

import resolverABI from './starknetABI/ResolverABI.json' with { type: "json" }

const provider = new RpcProvider({ nodeUrl: 'https://starknet-sepolia.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6/rpc/v0_8', specVersion: '0.8.1' });

const resolverContractAddress = '0x16d599d9fc0476dfe847c454f57349a563703be12852cda3ddf5183400fc334'  //
const resolverContract = new Contract(resolverABI, resolverContractAddress, provider)


let pk = '0x063fe4dd92e9994ffce51bea2fb13644a696a2c959ee1c24ef43f82432ca23a2'
let resolverWaller = '0x048A6a340B41Ba1Be6e17F23881E924746aB7E84c05ff915F4eAe86890b78da1'
let account = new Account(provider, resolverWaller, pk)


let pk2 = '0x07cf7b7fe5b03b1d7410d879fafb484914f289fa2bde347e36209f02b21b405c'
let userWaller = '0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae'
let accountUser = new Account(provider, userWaller, pk2)


let making_amount = cairo.uint256('800000000')
let safety_deposit = cairo.uint256('111110')

let immutables = {
    order_hash: '0x122333333444r53232299222',
    hash_lock: '0x7450a1480e1e264af95eda7d2b17e337dfaf5516bfd789ec0431884cdb63e0d',
    maker: userWaller,
    taker: resolverContractAddress,
    token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    amount: making_amount,
    safety_deposit: safety_deposit,
    timelocks: {
        deployed_at: 0,
        src_withdrawal: 10,
        src_public_withdrawal: 120,
        src_cancellation: 121,
        src_public_cancellation: 122,
        dst_withdrawal: 10,
        dst_public_withdrawal: 100,
        dst_cancellation: 101,
    }
}

let order = {
    salt: '0x123333223123',
    maker: userWaller,
    receiver: '0x7F7Ac1507d9addC6b0b23872334F2a08bDc2Cd25',
    maker_asset: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',  //strk
    taker_asset: '0x722d3c28fadCee0f1070C12C4d47F20DB5bfE82B',
    making_amount: making_amount,
    taking_amount: cairo.uint256('100000'),
}

let orderArray = [
    order.salt,
    order.maker,
    order.receiver,
    order.maker_asset,
    order.taker_asset,
    ...Object.values(order.making_amount),  // 展开 uint256 对象
    ...Object.values(order.taking_amount)   // 展开 uint256 对象
]



const approveRes = await accountUser.execute([
    {
        contractAddress: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
        entrypoint: 'approve',
        calldata: [
            '0x4beec109b7712b2f5576c63af17da0966756438d2a6bbaf894f48b8d17a72f', //lop
            making_amount
        ]
    }
])

const approveTxReceipt = await provider.waitForTransaction(approveRes.transaction_hash)


console.log('approveTxReceipt', approveTxReceipt.isSuccess())
await new Promise(resolve => setTimeout(resolve, 2000))


const result = await account.execute([
    {
        contractAddress: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
        entrypoint: 'transfer',
        calldata: [
            resolverContractAddress,
            safety_deposit
        ]
    },
    {
        contractAddress: resolverContractAddress,
        entrypoint: 'deploy_src',
        calldata: CallData.compile({
            immutables: immutables,
            order: order,
            signature: hash.computeHashOnElements(orderArray)
        }
        )
    }
]
)


const txReceipt = await provider.waitForTransaction(result.transaction_hash)

console.log('txReceipt', txReceipt.isSuccess())


if (txReceipt.isSuccess()) {
    const listEvents = txReceipt.value.events;
    
    const targetKey = '0xf323845026b2be2da82fc16476961f810f279069ce9e128eabc1023a87ade0';
    const targetEvent = listEvents.find(event =>
        event.keys && event.keys.includes(targetKey)
    );

    if (targetEvent) {
        const escrow = targetEvent.data[0];
        const src_cancellation = targetEvent.data[1];

        console.log('escrow', escrow)
        console.log('src_cancellation', src_cancellation)


        await new Promise(resolve => setTimeout(resolve, 2000))


        const withdrawSrcRes = await account.execute([
            {
                contractAddress: resolverContractAddress,  //escrow
                entrypoint: 'withdraw_src',
                calldata: CallData.compile({
                    escrow: escrow,
                    secret: '0x123456',
                    immutables: immutables
                })
            }
        ])

        console.group('withdrawSrcRes', withdrawSrcRes)
    }
}

