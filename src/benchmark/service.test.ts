import { describe, expect, it } from 'bun:test'
import { runBenchmarkGrid, type ProviderEntry } from './service'
import type { Config } from './config'
import type { CanonicalOracle } from './oracle/canonical'
import type { FlashblockOracle } from './oracle/flashblocks'
import type { ProviderAdapter } from './providers/types'
import type { ProviderRow } from './contracts'

// ── Fixtures & mocks ──────────────────────────────────────────────────────────

const CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 3,
  providers: {
    alchemy: { apiKey: 'key', policyId: 'policy', rpcUrl: 'https://alchemy.example.com' },
    pimlico: { apiKey: 'pkey', policyId: 'ppolicy', rpcUrl: 'https://pimlico.example.com' },
    zerodev: null,
  },
  neutral: { rpcUrl: 'https://neutral.example.com', flashblockWsUrl: null },
  timeouts: { submitMs: 5_000, preconfMs: 5_000, canonicalMs: 10_000, receiptMs: 10_000 },
}

const SINGLE_RUN_CONFIG: Config = { ...CONFIG, runCount: 1 }

function makeRow(id: string, protocolClass: '4337-bundler' | 'intent-relay' = '4337-bundler'): ProviderRow {
  return { id, label: id, protocolClass, accountTypeLabel: 'Test Account', requiredEnv: [], runnable: true, missingEnv: [] }
}

let addrCounter = 0
function makeAdapter(id: string, opts?: { failEvery?: boolean; failBuildClient?: boolean }): ProviderAdapter {
  return {
    id,
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Test Account',
    async buildAccountClient(_config) {
      if (opts?.failBuildClient) throw new Error(`${id} build failed`)
      return {
        async sendSponsored() {
          if (opts?.failEvery) throw new Error(`${id} send failed`)
          addrCounter++
          const addr = `0x${addrCounter.toString().padStart(40, '0')}` as `0x${string}`
          return {
            userOpHash: addr,
            protocolClass: '4337-bundler' as const,
            submitMs: 300,
            accountAddress: addr,
          }
        },
      }
    },
  }
}

function makeMockCanonical(blockNumber = 1000n): CanonicalOracle {
  return {
    async getBlockNumber() { return blockNumber },
    async watch() {
      return { status: 'ok', blockNumber, txHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`, tMs: performance.now() + 3000 }
    },
    close() {},
  }
}

const MOCK_FLASHBLOCK: FlashblockOracle = {
  async watch() { return { status: 'not-observed' } },
  close() {},
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runBenchmarkGrid — N runs × M providers', () => {
  it('produces N records per provider (3 runs × 2 providers = 6 total)', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
      { row: makeRow('pimlico-safe'), adapter: makeAdapter('pimlico-safe') },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    expect(results).toHaveLength(2)
    expect(results[0].records).toHaveLength(3)
    expect(results[1].records).toHaveLength(3)
  })

  it('aggregates median/p95 per stage correctly', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const metrics = results[0].metrics
    expect(metrics.runCount).toBe(3)
    expect(metrics.failureCount).toBe(0)
    // All runs had submitMs = 300, so median = 300
    expect(metrics.stages.submit?.median).toBe(300)
    expect(metrics.stages.submit?.count).toBe(3)
  })
})

describe('runBenchmarkGrid — per-provider error isolation', () => {
  it('one provider always fails — the other produces complete results unaffected', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
      { row: makeRow('pimlico-safe'), adapter: makeAdapter('pimlico-safe', { failEvery: true }) },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const alchemyResult = results.find(r => r.row.id === 'alchemy-light-account')!
    const pimlicoResult = results.find(r => r.row.id === 'pimlico-safe')!

    expect(alchemyResult.metrics.failureCount).toBe(0)
    expect(alchemyResult.metrics.runCount).toBe(3)
    expect(pimlicoResult.metrics.failureCount).toBe(3)
    expect(pimlicoResult.metrics.runCount).toBe(3)
    expect(pimlicoResult.metrics.stages.submit).toBeUndefined() // no successful runs
  })

  it('buildAccountClient failure is isolated per-provider', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
      { row: makeRow('pimlico-safe'), adapter: makeAdapter('pimlico-safe', { failBuildClient: true }) },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const alchemyResult = results.find(r => r.row.id === 'alchemy-light-account')!
    const pimlicoResult = results.find(r => r.row.id === 'pimlico-safe')!

    expect(alchemyResult.metrics.failureCount).toBe(0)
    expect(pimlicoResult.metrics.failureCount).toBe(3)
    expect(pimlicoResult.records[0].stages.submit.status).toBe('failed')
  })
})

describe('runBenchmarkGrid — fresh owner per iteration', () => {
  it('account addresses differ across iterations (sendSponsored called fresh each time)', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const addrs = results[0].records.map(r => r.accountAddress)
    const unique = new Set(addrs)
    expect(unique.size).toBe(3) // 3 distinct addresses across 3 iterations
  })
})

describe('runBenchmarkGrid — progress events', () => {
  it('emits iteration-start and iteration-done for each of N iterations', async () => {
    addrCounter = 0
    const events: string[] = []
    await runBenchmarkGrid(
      SINGLE_RUN_CONFIG,
      [{ row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
      e => events.push(e.kind)
    )

    expect(events).toContain('iteration-start')
    expect(events).toContain('iteration-done')
    expect(events).toContain('provider-done')
  })
})
