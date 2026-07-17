import { Counter, Gauge, Histogram, Registry } from 'prom-client'

const LATENCY_LABELS = ['protocol_class', 'provider_id', 'stage', 'network', 'region'] as const
const SUMMARY_LABELS = ['protocol_class', 'provider_id', 'network', 'region'] as const

export type LatencyLabels = { protocol_class: string; provider_id: string; stage: string; network: string; region: string }
export type SummaryLabels = { protocol_class: string; provider_id: string; network: string; region: string }

// Per-attempt latency buckets in SECONDS. One exponential-ish layout spanning
// ~5ms → 120s covers every stage (prepare ~tens of ms → canonical ~seconds) since
// `stage` is a label on a single metric name. Densify (factor ~1.5) if a stage
// needs finer resolution; cardinality cost is trivial at this scale.
const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 120,
]

export type MonitorMetrics = {
  // Per-attempt latency histogram. Pool across runs with:
  //   histogram_quantile(0.95, sum by (le) (rate(..._bucket[$window])))
  stageLatency: Histogram<string>
  // Cumulative benchmark attempts (successful + failed).
  attemptsTotal: Counter<string>
  // Cumulative failed benchmark attempts.
  failuresTotal: Counter<string>
  // Unix timestamp of the most recent completed run (freshness gauge).
  lastRunTimestampUnix: Gauge<string>
}

export function buildMetrics(registry: Registry): MonitorMetrics {
  return {
    stageLatency: new Histogram({
      name: 'txe_bench_stage_latency_seconds',
      help: 'Per-attempt stage latency (seconds). Pool across runs: histogram_quantile(0.95, sum by (le) (rate(..._bucket[$window])))',
      labelNames: LATENCY_LABELS,
      buckets: LATENCY_BUCKETS_SECONDS,
      registers: [registry],
    }),
    attemptsTotal: new Counter({
      name: 'txe_bench_attempts_total',
      help: 'Cumulative benchmark attempts',
      labelNames: SUMMARY_LABELS,
      registers: [registry],
    }),
    failuresTotal: new Counter({
      name: 'txe_bench_failures_total',
      help: 'Cumulative failed benchmark attempts',
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
