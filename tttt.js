// import { hash } from 'starknet'


// let a = hash.computePoseidonHashOnElements([0x123456])

// console.log('a', a)
// console.log(BigInt(a).toString())

// let hashhh = "0x" + a.slice(2).padStart(64, "0");
// console.log(hashhh);



// process.exit()




import { RpcProvider, Contract, Account, ec, json, cairo, CallData } from 'starknet';

import resolverABI from './starknetABI/ResolverABI.json' with { type: "json" }

const provider = new RpcProvider({ nodeUrl: 'https://starknet-sepolia.blastapi.io/7153c233-d0cf-4ce5-997a-1d57f71635b6/rpc/v0_8', specVersion: '0.8.0' });


const resolverAddress = '0x4184c728ca0c9cfbc0627603013b1850f1727c1e09d3a1d6090dee05d68f63e'

const resolverContract = new Contract(resolverABI, resolverAddress, provider)


let pk = '0x063fe4dd92e9994ffce51bea2fb13644a696a2c959ee1c24ef43f82432ca23a2'
let resolverWaller = '0x048A6a340B41Ba1Be6e17F23881E924746aB7E84c05ff915F4eAe86890b78da1'
let account = new Account(provider, resolverWaller, pk)


let immutables = {
    order_hash: '0x12312122222222222',
    hash_lock: '0x7450a1480e1e264af95eda7d2b17e337dfaf5516bfd789ec0431884cdb63e0d',
    maker: '0x060684D67EE65A3C3C41932cAeAD3d6B19c0738390d24924f172FFB416Cef3ae',
    taker: '0x048A6a340B41Ba1Be6e17F23881E924746aB7E84c05ff915F4eAe86890b78da1',
    token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    amount: cairo.uint256('100000'),      
    safety_deposit: cairo.uint256('100000'),
    timelocks: {
        deployed_at: 0,
        src_withdrawal: 10,
        src_public_withdrawal: 120,
        src_cancellation: 121,
        src_public_cancellation: 122,
        dst_withdrawal: 10,
        dst_public_withdrawal: 100,
        dst_cancellation: 1754339935,
    }
}



// const result = await account.execute([
//     {
//         contractAddress: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
//         entrypoint: 'transfer',
//         calldata: [
//             resolverAddress,
//             cairo.uint256(200000)
//         ]
//     }
//     ,
//     {
//         contractAddress: resolverAddress,
//         entrypoint: 'deploy_dst',
//         calldata: CallData.compile({
//             immutables: immutables,
//             src_cancellation_timestamp: 1754339936
//         }
//         )
//     }

//     // {
//     //     contractAddress: '0x56a199a9b733c4876999435e96b6737c3417fe6f759331c58fdde7bca1cabb4', //factory
//     //     entrypoint: 'create_dst_escrow',
//     //     calldata: CallData.compile({
//     //         immutables: immutables,
//     //         src_cancellation_timestamp: 1754339936
//     //     })
//     // }

// ]
// )

// console.log('res', result)

// await provider.waitForTransaction(result.transaction_hash)


const result2 = await account.execute([
    {
        contractAddress: '0x022447f7002e185fc676c7e939b08f8dae5582a07bec68198eebf2da1c7bcf54',  //escrow
        entrypoint: 'withdraw',
        calldata: CallData.compile({
            secret: '0x123456',
            immutables: immutables
        })
    }
])

console.group('res', result2)

