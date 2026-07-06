import { describe, expect, it } from 'bun:test'
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics'

const EXPECTED_METRIC_NAMES = [
  'txe_bench_stage_latency_p50_ms',
  'txe_bench_stage_latency_p95_ms',
  'txe_bench_stage_latency_p99_ms',
  'txe_bench_success_rate',
  'txe_bench_sample_count',
  'txe_bench_failure_count',
  'txe_bench_last_run_timestamp_unix',
]

describe('buildMetrics', () => {
  it('registers exactly the seven expected metric names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const names = registry.getMetricsAsArray().map(m => m.name)
    expect(names.sort()).toEqual(EXPECTED_METRIC_NAMES.sort())
  })

  it('latency gauges have the correct label names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const latencyLabels = ['protocol_class', 'provider_id', 'stage', 'network', 'region']
    for (const name of ['txe_bench_stage_latency_p50_ms', 'txe_bench_stage_latency_p95_ms', 'txe_bench_stage_latency_p99_ms']) {
      const metric = registry.getSingleMetric(name)
      expect(metric).toBeDefined()
      // labelNames is on the Gauge constructor; check via the metric descriptor
      const labelNames = (metric as any).labelNames as string[]
      expect(labelNames.sort()).toEqual(latencyLabels.sort())
    }
  })

  it('summary gauges have the correct label names', () => {
    const registry = new Registry()
    buildMetrics(registry)
    const summaryLabels = ['protocol_class', 'provider_id', 'network', 'region']
    for (const name of [
      'txe_bench_success_rate',
      'txe_bench_sample_count',
      'txe_bench_failure_count',
      'txe_bench_last_run_timestamp_unix',
    ]) {
      const metric = registry.getSingleMetric(name)
      expect(metric).toBeDefined()
      const labelNames = (metric as any).labelNames as string[]
      expect(labelNames.sort()).toEqual(summaryLabels.sort())
    }
  })

  it('setting a latency gauge produces a valid prometheus text line', async () => {
    const registry = new Registry()
    const { stageLatencyP50 } = buildMetrics(registry)
    stageLatencyP50.set(
      { protocol_class: '4337-bundler', provider_id: 'alchemy-light-account', stage: 'submit', network: 'base-mainnet', region: 'us-east-1' },
      123.45,
    )
    const text = await registry.metrics()
    expect(text).toContain('txe_bench_stage_latency_p50_ms')
    expect(text).toContain('123.45')
    expect(text).toContain('protocol_class="4337-bundler"')
    expect(text).toContain('stage="submit"')
  })

  it('two buildMetrics calls on different registries do not throw', () => {
    const r1 = new Registry()
    const r2 = new Registry()
    expect(() => buildMetrics(r1)).not.toThrow()
    expect(() => buildMetrics(r2)).not.toThrow()
    expect(r1.getMetricsAsArray()).toHaveLength(7)
    expect(r2.getMetricsAsArray()).toHaveLength(7)
  })
})
