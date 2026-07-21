import { describe, expect, it, mock } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics'
import { runOnce, buildAdapterEntries, computeRegionalStartDelayMs, startLoop } from './loop'
import type { MonitoringCredentials } from './secrets'
import type { ProviderRunResult } from '../benchmark/service'
import type { Config, EnvSource } from '../benchmark/config'
import type { RunRecord, Stage } from '../benchmark/contracts'

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

// A successful RunRecord with the given per-stage latencies (in ms). Only the
// stages named here are populated; others default to not-observed.
function makeRecord(
  provider: string,
  protocolClass: RunRecord['protocolClass'],
  stageMs: Partial<Record<keyof RunRecord['stages'], number>>,
  runIndex = 0,
): RunRecord {
  const notObserved: Stage = { status: 'not-observed' }
  const mk = (ms: number): Stage => ({ status: 'ok', ms })
  return {
    provider,
    runIndex,
    protocolClass,
    accountTypeLabel: 'Test',
    accountAddress: ('0x' + '00'.repeat(20)) as `0x${string}`,
    userOpHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
    stages: {
      submit: stageMs.submit != null ? mk(stageMs.submit) : notObserved,
      preconf: stageMs.preconf != null ? mk(stageMs.preconf) : notObserved,
      canonical: stageMs.canonical != null ? mk(stageMs.canonical) : notObserved,
      providerReceipt: stageMs.providerReceipt != null ? mk(stageMs.providerReceipt) : notObserved,
      ...(stageMs.prepare != null && { prepare: mk(stageMs.prepare) }),
      ...(stageMs.send != null && { send: mk(stageMs.send) }),
    },
    blockPositions: {},
    error: undefined,
  }
}

// A failed RunRecord (submit failed) — excluded from the histogram but counted
// in attempts/failures counters.
function makeFailedRecord(
  provider: string,
  protocolClass: RunRecord['protocolClass'],
  runIndex = 0,
): RunRecord {
  const notObserved: Stage = { status: 'not-observed' }
  return {
    provider,
    runIndex,
    protocolClass,
    accountTypeLabel: 'Test',
    accountAddress: ('0x' + '00'.repeat(20)) as `0x${string}`,
    userOpHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
    stages: {
      submit: { status: 'failed', reason: 'bundler offline' },
      preconf: notObserved,
      canonical: notObserved,
      providerReceipt: notObserved,
    },
    blockPositions: {},
    error: 'bundler offline',
  }
}

function makeProviderResult(
  providerId: string,
  protocolClass: string,
  records: RunRecord[],
  failureCount = records.filter(r => r.error || r.stages.submit.status !== 'ok').length,
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
    records,
    metrics: {
      provider: providerId,
      protocolClass: protocolClass as never,
      accountTypeLabel: 'Test',
      runCount: records.length,
      failureCount,
      // `pm.stages` is only consumed by logRunResults now; emitRunMetrics reads
      // records directly. Keep it empty/undefined to prove emitRunMetrics does not
      // depend on pre-aggregated stage metrics.
      stages: { submit: undefined, preconf: undefined, canonical: undefined, providerReceipt: undefined },
    },
  }
}

function mockGridRunner(results: ProviderRunResult[]) {
  return mock(async (_config: Config, _env: EnvSource) => results)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runOnce', () => {
  it('observes per-attempt stage latencies into the histogram with correct labels', async () => {
    const metrics = makeMetrics()
    const records = [
      makeRecord('alchemy-light-account', '4337-bundler', { submit: 100, canonical: 2000 }, 0),
      makeRecord('alchemy-light-account', '4337-bundler', { submit: 150, canonical: 2100 }, 1),
    ]
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', records, 0)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const agg = await metrics.stageLatency.get()
    const submitCount = agg.values.find(v =>
      v.metricName === 'txe_bench_stage_latency_seconds_count' &&
      v.labels['provider_id'] === 'alchemy-light-account' &&
      v.labels['stage'] === 'submit',
    )
    const submitSum = agg.values.find(v =>
      v.metricName === 'txe_bench_stage_latency_seconds_sum' &&
      v.labels['stage'] === 'submit',
    )
    expect(submitCount?.value).toBe(2)
    // ms → seconds: (100 + 150) / 1000 = 0.25
    expect(submitSum?.value).toBeCloseTo(0.25, 6)

    const canonicalSum = agg.values.find(v =>
      v.metricName === 'txe_bench_stage_latency_seconds_sum' &&
      v.labels['stage'] === 'canonical',
    )
    expect(canonicalSum?.value).toBeCloseTo(4.1, 6)
  })

  it('increments attempts and failures counters cumulatively', async () => {
    const metrics = makeMetrics()
    const records = [
      makeRecord('alchemy-light-account', '4337-bundler', { submit: 100 }, 0),
      makeFailedRecord('alchemy-light-account', '4337-bundler', 1),
    ]
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', records, 1)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const attempts = await metrics.attemptsTotal.get()
    const failures = await metrics.failuresTotal.get()
    const a = attempts.values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    const f = failures.values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    expect(a?.value).toBe(2)
    expect(f?.value).toBe(1)
  })

  it('sets last_run_timestamp_unix after a successful run', async () => {
    const metrics = makeMetrics()
    const before = Date.now() / 1000
    const records = [makeRecord('alchemy-light-account', '4337-bundler', { submit: 100 }, 0)]
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', records, 0)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })
    const after = Date.now() / 1000

    const tsEntry = (await metrics.lastRunTimestampUnix.get()).values.find(v =>
      v.labels['provider_id'] === 'alchemy-light-account',
    )
    expect(tsEntry?.value).toBeGreaterThanOrEqual(before)
    expect(tsEntry?.value).toBeLessThanOrEqual(after)
  })

  it('does not observe latency when all samples failed (no zero-inflation)', async () => {
    const metrics = makeMetrics()
    const records = [makeFailedRecord('alchemy-light-account', '4337-bundler', 0)]
    const results = [makeProviderResult('alchemy-light-account', '4337-bundler', records, 1)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const agg = await metrics.stageLatency.get()
    expect(agg.values).toHaveLength(0)
    // failures counter still increments
    const f = (await metrics.failuresTotal.get()).values.find(v => v.labels['provider_id'] === 'alchemy-light-account')
    expect(f?.value).toBe(1)
  })

  it('excludes failed/errored attempts from the histogram but counts them in failures', async () => {
    const metrics = makeMetrics()
    const records = [
      makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', { submit: 80, canonical: 1500 }, 0),
      makeFailedRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', 1), // errored
      // submit status not ok without an error string:
      (() => {
        const notObserved: Stage = { status: 'not-observed' }
        return {
          ...makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', {}, 2),
          stages: {
            submit: { status: 'timed-out', reason: 'timeout' },
            preconf: notObserved,
            canonical: notObserved,
            providerReceipt: notObserved,
          },
        } as RunRecord
      })(),
    ]
    const results = [makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', records, 2)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const agg = await metrics.stageLatency.get()
    const submitCount = agg.values.find(v =>
      v.metricName === 'txe_bench_stage_latency_seconds_count' && v.labels['stage'] === 'submit',
    )
    // Only the first record was successful → 1 observation
    expect(submitCount?.value).toBe(1)

    const f = (await metrics.failuresTotal.get()).values.find(v => v.labels['provider_id'] === 'alchemy-wallet-sendcalls')
    expect(f?.value).toBe(2)
    const a = (await metrics.attemptsTotal.get()).values.find(v => v.labels['provider_id'] === 'alchemy-wallet-sendcalls')
    expect(a?.value).toBe(3)
  })

  it('keeps successful stage latencies when canonical observation fails later', async () => {
    const metrics = makeMetrics()
    const record = makeRecord(
      'alchemy-wallet-sendcalls',
      'wallet-sendcalls',
      { prepare: 30, send: 50, submit: 80 },
      0,
    )
    record.stages.canonical = { status: 'observer-error', reason: 'status endpoint unavailable' }
    record.error = 'status endpoint unavailable'
    record.canonicalObservation = {
      api: 'wallet_getCallsStatus',
      pollCount: 4,
      errorClass: 'HttpRequestError',
    }
    const results = [makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', [record], 0)]

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const latency = await metrics.stageLatency.get()
    for (const stage of ['prepare', 'send', 'submit']) {
      const count = latency.values.find(value =>
        value.metricName === 'txe_bench_stage_latency_seconds_count'
        && value.labels['stage'] === stage,
      )
      expect(count?.value).toBe(1)
    }
    expect(latency.values.some(value =>
      value.metricName === 'txe_bench_stage_latency_seconds_count'
      && value.labels['stage'] === 'canonical',
    )).toBe(false)

    const outcomes = await metrics.stageOutcomesTotal.get()
    const canonicalError = outcomes.values.find(value =>
      value.labels['stage'] === 'canonical'
      && value.labels['outcome'] === 'observer-error',
    )
    expect(canonicalError?.value).toBe(1)
    expect(canonicalError?.labels['observer_api']).toBe('wallet_getCallsStatus')
    expect(canonicalError?.labels['measurement_epoch']).toBe('alchemy-status-v2')
  })

  it('emits exactly one canonical outcome per attempt for reconciliation', async () => {
    const metrics = makeMetrics()
    const success = makeRecord('alchemy-mav2-bso', '4337-bundler', { submit: 100, canonical: 2_000 }, 0)
    success.canonicalObservation = {
      api: 'eth_getUserOperationReceipt',
      pollCount: 3,
      terminalStatus: 'success',
    }
    const timedOut = makeRecord('alchemy-mav2-bso', '4337-bundler', { submit: 110 }, 1)
    timedOut.stages.canonical = { status: 'timed-out' }
    timedOut.canonicalObservation = { api: 'eth_getUserOperationReceipt', pollCount: 10 }
    const failed = makeFailedRecord('alchemy-mav2-bso', '4337-bundler', 2)
    const results = [makeProviderResult('alchemy-mav2-bso', '4337-bundler', [success, timedOut, failed], 1)]

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const attempts = (await metrics.attemptsTotal.get()).values[0]?.value
    const canonicalOutcomes = (await metrics.stageOutcomesTotal.get()).values
      .filter(value => value.labels['stage'] === 'canonical')
      .reduce((sum, value) => sum + value.value, 0)
    expect(attempts).toBe(3)
    expect(canonicalOutcomes).toBe(3)
  })

  it('logs one redacted structured benchmark_attempt event per record', async () => {
    const metrics = makeMetrics()
    const record = makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', { submit: 80 }, 7)
    record.stages.canonical = {
      status: 'observer-error',
      reason: `request https://api.g.alchemy.com/v2/${CREDENTIALS.ALCHEMY_API_KEY} failed for ${CREDENTIALS.OWNER_PRIVATE_KEY}`,
    }
    record.canonicalObservation = {
      api: 'wallet_getCallsStatus',
      pollCount: 5,
      terminalStatus: '500',
      errorClass: 'HttpRequestError',
    }
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
    try {
      await runOnce(CREDENTIALS, metrics, REGION, {
        gridRunner: mockGridRunner([makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', [record], 0)]) as never,
        baseEnv: BASE_ENV,
      })
    } finally {
      console.log = original
    }

    const attempts = logs.filter(line => line.includes('"event":"benchmark_attempt"'))
    expect(attempts).toHaveLength(1)
    const event = JSON.parse(attempts[0]!)
    expect(event.observer_api).toBe('wallet_getCallsStatus')
    expect(event.poll_count).toBe(5)
    expect(event.terminal_status).toBe('500')
    expect(event.error_class).toBe('HttpRequestError')
    expect(event.stages.submit).toEqual({ outcome: 'ok', duration_ms: 80 })
    expect(event.stages.canonical.outcome).toBe('observer-error')
    expect(attempts[0]).not.toContain(CREDENTIALS.ALCHEMY_API_KEY)
    expect(attempts[0]).not.toContain(CREDENTIALS.OWNER_PRIVATE_KEY)
  })

  it('observes latencies for two providers independently', async () => {
    const metrics = makeMetrics()
    const results = [
      makeProviderResult('alchemy-light-account', '4337-bundler', [
        makeRecord('alchemy-light-account', '4337-bundler', { submit: 100 }, 0),
      ], 0),
      makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', [
        makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', { submit: 200 }, 0),
      ], 0),
    ]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const agg = await metrics.stageLatency.get()
    const providers = new Set(
      agg.values
        .filter(v => v.metricName === 'txe_bench_stage_latency_seconds_count')
        .map(v => v.labels['provider_id']),
    )
    expect(providers.has('alchemy-light-account')).toBe(true)
    expect(providers.has('alchemy-wallet-sendcalls')).toBe(true)
  })

  it('observes optional prepare/send stages when present (Wallet SendCalls)', async () => {
    const metrics = makeMetrics()
    const records = [
      makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', { submit: 90, prepare: 30, send: 50 }, 0),
    ]
    const results = [makeProviderResult('alchemy-wallet-sendcalls', 'wallet-sendcalls', records, 0)]
    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: mockGridRunner(results) as never, baseEnv: BASE_ENV })

    const agg = await metrics.stageLatency.get()
    const stages = new Set(
      agg.values
        .filter(v => v.metricName === 'txe_bench_stage_latency_seconds_count')
        .map(v => v.labels['stage']),
    )
    expect(stages.has('prepare')).toBe(true)
    expect(stages.has('send')).toBe(true)
    expect(stages.has('submit')).toBe(true)
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

  it('pushes metrics labeled with each network independently', async () => {
    const metrics = makeMetrics()
    const runner = mock(async (config: Config) => [
      makeProviderResult(
        `provider-${config.network}`,
        '4337-bundler',
        [makeRecord(`provider-${config.network}`, '4337-bundler', { submit: 100 }, 0)],
        0,
      ),
    ])
    const env: EnvSource = { NETWORKS: 'eth-mainnet,base-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })

    const agg = await metrics.stageLatency.get()
    const networks = new Set(
      agg.values
        .filter(v => v.metricName === 'txe_bench_stage_latency_seconds_count')
        .map(v => v.labels['network']),
    )
    expect(networks.has('eth-mainnet')).toBe(true)
    expect(networks.has('base-mainnet')).toBe(true)
  })

  it('one network failing does not prevent other networks from completing', async () => {
    const metrics = makeMetrics()
    const runner = mock(async (config: Config) => {
      if (config.network === 'eth-mainnet') throw new Error('eth rpc down')
      return [
        makeProviderResult(
          'alchemy-wallet-sendcalls',
          'wallet-sendcalls',
          [makeRecord('alchemy-wallet-sendcalls', 'wallet-sendcalls', { submit: 100 }, 0)],
          0,
        ),
      ]
    })
    const env: EnvSource = { NETWORKS: 'eth-mainnet,base-mainnet' }

    await runOnce(CREDENTIALS, metrics, REGION, { gridRunner: runner as never, baseEnv: env })

    const agg = await metrics.stageLatency.get()
    const networks = new Set(
      agg.values
        .filter(v => v.metricName === 'txe_bench_stage_latency_seconds_count')
        .map(v => v.labels['network']),
    )
    expect(networks.has('base-mainnet')).toBe(true)
    expect(networks.has('eth-mainnet')).toBe(false)
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

  it('ignores non-Alchemy neutral overrides and always derives the Alchemy URL', async () => {
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
    expect(capturedEnvs[0]?.NEUTRAL_RPC_URL).toBe('https://eth-mainnet.g.alchemy.com/v2/test-key')
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
      accountAddress: ('0x' + '00'.repeat(20)) as `0x${string}`,
      userOpHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
      stages: {
        submit: { status: 'failed', reason: 'Policy does not support bundler sponsorship' },
        preconf: { status: 'not-observed' },
        canonical: { status: 'not-observed' },
        providerReceipt: { status: 'not-observed' },
      },
      blockPositions: {},
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

describe('startLoop regional scheduling', () => {
  it('places each production region in a distinct 15-minute hourly slot', () => {
    const now = Date.UTC(2026, 6, 21, 12, 7, 0)
    const jitterMs = 30_000

    expect(computeRegionalStartDelayMs('us-east-1', now, jitterMs)).toBe(53 * 60_000 + jitterMs)
    expect(computeRegionalStartDelayMs('us-west-2', now, jitterMs)).toBe(8 * 60_000 + jitterMs)
    expect(computeRegionalStartDelayMs('eu-central-1', now, jitterMs)).toBe(23 * 60_000 + jitterMs)
    expect(computeRegionalStartDelayMs('ap-southeast-1', now, jitterMs)).toBe(38 * 60_000 + jitterMs)
  })

  it('waits for the next hour when a task restarts after its regional slot', () => {
    const now = Date.UTC(2026, 6, 21, 12, 15, 45)

    expect(computeRegionalStartDelayMs('us-west-2', now, 30_000)).toBe(59 * 60_000 + 45_000)
  })

  it('waits for the regional slot plus jitter before starting the hourly loop', async () => {
    const runner = mockGridRunner([])
    let startupCallback: (() => void) | undefined
    let hourlyCallback: (() => void) | undefined
    let startupDelayMs: number | undefined
    let hourlyDelayMs: number | undefined

    startLoop(CREDENTIALS, makeMetrics(), 'us-west-2', {
      gridRunner: runner as never,
      baseEnv: BASE_ENV,
      now: () => Date.UTC(2026, 6, 21, 12, 7, 0),
      random: () => 0.5,
      setTimeoutFn: (callback, delayMs) => {
        startupCallback = callback
        startupDelayMs = delayMs
      },
      setIntervalFn: (callback, delayMs) => {
        hourlyCallback = callback
        hourlyDelayMs = delayMs
      },
    })

    expect(runner).toHaveBeenCalledTimes(0)
    expect(startupDelayMs).toBe(8 * 60_000 + 30_000)

    startupCallback!()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(runner).toHaveBeenCalledTimes(1)
    expect(hourlyCallback).toBeDefined()
    expect(hourlyDelayMs).toBe(60 * 60_000)
  })

  it('skips an hourly tick while the previous run is still active', async () => {
    let releaseFirstRun: (() => void) | undefined
    let callCount = 0
    const runner = mock(async () => {
      callCount++
      if (callCount === 1) {
        await new Promise<void>(resolve => { releaseFirstRun = resolve })
      }
      return []
    })
    let startupCallback: (() => void) | undefined
    let hourlyCallback: (() => void) | undefined
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }

    try {
      startLoop(CREDENTIALS, makeMetrics(), REGION, {
        gridRunner: runner as never,
        baseEnv: BASE_ENV,
        now: () => Date.UTC(2026, 6, 21, 12, 0, 0),
        random: () => 0,
        setTimeoutFn: (callback) => { startupCallback = callback },
        setIntervalFn: (callback) => { hourlyCallback = callback },
      })

      startupCallback!()
      await Promise.resolve()
      hourlyCallback!()
      await Promise.resolve()

      expect(runner).toHaveBeenCalledTimes(1)
      expect(logs.some(log => log.includes('"event":"run_skipped"'))).toBe(true)
      expect(logs.some(log => log.includes('"reason":"previous_run_active"'))).toBe(true)

      releaseFirstRun!()
      await new Promise(resolve => setTimeout(resolve, 0))
      hourlyCallback!()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(runner).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirstRun?.()
      console.log = origLog
    }
  })
})
