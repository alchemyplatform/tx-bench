import { describe, expect, it, mock } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics'
import { runOnce, buildAdapterEntries } from './loop'
import type { MonitoringCredentials } from './secrets'
import type { ProviderRunResult } from '../benchmark/service'
import type { Config, EnvSource } from '../benchmark/config'

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
