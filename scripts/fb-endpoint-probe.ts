export {}

// Try multiple endpoint variants to find which one reliably streams flashblock data
const APIKEY = process.env.NEUTRAL_FLASHBLOCK_WS_URL!.split('/v2/')[1]!

const candidates = [
  `wss://base-mainnet.g.alchemy.com/v2/${APIKEY}`,
  `wss://base-mainnet.g.alchemy.com/v2/${APIKEY}/flashblocks`,
]

for (const url of candidates) {
  const label = url.replace(APIKEY, '[KEY]')
  console.log(`\nTrying: ${label}`)
  const result = await new Promise<string>(resolve => {
    const ws = new WebSocket(url)
    let count = 0
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] }))
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      if (msg.result) { console.log('  subscribed'); return }
      if (msg.method !== 'eth_subscription') return
      count++
      const r = msg.params?.result
      if (count === 1) console.log('  first msg keys:', Object.keys(r ?? {}).slice(0, 6).join(', '))
    }
    ws.onerror = (e) => { resolve(`error: ${e}`); }
    setTimeout(() => { resolve(`${count} msgs in 8s`); ws.close() }, 8_000)
  })
  console.log(' ->', result)
}
process.exit(0)
