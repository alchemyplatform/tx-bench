import { describe, expect, it } from 'bun:test'
import { createCanonicalOracle, type CanonicalClient } from './canonical'
import { USER_OP_EVENT_TOPIC } from './identity'

// ── Mock helpers ──────────────────────────────────────────────────────────────

const HASH_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`
const HASH_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`
const TX_A = ('0x' + 'cc'.repeat(32)) as `0x${string}`
const BLOCK_HASH = ('0x' + 'ee'.repeat(32)) as `0x${string}`
const BLOCK_N = 1000n

function makeLog(userOpHash: `0x${string}`, blockNumber: bigint, txHash: `0x${string}`) {
  return {
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as `0x${string}`,
    topics: [USER_OP_EVENT_TOPIC, userOpHash] as [`0x${string}`, `0x${string}`],
    data: '0x' as `0x${string}`,
    blockNumber,
    transactionHash: txHash,
    blockHash: BLOCK_HASH,
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
  }
}

type MockClientConfig = {
  currentBlock?: bigint
  logsByBlock?: Map<bigint, ReturnType<typeof makeLog>[]>
  // Override receipt for integrity testing
  receiptOverride?: {
    blockNumber?: bigint
    blockHash?: `0x${string}`
    status?: 'success' | 'reverted'
  }
}

function makeMockClient(cfg: MockClientConfig = {}): CanonicalClient {
  let block = cfg.currentBlock ?? BLOCK_N
  const logMap = cfg.logsByBlock ?? new Map<bigint, ReturnType<typeof makeLog>[]>()

  return {
    async getBlockNumber() {
      return block++  // increment each call to simulate advancing chain
    },
    async getLogs({ fromBlock, toBlock }) {
      const results: ReturnType<typeof makeLog>[] = []
      for (let b = fromBlock; b <= toBlock; b++) {
        const logs = logMap.get(b)
        if (logs) results.push(...logs)
      }
      return results as ReturnType<typeof makeLog>[]
    },
    async getTransactionReceipt({ hash }) {
      // Find the log that matches this tx
      for (const logs of logMap.values()) {
        for (const log of logs) {
          if (log.transactionHash === hash) {
            return {
              blockNumber: cfg.receiptOverride?.blockNumber ?? log.blockNumber,
              blockHash: cfg.receiptOverride?.blockHash ?? (log.blockHash as `0x${string}`),
              status: cfg.receiptOverride?.status ?? ('success' as const),
            }
          }
        }
      }
      throw new Error(`receipt not found for ${hash}`)
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('canonical oracle — happy path', () => {
  it('resolves ok when a matching UserOperationEvent log is found', async () => {
    const logMap = new Map([[BLOCK_N, [makeLog(HASH_A, BLOCK_N, TX_A)]]])
    const client = makeMockClient({ currentBlock: BLOCK_N, logsByBlock: logMap })
    const oracle = createCanonicalOracle(client, 10)

    const result = await oracle.watch(HASH_A, BLOCK_N, 5_000)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.blockNumber).toBe(BLOCK_N)
      expect(result.txHash).toBe(TX_A)
      expect(result.tMs).toBeGreaterThan(0)
    }
    oracle.close()
  })

  it('records block position (blockNumber) as primary finish line', async () => {
    const logMap = new Map([[BLOCK_N + 3n, [makeLog(HASH_A, BLOCK_N + 3n, TX_A)]]])
    const client = makeMockClient({ currentBlock: BLOCK_N, logsByBlock: logMap })
    const oracle = createCanonicalOracle(client, 10)

    const result = await oracle.watch(HASH_A, BLOCK_N, 5_000)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.blockNumber).toBe(BLOCK_N + 3n)
    }
    oracle.close()
  })
})

describe('canonical oracle — concurrent watches', () => {
  it('resolves two userOps landing in the same block independently', async () => {
    const logMap = new Map([
      [BLOCK_N, [makeLog(HASH_A, BLOCK_N, TX_A), makeLog(HASH_B, BLOCK_N, ('0x' + 'dd'.repeat(32)) as `0x${string}`)]],
    ])
    const client = makeMockClient({ currentBlock: BLOCK_N, logsByBlock: logMap })
    const oracle = createCanonicalOracle(client, 10)

    const [rA, rB] = await Promise.all([
      oracle.watch(HASH_A, BLOCK_N, 5_000),
      oracle.watch(HASH_B, BLOCK_N, 5_000),
    ])

    expect(rA.status).toBe('ok')
    expect(rB.status).toBe('ok')
    if (rA.status === 'ok' && rB.status === 'ok') {
      // Both land in same block — tie surfaced by equal block positions
      expect(rA.blockNumber).toBe(rB.blockNumber)
    }
    oracle.close()
  })
})

describe('canonical oracle — timeout', () => {
  it('resolves timed-out when no log is found within the window', async () => {
    const client = makeMockClient({ currentBlock: BLOCK_N, logsByBlock: new Map() })
    const oracle = createCanonicalOracle(client, 5)

    const result = await oracle.watch(HASH_A, BLOCK_N, 50)  // very short timeout

    expect(result.status).toBe('timed-out')
    oracle.close()
  })
})

describe('canonical oracle — integrity cross-validation', () => {
  it('rejects inclusion when receipt block number disagrees with log block number', async () => {
    const logMap = new Map([[BLOCK_N, [makeLog(HASH_A, BLOCK_N, TX_A)]]])
    const client = makeMockClient({
      currentBlock: BLOCK_N,
      logsByBlock: logMap,
      receiptOverride: { blockNumber: BLOCK_N + 999n }, // different block — misbehaving node
    })
    const oracle = createCanonicalOracle(client, 10)

    const result = await oracle.watch(HASH_A, BLOCK_N, 5_000)

    expect(result.status).toBe('integrity-fail')
    if (result.status === 'integrity-fail') {
      expect(result.reason).toContain('mismatch')
    }
    oracle.close()
  })

  it('rejects inclusion when receipt blockHash disagrees with log blockHash', async () => {
    const logMap = new Map([[BLOCK_N, [makeLog(HASH_A, BLOCK_N, TX_A)]]])
    const client = makeMockClient({
      currentBlock: BLOCK_N,
      logsByBlock: logMap,
      receiptOverride: { blockHash: ('0x' + 'ff'.repeat(32)) as `0x${string}` }, // reorg indicator
    })
    const oracle = createCanonicalOracle(client, 10)

    const result = await oracle.watch(HASH_A, BLOCK_N, 5_000)

    expect(result.status).toBe('integrity-fail')
    if (result.status === 'integrity-fail') {
      expect(result.reason).toContain('reorg')
    }
    oracle.close()
  })
})

describe('canonical oracle — close', () => {
  it('resolves all pending watches as timed-out on close()', async () => {
    const client = makeMockClient({ currentBlock: BLOCK_N, logsByBlock: new Map() })
    const oracle = createCanonicalOracle(client, 100)

    // Start a watch but immediately close
    const resultPromise = oracle.watch(HASH_A, BLOCK_N, 60_000)
    oracle.close()

    const result = await resultPromise
    expect(result.status).toBe('timed-out')
  })
})
