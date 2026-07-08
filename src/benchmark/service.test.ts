import { describe, expect, it } from 'bun:test'
import { runBenchmarkGrid, type ProviderEntry } from './service'
import type { Config } from './config'
import type { CanonicalOracle } from './oracle/canonical'
import type { FlashblockOracle } from './oracle/flashblocks'
import type { ProviderAdapter } from './providers/types'
import type { AccountClient } from './providers/types'
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
function makeAdapter(id: string, opts?: {
  failEvery?: boolean
  failBuildClient?: boolean
  ensureDeployed?: () => Promise<void>
  failEnsureDeployed?: boolean
}): ProviderAdapter {
  return {
    id,
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Test Account',
    async buildAccountClient(_config) {
      if (opts?.failBuildClient) throw new Error(`${id} build failed`)
      const client: AccountClient = {
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
      if (opts?.ensureDeployed) {
        client.ensureDeployed = opts.ensureDeployed
      } else if (opts?.failEnsureDeployed) {
        client.ensureDeployed = async () => { throw new Error(`${id} bootstrap failed`) }
      }
      return client
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

describe('runBenchmarkGrid — ensureDeployed bootstrap', () => {
  it('calls ensureDeployed exactly once before the timed loop', async () => {
    addrCounter = 0
    let deployCallCount = 0
    let sendSponsoredCallOrder: number[] = []
    let deployCallOrder = 0
    const providers: ProviderEntry[] = [
      {
        row: makeRow('alchemy-mav2-bso'),
        adapter: makeAdapter('alchemy-mav2-bso', {
          ensureDeployed: async () => {
            deployCallCount++
            deployCallOrder = addrCounter // capture addrCounter before any sendSponsored
          },
        }),
      },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    expect(deployCallCount).toBe(1)
    expect(results[0].records).toHaveLength(3)
    // ensureDeployed was called before any sendSponsored (addrCounter was 0 at deploy time)
    expect(deployCallOrder).toBe(0)
    expect(results[0].metrics.runCount).toBe(3)
  })

  it('skips ensureDeployed when the client does not expose it', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    // Runs normally — no ensureDeployed on the client, so it was skipped
    expect(results[0].records).toHaveLength(3)
    expect(results[0].metrics.failureCount).toBe(0)
    expect(results[0].metrics.runCount).toBe(3)
  })

  it('ensureDeployed failure records all iterations as failures with the bootstrap error message', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      { row: makeRow('alchemy-mav2-bso'), adapter: makeAdapter('alchemy-mav2-bso', { failEnsureDeployed: true }) },
      { row: makeRow('alchemy-light-account'), adapter: makeAdapter('alchemy-light-account') },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const bsoResult = results.find(r => r.row.id === 'alchemy-mav2-bso')!
    const otherResult = results.find(r => r.row.id === 'alchemy-light-account')!

    // BSO: all iterations failed with the bootstrap error message
    expect(bsoResult.metrics.failureCount).toBe(3)
    expect(bsoResult.metrics.runCount).toBe(3)
    expect(bsoResult.records[0].stages.submit.status).toBe('failed')
    expect(bsoResult.records[0].error).toContain('bootstrap failed')
    expect(bsoResult.records[1].error).toContain('bootstrap failed')
    expect(bsoResult.records[2].error).toContain('bootstrap failed')

    // Other provider: unaffected
    expect(otherResult.metrics.failureCount).toBe(0)
    expect(otherResult.metrics.runCount).toBe(3)
  })

  it('bootstrap is not counted in any stage metric or runCount', async () => {
    addrCounter = 0
    const providers: ProviderEntry[] = [
      {
        row: makeRow('alchemy-mav2-bso'),
        adapter: makeAdapter('alchemy-mav2-bso', {
          ensureDeployed: async () => {
            // Simulate some time passing during bootstrap
            await new Promise(r => setTimeout(r, 10))
          },
        }),
      },
    ]

    const results = await runBenchmarkGrid(CONFIG, providers, makeMockCanonical(), MOCK_FLASHBLOCK)

    const metrics = results[0].metrics
    // runCount should be the configured value, not include bootstrap
    expect(metrics.runCount).toBe(CONFIG.runCount)
    expect(metrics.failureCount).toBe(0)
    // All submit times should be the mock value (300ms), not inflated by bootstrap
    expect(metrics.stages.submit?.median).toBe(300)
    expect(metrics.stages.submit?.count).toBe(3)
  })
})

// ── Private-key redaction in error paths (U7, R10) ────────────────────────────

const TEST_OWNER_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const TEST_BARE_KEY = TEST_OWNER_KEY.slice(2)

const CONFIG_WITH_KEY: Config = {
  ...CONFIG,
  ownerPrivateKey: TEST_OWNER_KEY,
}

describe('runBenchmarkGrid — private-key redaction in errors', () => {
  it('redacts owner private key from bootstrap (ensureDeployed) failure errors', async () => {
    const providers: ProviderEntry[] = [
      {
        row: makeRow('alchemy-mav2-bso'),
        adapter: makeAdapter('alchemy-mav2-bso', {
          failEnsureDeployed: true,
        }),
      },
    ]
    // Override the ensureDeployed to throw an error containing the key
    const customAdapter: ProviderAdapter = {
      id: 'alchemy-mav2-bso',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Test Account',
      async buildAccountClient() {
        return {
          async sendSponsored() {
            return {
              userOpHash: '0x' as `0x${string}`,
              protocolClass: '4337-bundler' as const,
              submitMs: 100,
              accountAddress: '0x' as `0x${string}`,
            }
          },
          async ensureDeployed() {
            throw new Error(`Bootstrap failed: key ${TEST_OWNER_KEY} rejected`)
          },
        }
      },
    }

    const results = await runBenchmarkGrid(
      { ...CONFIG_WITH_KEY, runCount: 2 },
      [{ row: makeRow('alchemy-mav2-bso'), adapter: customAdapter }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
    )

    for (const record of results[0].records) {
      expect(record.error).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
      expect(record.error).not.toContain(TEST_OWNER_KEY)
      expect(record.error).not.toContain(TEST_BARE_KEY)
      // The redacted form should appear where the key was
      expect(record.stages.submit.reason).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    }
  })

  it('redacts owner private key from timed sendSponsored failure errors', async () => {
    const failAdapter: ProviderAdapter = {
      id: 'test-fail',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Test Account',
      async buildAccountClient() {
        return {
          async sendSponsored() {
            throw new Error(`sendCalls rejected: invalid key ${TEST_OWNER_KEY}`)
          },
        }
      },
    }

    const results = await runBenchmarkGrid(
      { ...CONFIG_WITH_KEY, runCount: 2 },
      [{ row: makeRow('test-fail'), adapter: failAdapter }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
    )

    for (const record of results[0].records) {
      expect(record.error).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
      expect(record.error).not.toContain(TEST_OWNER_KEY)
      expect(record.error).not.toContain(TEST_BARE_KEY)
    }
  })

  it('redacts bare (non-0x) key form from error messages', async () => {
    const failAdapter: ProviderAdapter = {
      id: 'test-bare',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Test Account',
      async buildAccountClient() {
        return {
          async sendSponsored() {
            throw new Error(`InvalidPrivateKeyError: key=${TEST_BARE_KEY} is not valid`)
          },
        }
      },
    }

    const results = await runBenchmarkGrid(
      { ...CONFIG_WITH_KEY, runCount: 1 },
      [{ row: makeRow('test-bare'), adapter: failAdapter }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
    )

    const record = results[0].records[0]
    expect(record.error).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(record.error).not.toContain(TEST_BARE_KEY)
    expect(record.error).not.toContain(TEST_OWNER_KEY)
  })

  it('does not add redaction placeholder when ownerPrivateKey is unset', async () => {
    const failAdapter: ProviderAdapter = {
      id: 'test-no-key',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Test Account',
      async buildAccountClient() {
        return {
          async sendSponsored() {
            throw new Error('bundler rejected: gas limit too low')
          },
        }
      },
    }

    const results = await runBenchmarkGrid(
      SINGLE_RUN_CONFIG, // CONFIG without ownerPrivateKey
      [{ row: makeRow('test-no-key'), adapter: failAdapter }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
    )

    const record = results[0].records[0]
    expect(record.error).toBe('bundler rejected: gas limit too low')
    expect(record.error).not.toContain('[REDACTED')
  })

  it('redacts from buildAccountClient failure errors too', async () => {
    const failBuildAdapter: ProviderAdapter = {
      id: 'test-build-fail',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Test Account',
      async buildAccountClient() {
        throw new Error(`config error: key ${TEST_OWNER_KEY} not found in env`)
      },
    }

    const results = await runBenchmarkGrid(
      { ...CONFIG_WITH_KEY, runCount: 2 },
      [{ row: makeRow('test-build-fail'), adapter: failBuildAdapter }],
      makeMockCanonical(),
      MOCK_FLASHBLOCK,
    )

    for (const record of results[0].records) {
      expect(record.error).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
      expect(record.error).not.toContain(TEST_OWNER_KEY)
      expect(record.error).not.toContain(TEST_BARE_KEY)
    }
  })
})
