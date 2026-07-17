import { describe, expect, it } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics'

// A Histogram registers three series in the text output: `_bucket`, `_sum`,
// `_count`. `getMetricsAsArray()` collapses them into one entry named after the
// histogram (`txe_bench_stage_latency_seconds`).
const EXPECTED_METRIC_NAMES = [
  'txe_bench_stage_latency_seconds',
  'txe_bench_attempts_total',
  'txe_bench_failures_total',
  'txe_bench_last_run_timestamp_unix',
]

describe('buildMetrics', () => {
  it('registers exactly the four expected metric names', () => {
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
      ['protocol_class', 'provider_id', 'stage', 'network', 'region'].sort(),
    )
    // `upperBounds` holds the configured bucket edges; prom-client appends
    // `+Inf` only at serialization time, so it is not present here.
    const upperBounds = (metric as any).upperBounds as number[]
    expect(upperBounds).toContain(0.005)
    expect(upperBounds).toContain(1)
    expect(upperBounds).toContain(120)
  })

  it('summary counters/gauge have the correct label names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const summaryLabels = ['protocol_class', 'provider_id', 'network', 'region']
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
  })

  it('observing the histogram produces _count/_sum/_bucket text lines', async () => {
    const registry = new Registry()
    const { stageLatency } = buildMetrics(registry)
    const labels = {
      protocol_class: '4337-bundler',
      provider_id: 'alchemy-light-account',
      stage: 'submit',
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
      network: 'base-mainnet',
      region: 'us-east-1',
    }
    // 2.7s lands in the le="4" bucket, 0.05s in le="0.05". Neither in +Inf.
    stageLatency.observe(labels, 2.7)
    stageLatency.observe(labels, 0.05)

    const text = await registry.metrics()
    const bucketLines = text
      .split('\n')
      .filter(l => l.startsWith('txe_bench_stage_latency_seconds_bucket'))

    const le4 = bucketLines.find(l => l.includes('le="4"'))
    const leInf = bucketLines.find(l => l.includes('le="+Inf"'))
    expect(le4).toBeDefined()
    // Cumulative: le="4" counts both observations (0.05 and 2.7); le="+Inf" also 2.
    expect(le4).toMatch(/\b2$/)
    expect(leInf).toMatch(/\b2$/)
  })

  it('two buildMetrics calls on different registries do not throw', () => {
    const r1 = new Registry()
    const r2 = new Registry()
    expect(() => buildMetrics(r1)).not.toThrow()
    expect(() => buildMetrics(r2)).not.toThrow()
    expect(r1.getMetricsAsArray()).toHaveLength(4)
    expect(r2.getMetricsAsArray()).toHaveLength(4)
  })
})
