export {}

// Count how many flashblock messages have receipt data vs just transaction data
const wsUrl = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ws = new WebSocket(wsUrl)
let total = 0, withLogs = 0, withBlockNum = 0, withStatus = 0

ws.onopen = () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
}

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.result && typeof msg.result === 'string') return  // sub confirm
  if (msg.method !== 'eth_subscription') return
  const r = msg.params?.result
  if (!r) return
  total++
  if (Array.isArray(r.logs)) withLogs++
  if (r.blockNumber != null) withBlockNum++
  if (r.status != null) withStatus++
  if (total === 1) {
    console.log('First message keys:', Object.keys(r).join(', '))
    console.log('Full first message:', JSON.stringify(r))
  }
  if (total >= 20) {
    console.log(`\n${total} messages: withLogs=${withLogs} withBlockNumber=${withBlockNum} withStatus=${withStatus}`)
    ws.close()
    process.exit(0)
  }
}
setTimeout(() => {
  console.log(`Timeout. ${total} messages: withLogs=${withLogs} withBlockNumber=${withBlockNum} withStatus=${withStatus}`)
  ws.close(); process.exit(0)
}, 20_000)
