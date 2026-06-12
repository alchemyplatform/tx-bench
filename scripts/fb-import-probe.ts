// Does importing account-kit and awaiting it kill the WS message loop?
import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import { generatePrivateKey } from 'viem/accounts'

const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY!
const ALCHEMY_POLICY_ID = process.env.ALCHEMY_POLICY_ID!

let msgs = 0
const ws = new WebSocket(WS_URL)
ws.onopen = () => { console.log('open'); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] })) }
ws.onmessage = () => { msgs++ }

// Warm-up: let WS stream for 2s BEFORE doing any account-kit work
console.log('Waiting 2s for WS warm-up...')
await new Promise(r => setTimeout(r, 2_000))
console.log(`Msgs before account-kit: ${msgs}`)

// Now do account-kit work
console.log('Creating account-kit client...')
const signer = LocalAccountSigner.privateKeyToAccountSigner(generatePrivateKey())
const client = await createLightAccountAlchemyClient({ transport: alchemy({ apiKey: ALCHEMY_API_KEY }), chain: base, signer, policyId: ALCHEMY_POLICY_ID })
console.log(`After createClient: msgs=${msgs}`)

const { hash } = await client.sendUserOperation({ uo: { target: client.account.address, data: '0x', value: 0n } })
console.log(`After sendUserOp: msgs=${msgs}, hash=${hash}`)

await new Promise(r => setTimeout(r, 5_000))
console.log(`After 5s wait: msgs=${msgs}`)
ws.close()
process.exit(0)
