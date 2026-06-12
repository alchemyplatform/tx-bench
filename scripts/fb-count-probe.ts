export {}

// Simplest possible check: how many messages come through in 10s after subscribing
const WS_URL = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
const ws = new WebSocket(WS_URL)
let total = 0, withLogs = 0

ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.result) { console.log('Subscribed'); return }
  if (msg.method !== 'eth_subscription') return
  total++
  const r = msg.params?.result
  if (r && Array.isArray(r.logs) && r.logs.length > 0) withLogs++
}

await new Promise(r => setTimeout(r, 10_000))
console.log(`10s total=${total} withLogs=${withLogs}`)
ws.close()
process.exit(0)
