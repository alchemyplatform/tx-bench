# Spec: Latency histogram emission (pooled windowed percentiles)

Status: completed · Date: 2026-07-17 · Owner: monitor emitter (this repo)

## Problem

The monitor emits pre-computed percentiles as gauges
(`txe_bench_stage_latency_p50_ms` / `_p95_ms` / `_p99_ms`, `src/monitor/metrics.ts`),
recomputed each hourly run from ~20 samples and *set* into gauges
(`pushGauges`, `src/monitor/loop.ts:192`).

Two consequences make this unusable for windowed analysis:

1. **Non-composable.** Percentiles do not average or `max`. Any Grafana query that
   aggregates these gauges over a time range (e.g. `max by (...) (..._p95_ms[6h])`)
   is statistically meaningless. Only the single latest run is interpretable.
2. **High per-run variance.** p95 of 20 samples is the ~19th sorted value; p99 of 20
   is literally the max (`p99()` in `src/benchmark/aggregate.ts` → `ceil(20*0.99)-1 = 19`).
   These jump hour to hour regardless of any real change.

We want **pooled percentiles over an arbitrary window** (6h / 24h / 7d): pool all raw
per-attempt latencies scraped in the window, then compute one percentile.

## Why a histogram works here (no infra change)

`src/monitor/main.ts` is a long-lived `Bun.serve` process exposing `/metrics`;
`src/monitor/loop.ts:287` runs the benchmark hourly *inside that same process*.
A `prom-client` `Histogram` in the shared registry therefore accumulates cumulatively
across all runs. Prometheus scrapes `/metrics` on its normal interval, bucket counters
increase monotonically, and:

```promql
histogram_quantile(0.95,
  sum by (provider_id, region, le) (
    rate(txe_bench_stage_latency_seconds_bucket{stage="canonical", ...}[$__range])
  )
)
```

pools every attempt in the window and returns a valid p95. `rate()` handles process
restarts (counter-reset detection), so redeploys are safe.

Trade-off accepted: bucketing quantizes values (bounded, ~within-bucket interpolation
error). For directional monitoring this is negligible next to the sampling-variance
reduction from pooling ~480 attempts/day instead of 20/hour.

## Collection pipeline (Grafana Alloy)

Nothing scrapes the ECS task directly. A `grafana-alloy-write-bench` sidecar in the same
task (`containerDefinitions[1]` of the live task def — **not** version-controlled here;
`deploy-write-bench.sh` only swaps `containerDefinitions[0].image`) `prometheus.scrape`s
the monitor's `/metrics` over localhost and `prometheus.remote_write`s to the central TSDB.

Task def: `~/alchemy/txe/terraform/benchmarking-multi-region/global/write-bench/benchmarking.tf`.
The sidecar (`grafana-alloy-write-bench`, `essential=false`, `dependsOn` write-bench HEALTHY)
scrapes `localhost:8080/metrics` (env `SCRAPE_PORT`/`SCRAPE_PATH`) and remote-writes to
**two backends**: Grafana Cloud (`GRAFANA_REMOTE_WRITE_URL`) and Alchemy ObsV2
(`ALCHEMY_OBSV2_REMOTE_WRITE_URL_1/2`).

Implications for this spec:

- **Cumulative counters are durable across restarts.** Alloy remote-writes each scrape, so
  bucket counts land in the TSDB as they accumulate. An ECS redeploy resets the in-memory
  histogram, but `rate()` detects the counter reset and the pre-reset samples already stored
  in the TSDB still count toward a window spanning the restart. No pooled-window data lost.
- **Native histograms are off the table for now.** The `.alloy` config is baked into a
  separate image (`grafana_alloy_ecr_url`, env-parameterized only) — not in this terraform
  or the write-bench repo — and native histograms would need enabling on the Alloy scrape
  **and both** remote-write backends. Classic buckets need none of that. Use classic buckets.
- **Scrape interval** (sets the min useful `rate()` window) lives in that Alloy image config.
  Confirm it, but at hourly-run cadence with 6h/24h windows it won't bind.

## Target metrics (`src/monitor/metrics.ts`)

Straight replacement (still in development — no dual-emit needed):
**delete** `stageLatencyP50/P95/P99`, `successRate`, `sampleCount`, `failureCount`;
**add** one histogram (`stageLatency`) and two counters (`attemptsTotal`, `failuresTotal`);
**keep** `lastRunTimestampUnix` (genuine gauge — freshness).

```ts
import { Gauge, Histogram, Counter, Registry } from 'prom-client'

// Per-attempt latency buckets in SECONDS. One exponential-ish layout spanning
// ~5ms → 120s covers every stage (prepare ~tens of ms → canonical ~seconds) since
// `stage` is a label on a single metric name. Densify (factor ~1.5) if a stage
// needs finer resolution; cardinality cost is trivial at this scale.
const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 120,
]

// added to MonitorMetrics:
stageLatency: new Histogram({
  name: 'txe_bench_stage_latency_seconds',
  help: 'Per-attempt stage latency (seconds). Pool across runs: histogram_quantile(0.95, sum by (le) (rate(..._bucket[$window])))',
  labelNames: LATENCY_LABELS,           // protocol_class, provider_id, stage, network, region
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
}),
attemptsTotal: new Counter({
  name: 'txe_bench_attempts_total',
  help: 'Cumulative benchmark attempts',
  labelNames: SUMMARY_LABELS,           // protocol_class, provider_id, network, region
  registers: [registry],
}),
failuresTotal: new Counter({
  name: 'txe_bench_failures_total',
  help: 'Cumulative failed benchmark attempts',
  labelNames: SUMMARY_LABELS,
  registers: [registry],
}),
```

**Unit note:** switching to seconds follows Prometheus base-unit convention and makes
`histogram_quantile` return seconds directly (Grafana unit `s`). If you prefer to avoid
touching existing panels' `ms` unit, name it `..._milliseconds_bucket` and observe `s.ms`
directly — mechanically identical. Recommendation: seconds.

## Emission change (`pushGauges`, `src/monitor/loop.ts:192`)

`results: ProviderRunResult[]` already carries per-attempt `records: RunRecord[]`
(used by `logRunResults`). Observe raw latencies instead of setting percentile gauges.
Mirror the exact inclusion rule from `aggregateRuns` (`src/benchmark/aggregate.ts:41`,
`successRecords`) so the histogram pools the *same population* the old percentiles
summarized — this keeps old and new numbers comparable during dual-emit.

```ts
for (const { records, metrics: pm } of results) {
  const summaryLabels = {
    protocol_class: pm.protocolClass, provider_id: pm.provider, network, region,
  }

  metrics.attemptsTotal.inc(summaryLabels, pm.runCount)
  metrics.failuresTotal.inc(summaryLabels, pm.failureCount)

  for (const rec of records) {
    if (rec.error || rec.stages.submit.status !== 'ok') continue   // == aggregateRuns() successRecords
    for (const [stage, s] of Object.entries(rec.stages)) {
      if (!s || s.ms == null) continue
      metrics.stageLatency.observe({ ...summaryLabels, stage }, s.ms / 1000)
    }
  }

  metrics.lastRunTimestampUnix.set(summaryLabels, Date.now() / 1000)
}
```

Stages observed: `submit, preconf, canonical, providerReceipt, prepare?, send?`
(`RunRecord.stages`, `src/benchmark/contracts.ts:36`). `prepare`/`send` are present only
for Wallet SendCalls — fine, absent stages simply produce no observations.

## Companion dashboard queries (windowed, pooled)

Percentile table per stage (replaces the `_p95_ms` gauge panels; reuse panel-18's
`joinByLabels`/`organize` pivot, swapping the query):

```promql
# p95 canonical, pooled over the dashboard range, per provider × region
histogram_quantile(0.95, sum by (provider_id, region, le) (
  rate(txe_bench_stage_latency_seconds_bucket{
    environment=~"$environment", region=~"$region",
    network=~"$network", provider_id=~"$provider_id", stage="canonical"
  }[$__range])
))
```

Use `$__range` to pool over the whole visible window, or a fixed `[6h]`/`[24h]`. Windows
shorter than ~2–3h will be thin (few runs). Windowed success rate / sample count from the
new counters:

```promql
1 - (sum by (provider_id, region) (rate(txe_bench_failures_total{...}[$__range]))
   /  sum by (provider_id, region) (rate(txe_bench_attempts_total{...}[$__range])))
sum by (provider_id, region) (increase(txe_bench_attempts_total{...}[$__range]))
```

## Rollout

Straight cutover (in development):

1. Replace metrics + emission; build and deploy the new image.
2. Rebuild the dashboard panels on the histogram / counter queries below (the old
   `_p95_ms` / `success_rate` / `sample_count` gauge series will simply stop appearing).
3. Validate: spot-check a windowed p95 against a manual percentile computed over the same
   runs from the CloudWatch `provider_summary` logs (`logRunResults`, `loop.ts:157`).

No historical backfill — histograms accumulate from deploy forward only.

## Testing (`src/monitor/metrics.test.ts`)

- `buildMetrics` registers `txe_bench_stage_latency_seconds{_bucket,_sum,_count}`,
  `txe_bench_attempts_total`, `txe_bench_failures_total`.
- Feeding N synthetic `RunRecord`s produces `_count` == number of included (successful)
  stage attempts and `_sum` == Σ ms/1000, per label set.
- Failed / errored attempts are excluded from `stageLatency` but counted in
  `attemptsTotal` / `failuresTotal` (mirrors `aggregateRuns`).
- Bucket boundaries bracket expected stage magnitudes (no observations pile into `+Inf`).

## Decisions to confirm

1. **Unit:** seconds (recommended) vs keep ms. Ripples into panel unit config + query names.
2. **Inclusion rule:** mirror `aggregateRuns` `successRecords` gate (recommended, keeps
   parity) vs observe any stage with `status === 'ok'` (slightly larger population).
3. **Native histograms — resolved: no (for now).** Would require enabling on the Alloy
   scrape and *both* remote-write backends (Grafana Cloud + Alchemy ObsV2), and that config
   isn't in reach here. Ship classic buckets. Revisit only if the whole pipeline is
   confirmed native-histogram-capable — the emission code change would be a one-liner then.
```
