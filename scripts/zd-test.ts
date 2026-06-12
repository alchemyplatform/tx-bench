import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'

const PROJECT_ID = process.env.ZERODEV_PROJECT_ID!
const NEUTRAL_RPC = process.env.NEUTRAL_RPC_URL ?? 'https://mainnet.base.org'
const RPC_URL = `https://rpc.zerodev.app/api/v3/${PROJECT_ID}/chain/8453`

const privateKey = generatePrivateKey()
const owner = privateKeyToAccount(privateKey)
console.log('owner:', owner.address)

const publicClient = createPublicClient({ chain: base, transport: http(NEUTRAL_RPC) })

console.log('creating validator...')
const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
  signer: owner,
  entryPoint: { address: entryPoint07Address, version: '0.7' },
  kernelVersion: '0.3.3',
})

console.log('creating account...')
const kernelAccount = await createKernelAccount(publicClient, {
  plugins: { sudo: ecdsaValidator },
  entryPoint: { address: entryPoint07Address, version: '0.7' },
  kernelVersion: '0.3.3',
})
console.log('account:', kernelAccount.address)

console.log('creating paymaster...')
const paymasterClient = createZeroDevPaymasterClient({ transport: http(RPC_URL), chain: base })

console.log('creating kernel client...')
const kernelClient = createKernelAccountClient({
  account: kernelAccount,
  chain: base,
  bundlerTransport: http(RPC_URL),
  paymaster: paymasterClient,
})

console.log('sending userOp...')
try {
  const hash = await kernelClient.sendUserOperation({
    calls: [{ to: owner.address, value: 0n, data: '0x' }],
  })
  console.log('hash:', hash)
} catch (e) {
  console.error('FULL ERROR:')
  console.error(e)
  if (e instanceof Error) {
    console.error('\nmessage:', e.message)
    console.error('cause:', (e as any).cause)
    const cause = (e as any).cause
    if (cause) {
      console.error('cause.message:', cause?.message)
      console.error('cause.data:', cause?.data)
      console.error('cause.cause:', cause?.cause)
    }
  }
}
