import {hash} from 'starknet'


let a = hash.computePoseidonHashOnElements([0x123456])

console.log('a', a)
console.log( BigInt(a).toString())

let hashhh = "0x" + a.slice(2).padStart(64, "0");
console.log(hashhh);


// 0x7450a1480e1e264af95eda7d2b17e337dfaf5516bfd789ec0431884cdb63e0d



