export {}

// Try the flashblock subscription and log the first raw message verbatim
const wsUrl = process.env.NEUTRAL_FLASHBLOCK_WS_URL!
console.log('URL suffix:', wsUrl.split('/v2/')[1]?.slice(-10) ?? wsUrl.slice(-20))

const ws = new WebSocket(wsUrl)
let count = 0

ws.onopen = () => {
  console.log('open — sending newFlashblockTransactions subscribe')
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
}

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  count++
  console.log(`msg ${count}:`, JSON.stringify(msg).slice(0, 500))
  if (count >= 3) { ws.close(); process.exit(0) }
}

ws.onerror = (e) => console.error('error:', e)
setTimeout(() => {
  console.log(`Timed out — got ${count} messages`)
  // Try newPendingTransactions as a sanity check
  const ws2 = new WebSocket(wsUrl)
  ws2.onopen = () => ws2.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newPendingTransactions'] }))
  ws2.onmessage = ({ data }) => { console.log('pendingTx sub response:', JSON.stringify(JSON.parse(data)).slice(0, 200)); ws2.close(); process.exit(0) }
  setTimeout(() => process.exit(0), 5000)
}, 15_000)
