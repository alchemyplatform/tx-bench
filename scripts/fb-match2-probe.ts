import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import { generatePrivateKey } from 'viem/accounts'
import { keccak256, toHex } from 'viem'

const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY!
const ALCHEMY_POLICY_ID = process.env.ALCHEMY_POLICY_ID!
const USER_OP_TOPIC = keccak256(toHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'))

let msgs = 0, uoEvents = 0
let targetHash = ''
let foundAt = ''

// Simple single handler, never reassigned
const ws = new WebSocket(WS_URL)
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (!msg.params?.result) return
  const r = msg.params.result
  msgs++
  if (!Array.isArray(r.logs) || r.logs.length === 0) return
  for (const log of r.logs) {
    const t = log.topics
    if (!Array.isArray(t) || t.length < 2) continue
    if (t[0]?.toLowerCase() !== USER_OP_TOPIC.toLowerCase()) continue
    uoEvents++
    if (targetHash && t[1]?.toLowerCase() === targetHash.toLowerCase()) {
      foundAt = `blockNumber=${r.blockNumber} msgs=${msgs}`
    }
  }
}

// Pre-warm 2s
await new Promise(r => setTimeout(r, 2_000))
console.log(`Warm-up done: ${msgs} msgs`)

// Submit
const signer = LocalAccountSigner.privateKeyToAccountSigner(generatePrivateKey())
const client = await createLightAccountAlchemyClient({ transport: alchemy({ apiKey: ALCHEMY_API_KEY }), chain: base, signer, policyId: ALCHEMY_POLICY_ID })
const t0 = performance.now()
const { hash } = await client.sendUserOperation({ uo: { target: client.account.address, data: '0x', value: 0n } })
console.log(`Submit: ${(performance.now()-t0).toFixed(0)}ms, hash: ${hash}`)
targetHash = hash

// Watch 15s
await new Promise(r => setTimeout(r, 15_000))
console.log(`\nTotal msgs: ${msgs}, UO events seen: ${uoEvents}`)
console.log(`Found our hash: ${foundAt || 'NO'}`)
ws.close()
process.exit(0)
