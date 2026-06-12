import { createZeroDevAdapter } from '../src/benchmark/providers/zerodev'
import { loadConfig } from '../src/benchmark/config'

const config = loadConfig()
const adapter = createZeroDevAdapter('4337-bundler', '')
const client = await adapter.buildAccountClient(config)

try {
  const result = await client.sendSponsored()
  console.log('OK:', result.userOpHash)
} catch(e: any) {
  console.error('ERROR:', e?.message)
  console.error('stack:', e?.stack?.split('\n').slice(0,10).join('\n'))
  let c = e
  let depth = 0
  while (c && depth++ < 5) {
    console.error(`  [cause ${depth}] message:`, c?.message, '| data:', JSON.stringify(c?.data)?.slice(0,200))
    c = c?.cause
  }
}
