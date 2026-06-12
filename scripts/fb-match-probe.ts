import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import { generatePrivateKey } from 'viem/accounts'
import { keccak256, toHex } from 'viem'

const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY!
const ALCHEMY_POLICY_ID = process.env.ALCHEMY_POLICY_ID!
const USER_OP_TOPIC = keccak256(toHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'))

let totalMsgs = 0, withLogs = 0
const allUOHashes: string[] = []
let targetHash: string | null = null
let found = false

// Set handler ONCE, before any awaits — check a mutable targetHash inside
const ws = new WebSocket(WS_URL)
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.result) { console.log('Subscribed'); return }
  if (msg.method !== 'eth_subscription') return
  const r = msg.params?.result
  if (!r) return
  totalMsgs++
  if (!Array.isArray(r.logs) || r.logs.length === 0) return
  withLogs++
  for (const log of r.logs) {
    const t = log.topics
    if (!Array.isArray(t) || t.length < 2) continue
    if (t[0]?.toLowerCase() !== USER_OP_TOPIC.toLowerCase()) continue
    allUOHashes.push(t[1])
    if (targetHash && t[1]?.toLowerCase() === targetHash.toLowerCase()) {
      const elapsed = performance.now() - submitTime
      console.log(`\n✓ MATCH at +${elapsed.toFixed(0)}ms! blockNumber=${r.blockNumber}`)
      found = true
    }
  }
}
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))

// Wait for subscribe confirm
await new Promise<void>(r => { const orig = ws.onmessage; ws.onmessage = (ev) => { orig?.call(ws, ev); if (JSON.parse(ev.data).result) r() } })

await new Promise(r => setTimeout(r, 300)) // let settle
const signer = LocalAccountSigner.privateKeyToAccountSigner(generatePrivateKey())
const client = await createLightAccountAlchemyClient({ transport: alchemy({ apiKey: ALCHEMY_API_KEY }), chain: base, signer, policyId: ALCHEMY_POLICY_ID })
let submitTime = performance.now()
console.log('Submitting...')
const { hash } = await client.sendUserOperation({ uo: { target: client.account.address, data: '0x', value: 0n } })
submitTime = performance.now()
console.log(`Hash: ${hash}  (submit took ${(performance.now()-submitTime+submitTime - (performance.now()-submitTime)).toFixed(0)}ms approx)`)
targetHash = hash

await new Promise(r => setTimeout(r, 15_000))
console.log(`\n--- Summary ---`)
console.log(`Msgs: ${totalMsgs}, withNonEmptyLogs: ${withLogs}`)
console.log(`UO events seen: ${allUOHashes.length}, found ours: ${found}`)
if (allUOHashes.length > 0 && !found) console.log('Sample hashes:', allUOHashes.slice(0,3))
ws.close()
process.exit(0)
