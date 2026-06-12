export {}

// Test what this WS actually streams
const wsUrl = process.env.NEUTRAL_FLASHBLOCK_WS_URL!

console.log('Endpoint:', wsUrl.replace(/\/v2\/[^?]+/, '/v2/[REDACTED]'))
const ws = new WebSocket(wsUrl)
let count = 0

ws.onopen = () => {
  // Try newHeads — if this streams, the WS itself works
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }))
}
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (count === 0) console.log('First message:', JSON.stringify(msg).slice(0, 300))
  count++
  if (count === 3) { console.log(`Got ${count} messages — WS is live`); ws.close(); process.exit(0) }
}
ws.onerror = (e) => { console.error('Error:', e) }
setTimeout(() => { console.log(`Timed out after 10s, got ${count} messages`); ws.close(); process.exit(0) }, 10_000)
