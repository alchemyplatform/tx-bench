import { Counter, Gauge, Histogram, Registry } from 'prom-client'

export const MEASUREMENT_EPOCH = 'alchemy-status-v2'

const SUMMARY_LABELS = [
  'protocol_class', 'provider_id', 'observer_api', 'measurement_epoch', 'network', 'region',
] as const
const LATENCY_LABELS = [...SUMMARY_LABELS, 'stage'] as const
const OUTCOME_LABELS = [...SUMMARY_LABELS, 'stage', 'outcome'] as const

export type SummaryLabels = {
  protocol_class: string
  provider_id: string
  observer_api: string
  measurement_epoch: string
  network: string
  region: string
}
export type LatencyLabels = SummaryLabels & { stage: string }

// Per-attempt latency buckets in SECONDS. One exponential-ish layout spanning
// ~5ms → 120s covers every stage (prepare ~tens of ms → canonical ~seconds) since
// `stage` is a label on a single metric name. Densify (factor ~1.5) if a stage
// needs finer resolution; cardinality cost is trivial at this scale.
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75,
  1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4,
  4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8,
  10, 12, 16, 24, 32, 64, 120,
]

export type MonitorMetrics = {
  // Per-attempt latency histogram. Pool across runs with:
  //   histogram_quantile(0.95, sum by (le) (rate(..._bucket[$window])))
  stageLatency: Histogram<string>
  // Cumulative benchmark attempts (successful + failed).
  attemptsTotal: Counter<string>
  // Cumulative failed benchmark attempts.
  failuresTotal: Counter<string>
  // One normalized outcome for every expected stage in every attempt.
  stageOutcomesTotal: Counter<string>
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
    stageOutcomesTotal: new Counter({
      name: 'txe_bench_stage_outcomes_total',
      help: 'Cumulative normalized stage outcomes for benchmark attempts',
      labelNames: OUTCOME_LABELS,
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
