import { describe, expect, it } from 'bun:test'
import { createFlashblockOracle, type FlashblocksWs, type WsFactory } from './flashblocks'
import { USER_OP_EVENT_TOPIC } from './identity'

// ── Mock WebSocket ────────────────────────────────────────────────────────────

const HASH_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`
const HASH_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`
const TX_A = ('0x' + 'cc'.repeat(32)) as `0x${string}`

class MockWs implements FlashblocksWs {
  readyState = 1 // OPEN
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  sent: string[] = []

  send(data: string) {
    this.sent.push(data)
    // Auto-respond to eth_subscribe with a subscription ID
    const msg = JSON.parse(data)
    if (msg.method === 'eth_subscribe') {
      queueMicrotask(() =>
        this.simulateMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: '0xsub1' }))
      )
    }
  }

  close() {
    this.readyState = 3 // CLOSED
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1
    this.onopen?.({})
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data })
  }

  simulateDisconnect() {
    this.readyState = 3
    this.onclose?.({ code: 1006, reason: 'Connection lost', wasClean: false })
  }

  simulateFlashblock(
    userOpHash: `0x${string}`,
    blockNumber: bigint,
    flashblockIndex: number,
    txHash: `0x${string}`
  ) {
    const blockHex = `0x${blockNumber.toString(16)}`
    // Real schema: merged tx+receipt object — logs top-level, blockNumber camelCase
    this.simulateMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: {
          subscription: '0xsub1',
          result: {
            blockNumber: blockHex,
            transactionIndex: `0x${flashblockIndex.toString(16)}`,
            hash: txHash,
            logs: [
              {
                address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
                topics: [USER_OP_EVENT_TOPIC, userOpHash],
                data: '0x',
                blockNumber: blockHex,
                transactionHash: txHash,
              },
            ],
          },
        },
      })
    )
  }
}

function makeFactory(): { factory: WsFactory; instances: MockWs[] } {
  const instances: MockWs[] = []
  const factory: WsFactory = (_url: string) => {
    const ws = new MockWs()
    instances.push(ws)
    // Simulate connection open on next tick
    queueMicrotask(() => ws.simulateOpen())
    return ws
  }
  return { factory, instances }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('flashblock oracle — happy path', () => {
  it('resolves ok when a matching flashblock message arrives', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const resultPromise = oracle.watch(HASH_A, 5_000)

    // Wait for open + subscribe, then send a flashblock
    await new Promise(r => setTimeout(r, 20))
    instances[0].simulateFlashblock(HASH_A, 9999n, 0, TX_A)

    const result = await resultPromise
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.blockNumber).toBe(9999n)
      expect(result.flashblockIndex).toBe(0)
      expect(result.tMs).toBeGreaterThan(0)
    }
    oracle.close()
  })

  it('resolves two concurrent watches when both land in the same flashblock', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const [rA, rB] = await Promise.all([
      oracle.watch(HASH_A, 5_000),
      oracle.watch(HASH_B, 5_000).then(r => r),
      // After both are registered, send a flashblock containing both hashes
      (async () => {
        await new Promise(r => setTimeout(r, 20))
        // Two separate tx+receipt messages — one per userOp
        instances[0].simulateFlashblock(HASH_A, 10000n, 1, TX_A)
        instances[0].simulateFlashblock(HASH_B, 10000n, 2, ('0x' + 'dd'.repeat(32)) as `0x${string}`)
      })(),
    ])

    expect(rA.status).toBe('ok')
    expect(rB.status).toBe('ok')
    if (rA.status === 'ok' && rB.status === 'ok') {
      expect(rA.blockNumber).toBe(10000n)
      expect(rB.blockNumber).toBe(10000n)
    }
    oracle.close()
  })
})

describe('flashblock oracle — timeout', () => {
  it('resolves not-observed when no flashblock arrives within the window', async () => {
    const { factory } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const result = await oracle.watch(HASH_A, 30)

    expect(result.status).toBe('not-observed')
    oracle.close()
  })
})

describe('flashblock oracle — socket disconnect', () => {
  it('reconnects after disconnect and resubscribes', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const resultPromise = oracle.watch(HASH_A, 5_000)

    // Let first connection establish
    await new Promise(r => setTimeout(r, 20))
    expect(instances).toHaveLength(1)

    // Simulate disconnect
    instances[0].simulateDisconnect()

    // Wait for reconnect
    await new Promise(r => setTimeout(r, 600))

    // Second socket should have been created
    expect(instances.length).toBeGreaterThanOrEqual(2)

    // Send flashblock on the new connection
    const latest = instances.at(-1)!
    latest.simulateFlashblock(HASH_A, 5000n, 0, TX_A)

    const result = await resultPromise
    expect(result.status).toBe('ok')
    oracle.close()
  })

  it('resolves not-observed when oracle is closed during a watch', async () => {
    const { factory } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const resultPromise = oracle.watch(HASH_A, 10_000)
    oracle.close()

    const result = await resultPromise
    expect(result.status).toBe('not-observed')
  })
})

describe('flashblock oracle — lookback cache', () => {
  it('resolves immediately when watch is registered after the flashblock already arrived', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    // Wait for eager connect + subscribe
    await new Promise(r => setTimeout(r, 20))

    // Flashblock arrives BEFORE watch is registered (simulates fast bundler / slow watch setup)
    instances[0].simulateFlashblock(HASH_A, 42n, 0, TX_A)
    await new Promise(r => setTimeout(r, 5))

    // Watch registered after the fact — should hit the lookback cache
    const result = await oracle.watch(HASH_A, 100)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.blockNumber).toBe(42n)
    }
    oracle.close()
  })
})

describe('flashblock oracle — schema tolerance', () => {
  it('resolves not-observed when flashblock payload has no matching userOpHash', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const resultPromise = oracle.watch(HASH_A, 100)
    await new Promise(r => setTimeout(r, 20))

    // Send a flashblock with a different userOpHash
    instances[0].simulateFlashblock(HASH_B, 9999n, 0, TX_A)

    const result = await resultPromise
    expect(result.status).toBe('not-observed') // timeout, not erroring
    oracle.close()
  })

  it('handles flashblock messages with missing metadata gracefully', async () => {
    const { factory, instances } = makeFactory()
    const oracle = createFlashblockOracle('wss://mock', { ws: factory })

    const resultPromise = oracle.watch(HASH_A, 100)
    await new Promise(r => setTimeout(r, 20))

    // Send a flashblock message missing blockNumber — should be silently ignored
    instances[0].simulateMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: {
          subscription: '0xsub1',
          result: { hash: TX_A },  // no blockNumber
        },
      })
    )

    const result = await resultPromise
    expect(result.status).toBe('not-observed')
    oracle.close()
  })
})
