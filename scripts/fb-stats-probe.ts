export {}

const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ws = new WebSocket(WS_URL)
let total = 0, withBlockNum = 0, withNonEmptyLogs = 0, noLogs = 0

ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.result) return
  if (msg.method !== 'eth_subscription') return
  const r = msg.params?.result
  if (!r) return
  total++
  if (r.blockNumber != null) withBlockNum++
  if (!Array.isArray(r.logs)) noLogs++
  else if (r.logs.length > 0) withNonEmptyLogs++
}

await new Promise(r => setTimeout(r, 5_000))
console.log(`total=${total}`)
console.log(`  with blockNumber: ${withBlockNum} (${(100*withBlockNum/total).toFixed(1)}%)`)
console.log(`  no logs field:    ${noLogs}`)
console.log(`  non-empty logs:   ${withNonEmptyLogs} (${(100*withNonEmptyLogs/total).toFixed(1)}%)`)
ws.close()
process.exit(0)
