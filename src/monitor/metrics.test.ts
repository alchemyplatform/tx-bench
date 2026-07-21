import { describe, expect, it } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics, LATENCY_BUCKETS_SECONDS } from './metrics'

// A Histogram registers three series in the text output: `_bucket`, `_sum`,
// `_count`. `getMetricsAsArray()` collapses them into one entry named after the
// histogram (`txe_bench_stage_latency_seconds`).
const EXPECTED_METRIC_NAMES = [
  'txe_bench_stage_latency_seconds',
  'txe_bench_attempts_total',
  'txe_bench_failures_total',
  'txe_bench_stage_outcomes_total',
  'txe_bench_last_run_timestamp_unix',
]

describe('buildMetrics', () => {
  it('registers exactly the expected metric names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const names = registry.getMetricsAsArray().map(m => m.name)
    expect(names.sort()).toEqual(EXPECTED_METRIC_NAMES.sort())
  })

  it('stage latency histogram has the correct label names and bucket boundaries', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const metric = registry.getSingleMetric('txe_bench_stage_latency_seconds')
    expect(metric).toBeDefined()
    const labelNames = (metric as any).labelNames as string[]
    expect(labelNames.sort()).toEqual(
      ['protocol_class', 'provider_id', 'stage', 'observer_api', 'measurement_epoch', 'network', 'region'].sort(),
    )
    // `upperBounds` holds the configured bucket edges; prom-client appends
    // `+Inf` only at serialization time, so it is not present here.
    const upperBounds = (metric as any).upperBounds as number[]
    expect(upperBounds).toContain(0.005)
    expect(upperBounds).toContain(1)
    expect(upperBounds).toContain(120)
    const fromOneToFour = upperBounds.filter(bound => bound >= 1 && bound <= 4)
    const fromFourToEight = upperBounds.filter(bound => bound >= 4 && bound <= 8)
    expect(Math.max(...fromOneToFour.slice(1).map((bound, index) => bound - fromOneToFour[index]!))).toBeLessThanOrEqual(0.25)
    expect(Math.max(...fromFourToEight.slice(1).map((bound, index) => bound - fromFourToEight[index]!))).toBeLessThanOrEqual(0.5)
  })

  it('brackets the exact p95 of a known canonical distribution', () => {
    const values = [
      1.05, 1.2, 1.35, 1.5, 1.65, 1.8, 1.95, 2.1, 2.25, 2.4,
      2.55, 2.7, 2.85, 3, 3.15, 3.3, 3.45, 3.62, 3.8, 4.1,
    ]
    const exactP95 = values[Math.ceil(values.length * 0.95) - 1]!
    const upper = LATENCY_BUCKETS_SECONDS.find(bound => bound >= exactP95)!
    const upperIndex = LATENCY_BUCKETS_SECONDS.indexOf(upper)
    const lower = upperIndex === 0 ? 0 : LATENCY_BUCKETS_SECONDS[upperIndex - 1]!

    expect(exactP95).toBeGreaterThan(lower)
    expect(exactP95).toBeLessThanOrEqual(upper)
    expect(upper - lower).toBeLessThanOrEqual(0.25)
  })

  it('summary counters/gauge have the correct label names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const summaryLabels = ['protocol_class', 'provider_id', 'observer_api', 'measurement_epoch', 'network', 'region']
    for (const name of [
      'txe_bench_attempts_total',
      'txe_bench_failures_total',
      'txe_bench_last_run_timestamp_unix',
    ]) {
      const metric = registry.getSingleMetric(name)
      expect(metric).toBeDefined()
      const labelNames = (metric as any).labelNames as string[]
      expect(labelNames.sort()).toEqual(summaryLabels.sort())
    }

    const outcome = registry.getSingleMetric('txe_bench_stage_outcomes_total')
    expect((outcome as any).labelNames.sort()).toEqual(
      [...summaryLabels, 'stage', 'outcome'].sort(),
    )
  })

  it('observing the histogram produces _count/_sum/_bucket text lines', async () => {
    const registry = new Registry()
    const { stageLatency } = buildMetrics(registry)
    const labels = {
      protocol_class: '4337-bundler',
      provider_id: 'alchemy-light-account',
      stage: 'submit',
      observer_api: 'eth_getUserOperationReceipt',
      measurement_epoch: 'alchemy-status-v2',
      network: 'base-mainnet',
      region: 'us-east-1',
    }
    stageLatency.observe(labels, 0.12)
    const text = await registry.metrics()
    expect(text).toContain('txe_bench_stage_latency_seconds_bucket')
    expect(text).toContain('txe_bench_stage_latency_seconds_sum')
    expect(text).toContain('txe_bench_stage_latency_seconds_count')
    expect(text).toContain('protocol_class="4337-bundler"')
    expect(text).toContain('stage="submit"')
  })

  it('feeding N observations produces _count == N and _sum == Σ values, per label set', async () => {
    const registry = new Registry()
    const { stageLatency } = buildMetrics(registry)
    const labels = {
      protocol_class: '4337-bundler',
      provider_id: 'alchemy-light-account',
      stage: 'canonical',
      observer_api: 'eth_getUserOperationReceipt',
      measurement_epoch: 'alchemy-status-v2',
      network: 'base-mainnet',
      region: 'us-east-1',
    }
    const values = [0.5, 1.2, 2.7] // seconds
    for (const v of values) stageLatency.observe(labels, v)

    const agg = await stageLatency.get()
    const count = agg.values.find(v => v.metricName === 'txe_bench_stage_latency_seconds_count')
    const sum = agg.values.find(v => v.metricName === 'txe_bench_stage_latency_seconds_sum')
    expect(count?.value).toBe(values.length)
    expect(sum?.value).toBeCloseTo(values.reduce((a, b) => a + b, 0), 6)
  })

  it('observations land in the bucket whose upper bound brackets them (no +Inf pile-up)', async () => {
    const registry = new Registry()
    const { stageLatency } = buildMetrics(registry)
    const labels = {
      protocol_class: '4337-bundler',
      provider_id: 'alchemy-light-account',
      stage: 'canonical',
      observer_api: 'eth_getUserOperationReceipt',
      measurement_epoch: 'alchemy-status-v2',
      network: 'base-mainnet',
      region: 'us-east-1',
    }
    // 2.7s lands in the le="2.75" bucket, 0.05s in le="0.05". Neither in +Inf.
    stageLatency.observe(labels, 2.7)
    stageLatency.observe(labels, 0.05)

    const text = await registry.metrics()
    const bucketLines = text
      .split('\n')
      .filter(l => l.startsWith('txe_bench_stage_latency_seconds_bucket'))

    const le275 = bucketLines.find(l => l.includes('le="2.75"'))
    const leInf = bucketLines.find(l => l.includes('le="+Inf"'))
    expect(le275).toBeDefined()
    // Cumulative: le="2.75" counts both observations (0.05 and 2.7); le="+Inf" also 2.
    expect(le275).toMatch(/\b2$/)
    expect(leInf).toMatch(/\b2$/)
  })

  it('two buildMetrics calls on different registries do not throw', () => {
    const r1 = new Registry()
    const r2 = new Registry()
    expect(() => buildMetrics(r1)).not.toThrow()
    expect(() => buildMetrics(r2)).not.toThrow()
    expect(r1.getMetricsAsArray()).toHaveLength(5)
    expect(r2.getMetricsAsArray()).toHaveLength(5)
  })
})
