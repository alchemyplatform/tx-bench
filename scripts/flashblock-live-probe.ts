import { createPublicClient, http, parseAbiItem, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'

const wsUrl = process.env.NEUTRAL_FLASHBLOCK_WS_URL
if (!wsUrl) { console.error('NEUTRAL_FLASHBLOCK_WS_URL not set'); process.exit(1) }

const USER_OP_EVENT_TOPIC = keccak256(
  toHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')
)
console.log('Expected topic[0]:', USER_OP_EVENT_TOPIC)

// Connect and watch for 30s, log any UserOperationEvent logs we see
const ws = new WebSocket(wsUrl)
let msgCount = 0
let userOpMsgCount = 0

ws.onopen = () => {
  console.log('Connected. Subscribing...')
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
}

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.result && typeof msg.result === 'string') {
    console.log('Subscribed:', msg.result)
    return
  }
  if (msg.method !== 'eth_subscription') return
  const result = msg.params?.result
  if (!result) return

  msgCount++

  const logs = result.logs
  if (!Array.isArray(logs) || logs.length === 0) return

  for (const log of logs) {
    if (!Array.isArray(log.topics) || log.topics.length < 2) continue
    if (log.topics[0].toLowerCase() === USER_OP_EVENT_TOPIC.toLowerCase()) {
      userOpMsgCount++
      console.log(`\n✓ UserOperationEvent found! (msg #${msgCount})`)
      console.log('  blockNumber:', result.blockNumber)
      console.log('  topics[1] (userOpHash):', log.topics[1])
      console.log('  transactionHash:', result.hash)
    }
  }

  if (msgCount % 50 === 0) {
    process.stdout.write(`  [${msgCount} msgs, ${userOpMsgCount} UO events seen]\r`)
  }
}

ws.onerror = (e) => { console.error('Error:', e) }

setTimeout(() => {
  console.log(`\n\nDone. Saw ${msgCount} total msgs, ${userOpMsgCount} UserOperationEvent logs in 30s.`)
  ws.close()
  process.exit(0)
}, 30_000)
