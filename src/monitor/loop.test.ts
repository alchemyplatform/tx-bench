import { describe, expect, it, mock } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics'
import { runOnce, buildAdapterEntries } from './loop'
import type { MonitoringCredentials } from './secrets'
import type { ProviderRunResult } from '../benchmark/service'
import type { Config, EnvSource } from '../benchmark/config'
import type { RunRecord } from '../benchmark/contracts'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CREDENTIALS: MonitoringCredentials = {
  ALCHEMY_API_KEY: 'test-key',
  ALCHEMY_POLICY_ID: 'test-policy',
  OWNER_PRIVATE_KEY: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
}

const REGION = 'us-east-1'

// Provides NETWORK and NEUTRAL_RPC_URL so loadConfig() doesn't fail
const BASE_ENV: EnvSource = {
  NETWORK: 'base-mainnet',
  NEUTRAL_RPC_URL: 'https://mainnet.base.org',
}

function makeMetrics() {
  return buildMetrics(new Registry())
}

function makeProviderResult(
  providerId: string,
  protocolClass: string,
  runCount: number,
  failureCount: number,
  stagesPresent: boolean,
): ProviderRunResult {
  return {
    row: {
      id: providerId,
      label: providerId,
      protocolClass: protocolClass as never,
      accountTypeLabel: 'Test',
      requiredEnv: [],
      runnable: true,
      missingEnv: [],
    },
    records: [],
    metrics: {
      provider: providerId,
      protocolClass: protocolClass as never,
      accountTypeLabel: 'Test',
      runCount,
      failureCount,
      stages: stagesPresent
        ? {
            submit: { median: 100, p95: 200, p99: 250, count: runCount - failureCount },
            canonical: { median: 2000, p95: 3000, p99: 3500, count: runCount - failureCount },
            preconf: undefined,
            providerReceipt: undefined,
          }
        : { submit: undefined, canonical: undefined, preconf: undefined, providerReceipt: undefined },
    },
  }
}

function mockGridRunner(results: ProviderRunResult[]) {
  return mock(async (_config: Config, _env: EnvSource) => results)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runOnce', () => {
  it('sets latency gauges with correct label values for each populated stage', async () => {
    const metrics = makeMetrics()
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', 5, 0, true)]
    const runner = mockGridRunner(results)

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: BASE_ENV })

    expect(runner).toHaveBeenCalledTimes(1)

    const p50Entry = (await metrics.stageLatencyP50.get()).values.find(v =>
      v.labels['provider_id'] === 'alchemy-light-account' &&
      v.labels['stage'] === 'submit' &&
      v.labels['network'] === 'base-mainnet',
    )
    expect(p50Entry?.value).toBe(100)

    const p95Entry = (await metrics.stageLatencyP95.get()).values.find(v =>
      v.labels['stage'] === 'submit',
    )
    expect(p95Entry?.value).toBe(200)

    const p99Entry = (await metrics.stageLatencyP99.get()).values.find(v =>
      v.labels['stage'] === 'submit',
    )
    expect(p99Entry?.value).toBe(250)
  })

  it('sets success rate, sample count, and failure count gauges', async () => {
    const metrics = makeMetrics()
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', 10, 2, true)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const rateEntry = (await metrics.successRate.get()).values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    expect(rateEntry?.value).toBe(0.8)

    const countEntry = (await metrics.sampleCount.get()).values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    expect(countEntry?.value).toBe(10)

    const failEntry = (await metrics.failureCount.get()).values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    expect(failEntry?.value).toBe(2)
  })

  it('sets last_run_timestamp_unix after a successful run', async () => {
    const metrics = makeMetrics()
    const before = Date.now() / 1000
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', 5, 0, true)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })
    const after = Date.now() / 1000

    const tsEntry = (await metrics.lastRunTimestampUnix.get()).values.find(v =>
      v.labels['provider_id'] === 'alchemy-light-account',
    )
    expect(tsEntry?.value).toBeGreaterThanOrEqual(before)
    expect(tsEntry?.value).toBeLessThanOrEqual(after)
  })

  it('does not set latency gauges when all samples failed (no zero-inflation)', async () => {
    const metrics = makeMetrics()
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', 5, 5, false)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const p50Values = (await metrics.stageLatencyP50.get()).values
    expect(p50Values).toHaveLength(0)
  })

  it('accurately sets failure_count for a provider with some failures', async () => {
    const metrics = makeMetrics()
    const results = [makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', 20, 3, true)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const failEntry = (await metrics.failureCount.get()).values.find(v =>
      v.labels['provider_id'] === 'alchemy-wallet-sendcalls',
    )
    expect(failEntry?.value).toBe(3)
  })

  it('sets gauges for two providers independently', async () => {
    const metrics = makeMetrics()
    const results = [
      makeProviderResult('alchemy-light-account', '4337-bundler', 5, 0, true),
      makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', 5, 0, true),
    ]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const p50Values = (await metrics.stageLatencyP50.get()).values
    const providers = new Set(p50Values.map(v => v.labels['provider_id']))
    expect(providers.has('alchemy-light-account')).toBe(true)
    expect(providers.has('alchemy-wallet-sendcalls')).toBe(true)
  })

  it('catches and logs errors from the grid runner without rethrowing', async () => {
    const metrics = makeMetrics()
    const errorRunner = mock(async () => { throw new Error('bundler offline') })
    await expect(
      runOnce(CREDENTIALS, metrics, REGION, { gridRunner: errorRunner as never, baseEnv: BASE_ENV })
    ).resolves.toBeUndefined()
  })

  it('passes NETWORK env var through to loadConfig (not hardcoded)', async () => {
    const metrics = makeMetrics()
    const capturedConfigs: Config[] = []
    const capturingRunner = mock(async (config: Config) => {
      capturedConfigs.push(config)
      return []
    })
    const env: EnvSource = { ...BASE_ENV, NETWORK: 'eth-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: capturingRunner as never, baseEnv: env })
    expect(capturedConfigs[0]?.network).toBe('eth-mainnet')
  })

  it('runs a single network when NETWORKS is absent (backward compatible)', async () => {
    const metrics = makeMetrics()
    const runner = mockGridRunner([])
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: BASE_ENV })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('runs every network listed in NETWORKS, once each', async () => {
    const metrics = makeMetrics()
    const seenNetworks: string[] = []
    const runner = mock(async (config: Config) => {
      seenNetworks.push(config.network)
      return []
    })
    const env: EnvSource = { NETWORKS: 'eth-mainnet,base-mainnet,opt-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })

    expect(runner).toHaveBeenCalledTimes(3)
    expect(seenNetworks.sort()).toEqual(['base-mainnet', 'eth-mainnet', 'opt-mainnet'])
  })

  it('pushes gauges labeled with each network independently', async () => {
    const metrics = makeMetrics()
    const runner = mock(async (config: Config) => [
      makeProviderResult(`provider-${config.network}`, '4337-bundler', 5, 0, true),
    ])
    const env: EnvSource = { NETWORKS: 'eth-mainnet,base-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })

    const p50Values = (await metrics.stageLatencyP50.get()).values
    const networks = new Set(p50Values.map(v => v.labels['network']))
    expect(networks.has('eth-mainnet')).toBe(true)
    expect(networks.has('base-mainnet')).toBe(true)
  })

  it('one network failing does not prevent other networks from completing', async () => {
    const metrics = makeMetrics()
    const runner = mock(async (config: Config) => {
      if (config.network === 'eth-mainnet') throw new Error('eth rpc down')
      return [makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', 5, 0, true)]
    })
    const env: EnvSource = { NETWORKS: 'eth-mainnet,base-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })

    const p50Values = (await metrics.stageLatencyP50.get()).values
    expect(p50Values.some(v => v.labels['network'] === 'base-mainnet')).toBe(true)
    expect(p50Values.some(v => v.labels['network'] === 'eth-mainnet')).toBe(false)
  })

  it('defaults the neutral RPC to the Alchemy chain URL when none is configured (Alchemy-only monitoring)', async () => {
    const metrics = makeMetrics()
    const capturedEnvs: EnvSource[] = []
    const runner = mock(async (_config: Config, env: EnvSource) => {
      capturedEnvs.push(env)
      return []
    })
    // No NEUTRAL_RPC_URL anywhere — falls back to the Alchemy chain URL built
    // from the credentials (allowed by preflight when all runnable are Alchemy).
    const env: EnvSource = { NETWORKS: 'eth-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })
    expect(capturedEnvs[0]?.NEUTRAL_RPC_URL).toBe('https://eth-mainnet.g.alchemy.com/v2/test-key')
  })

  it('prefers a per-network NEUTRAL_RPC_URLS override from credentials over the built-in default', async () => {
    const metrics = makeMetrics()
    const capturedEnvs: EnvSource[] = []
    const runner = mock(async (_config: Config, env: EnvSource) => {
      capturedEnvs.push(env)
      return []
    })
    const credsWithOverride: MonitoringCredentials = {
      ...CREDENTIALS,
      NEUTRAL_RPC_URLS: { 'eth-mainnet': 'https://custom-eth.example.com' },
    }
    const env: EnvSource = { NETWORKS: 'eth-mainnet' }

    await runOnce(credsWithOverride, metrics, REGION, { gridRunner: runner as never, baseEnv: env })
    expect(capturedEnvs[0]?.NEUTRAL_RPC_URL).toBe('https://custom-eth.example.com')
  })

  it('logs a run_start event with network, region, run_count, and runnable providers before the run', async () => {
    const metrics = makeMetrics()
    const runner = mockGridRunner([])
    // Alchemy + BSO configured → both monitored adapters are runnable.
    const env: EnvSource = {
      NETWORK: 'base-mainnet',
      NEUTRAL_RPC_URL: 'https://mainnet.base.org',
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      ALCHEMY_BSO_POLICY_ID: 'bso-p',
      OWNER_PRIVATE_KEY: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    }

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
    try {
      await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })
    } finally {
      console.log = origLog
    }

    const start = logs.find(l => l.includes('"event":"run_start"'))
    expect(start).toBeDefined()
    expect(start).toContain('"network":"base-mainnet"')
    expect(start).toContain('"region":"us-east-1"')
    expect(start).toContain('"run_count":20')
    expect(start).toContain('alchemy-mav2-bso')
    expect(start).toContain('alchemy-wallet-sendcalls')
    // run_start is emitted before run_complete
    expect(logs.findIndex(l => l.includes('"event":"run_start"')))
      .toBeLessThan(logs.findIndex(l => l.includes('"event":"run_complete"')))
  })

  it('logs a provider_summary and a run_failed event with the redacted reason when a run fails', async () => {
    const metrics = makeMetrics()
    const failedRecord: RunRecord = {
      provider: 'alchemy-mav2-bso',
      runIndex: 0,
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Modular Account v2 (BSO)',
      accountAddress: '0x' + '00'.repeat(20) as `0x${string}`,
      userOpHash: '0x' + '00'.repeat(32) as `0x${string}`,
      stages: {
        submit: { status: 'failed', reason: 'Policy does not support bundler sponsorship' },
        preconf: { status: 'not-observed' },
        canonical: { status: 'not-observed' },
        providerReceipt: { status: 'not-observed' },
      },
      error: 'Policy does not support bundler sponsorship',
    }
    const result: ProviderRunResult = {
      row: {
        id: 'alchemy-mav2-bso',
        label: 'Alchemy (MAv2 BSO)',
        protocolClass: '4337-bundler',
        accountTypeLabel: 'Modular Account v2 (BSO)',
        requiredEnv: [],
        runnable: true,
        missingEnv: [],
      },
      records: [failedRecord],
      metrics: {
        provider: 'alchemy-mav2-bso',
        protocolClass: '4337-bundler',
        accountTypeLabel: 'Modular Account v2 (BSO)',
        runCount: 1,
        failureCount: 1,
        stages: { submit: undefined, preconf: undefined, canonical: undefined, providerReceipt: undefined },
      },
    }
    const runner = mockGridRunner([result])

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
    try {
      await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: BASE_ENV })
    } finally {
      console.log = origLog
    }

    const summary = logs.find(l => l.includes('"event":"provider_summary"') && l.includes('alchemy-mav2-bso'))
    expect(summary).toBeDefined()
    expect(summary).toContain('"failure_count":1')
    expect(summary).toContain('"success_rate":0')

    const failed = logs.find(l => l.includes('"event":"run_failed"'))
    expect(failed).toBeDefined()
    expect(failed).toContain('"provider":"alchemy-mav2-bso"')
    expect(failed).toContain('"stage":"submit"')
    expect(failed).toContain('"status":"failed"')
    expect(failed).toContain('Policy does not support bundler sponsorship')
  })
})

describe('buildAdapterEntries', () => {
  it('includes only alchemy-mav2-bso and alchemy-wallet-sendcalls when fully configured', () => {
    const env: EnvSource = {
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      ALCHEMY_BSO_POLICY_ID: 'bso-p',
    }
    const entries = buildAdapterEntries(env)
    const ids = entries.map(e => e.row.id).sort()
    expect(ids).toEqual(['alchemy-mav2-bso', 'alchemy-wallet-sendcalls'])
  })

  it('excludes alchemy-mav2-bso when ALCHEMY_BSO_POLICY_ID is absent', () => {
    const env: EnvSource = { ALCHEMY_API_KEY: 'k', ALCHEMY_POLICY_ID: 'p' }
    const entries = buildAdapterEntries(env)
    const ids = entries.map(e => e.row.id)
    expect(ids).not.toContain('alchemy-mav2-bso')
    expect(ids).toContain('alchemy-wallet-sendcalls')
  })

  it('never includes non-target adapters even when their env vars are present', () => {
    const env: EnvSource = {
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      ALCHEMY_BSO_POLICY_ID: 'bso-p',
      PIMLICO_API_KEY: 'pk',
      PIMLICO_POLICY_ID: 'pp',
      ZERODEV_API_KEY: 'zk',
      ZERODEV_PROJECT_ID: 'zp',
    }
    const entries = buildAdapterEntries(env)
    const ids = entries.map(e => e.row.id)
    expect(ids).not.toContain('pimlico-safe')
    expect(ids).not.toContain('zerodev-kernel')
    expect(ids).not.toContain('zerodev-ultrarelay')
    expect(ids).not.toContain('alchemy-light-account')
    expect(ids).not.toContain('alchemy-modular-account-v2')
  })
})
