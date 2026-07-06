import { Gauge, Registry } from 'prom-client'

const LATENCY_LABELS = ['protocol_class', 'provider_id', 'stage', 'network', 'region'] as const
const SUMMARY_LABELS = ['protocol_class', 'provider_id', 'network', 'region'] as const

export type LatencyLabels = { protocol_class: string; provider_id: string; stage: string; network: string; region: string }
export type SummaryLabels = { protocol_class: string; provider_id: string; network: string; region: string }

export type MonitorMetrics = {
  stageLatencyP50: Gauge<string>
  stageLatencyP95: Gauge<string>
  stageLatencyP99: Gauge<string>
  successRate: Gauge<string>
  sampleCount: Gauge<string>
  failureCount: Gauge<string>
  lastRunTimestampUnix: Gauge<string>
}

export function buildMetrics(registry: Registry): MonitorMetrics {
  return {
    stageLatencyP50: new Gauge({
      name: 'txe_bench_stage_latency_p50_ms',
      help: 'Median stage latency across samples in the run (ms)',
      labelNames: LATENCY_LABELS,
      registers: [registry],
    }),
    stageLatencyP95: new Gauge({
      name: 'txe_bench_stage_latency_p95_ms',
      help: 'p95 stage latency across samples in the run (ms)',
      labelNames: LATENCY_LABELS,
      registers: [registry],
    }),
    stageLatencyP99: new Gauge({
      name: 'txe_bench_stage_latency_p99_ms',
      help: 'p99 stage latency across samples in the run (ms)',
      labelNames: LATENCY_LABELS,
      registers: [registry],
    }),
    successRate: new Gauge({
      name: 'txe_bench_success_rate',
      help: 'Fraction of samples that completed without error',
      labelNames: SUMMARY_LABELS,
      registers: [registry],
    }),
    sampleCount: new Gauge({
      name: 'txe_bench_sample_count',
      help: 'Number of samples attempted in the run',
      labelNames: SUMMARY_LABELS,
      registers: [registry],
    }),
    failureCount: new Gauge({
      name: 'txe_bench_failure_count',
      help: 'Number of samples that failed',
      labelNames: SUMMARY_LABELS,
      registers: [registry],
    }),
    lastRunTimestampUnix: new Gauge({
      name: 'txe_bench_last_run_timestamp_unix',
      help: 'Unix timestamp of the most recent completed run',
      labelNames: SUMMARY_LABELS,
      registers: [registry],
    }),
  }
}
