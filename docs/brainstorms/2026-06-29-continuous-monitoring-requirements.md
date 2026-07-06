---
date: 2026-06-29
topic: continuous-monitoring
---

# Write-Bench Continuous Monitoring — Requirements

## Summary

A continuous benchmark service integrated into `OMGWINNING/alchemy-benchmarking`'s ECS
infrastructure. It runs write-bench's ERC-4337 and `wallet_sendCalls` adapters on an
hourly schedule, Alchemy-only, across configurable networks. Per-stage latency percentiles
are exposed as Prometheus Gauges, scraped by the existing Prometheus/Grafana stack, and
surfaced as an internal Grafana dashboard for the team to track regressions and validate
latency work.

---

## Problem Frame

The write-bench CLI produces per-stage latency numbers on demand, but there is no
continuous record of how Alchemy's write-path latency trends over time or across
deployments. Without that, regressions are caught late (if at all), and improvements are
hard to attribute to specific changes. The existing `rpc_slo_monitor` Java service covers
`eth_sendRawTransaction` continuously, but the smart-account write paths (ERC-4337 UserOp,
`wallet_sendCalls`) are not monitored.

---

## Key Decisions

- **Internal perf monitoring only.** This infrastructure is not connected to the public
  benchmark page. The Grafana dashboard is the end state — no public data export.
- **Alchemy-only providers.** No competitor API keys or funded wallets in this
  infrastructure. The tool is provider-pluggable, so competitors can be added later if
  needed.
- **Networks are config-driven, not hardcoded.** Network selection follows the same
  runtime-configurable pattern as `rpc_slo_monitor` (YAML config, environment overrides).
  Operators enable or disable networks without code changes. This also makes gas cost
  management operational rather than architectural.
- **Hourly runs, not continuous.** The 10-second SLO-monitoring cadence is too expensive
  for write transactions. Hourly batch runs produce enough signal for trend tracking and
  regression detection.
- **Gauge-based metrics, not Histograms.** Hourly infrequent runs do not suit Prometheus's
  native Histogram/Summary types (designed for high-frequency continuous data). Instead,
  the service pre-computes percentiles within each run and sets Gauges, matching the
  pattern used by `grpc_benchmark/src/metrics.py`.
- **`stage` label, not separate metric names per stage.** ERC-4337 and `wallet_sendCalls`
  have different stage names. A single metric family with a `stage` label avoids sparse
  metrics and keeps dashboards composable.
- **Do not duplicate `eth_sendRawTransaction`.** The Java service already monitors this
  path. This service covers only the smart-account adapters.
- **Separate ECS task from `rpc_slo_monitor`.** Per the platform owner's recommendation,
  write-bench runs as its own ECS task, not merged into the Java service's task definition.
- **CloudWatch logging for failures, no active alerting in v1.** Run failures (wallet
  underfunded, API key expired, etc.) are logged to CloudWatch. A `last_run_timestamp_unix`
  Gauge serves as a staleness sentinel that can be alerting-wired later. No Slack or
  PagerDuty integration in v1.

---

## Scope

### In scope

- **Dockerized Node.js benchmark runner** — write-bench packaged as a container, pushed to
  ECR, deployed as an ECS task.
- **Hourly scheduled execution** — task runs once per hour per configured network per
  region.
- **Write paths covered:**
  - ERC-4337 UserOp (stages: `build_userop`, `send`, `inclusion`, `total`)
  - `wallet_sendCalls` (stages: `prepare_calls`, `sign`, `send_prepared_calls`, `total`)
- **Prometheus Gauge metrics** exposed on port 8080 at `/metrics`:
  - Per-stage latency percentiles (p50, p95, p99)
  - Success rate, sample count, failure count per run
  - `last_run_timestamp_unix` staleness sentinel
  - Label dimensions: `adapter`, `stage`, `network`, `region`
- **Multi-region deployment** via the existing `multi-region-deploy-*.sh` script pattern
  in `OMGWINNING/alchemy-benchmarking`.
- **API keys and wallet private keys** stored in AWS Secrets Manager, following the
  existing service's `SecretReader` pattern.
- **Grafana dashboard** — per-stage latency over time, success rate, and staleness
  indicator.
- **CloudWatch log shipping** for run failures and errors.

### Out of scope

- `eth_sendRawTransaction` — already covered by `rpc_slo_monitor`.
- Competitor providers (Pimlico, ZeroDev) in this infrastructure.
- Public data export or connection to the hosted benchmark page.
- Active Slack/PagerDuty alerting (deferred; staleness Gauge makes it addable later).
- Changes to the existing Java `rpc_slo_monitor` service.

---

## Success Criteria

- Grafana dashboard shows p50/p95/p99 per stage for both adapters, per configured network,
  updating every hour.
- `last_run_timestamp_unix` is set on every successful run; a manual check can confirm
  staleness within two hours of a failure.
- Run failures produce a CloudWatch log entry with enough detail to diagnose (error type,
  network, adapter, region).
- Service runs without interruption for 7 days post-deployment.
- Adding or removing a network requires only a config change, not a code or image change.

---

## Metric Schema (logical)

All metrics are Gauges. Values are set at the end of each run; they hold until the next
run overwrites them.

| Metric | Labels | Description |
|---|---|---|
| `txe_bench_stage_latency_p50_ms` | `adapter, stage, network, region` | Median stage latency across samples in the run |
| `txe_bench_stage_latency_p95_ms` | `adapter, stage, network, region` | p95 stage latency |
| `txe_bench_stage_latency_p99_ms` | `adapter, stage, network, region` | p99 stage latency |
| `txe_bench_success_rate` | `adapter, network, region` | Fraction of samples that completed without error |
| `txe_bench_sample_count` | `adapter, network, region` | Number of samples attempted in the run |
| `txe_bench_failure_count` | `adapter, network, region` | Number of samples that failed |
| `txe_bench_last_run_timestamp_unix` | `adapter, network, region` | Unix timestamp of the most recent completed run |

**Label values:**
- `adapter`: `erc4337` | `wallet_sendcalls`
- `stage` (erc4337): `build_userop` | `send` | `inclusion` | `total`
- `stage` (wallet_sendcalls): `prepare_calls` | `sign` | `send_prepared_calls` | `total`

---

## Assumptions and Open Questions

- **Sample count per run** is left to implementation. Should balance statistical confidence
  (higher N) against per-run gas cost and wall-clock time. A value in the 20–50 range is
  a reasonable starting point; ETH mainnet gas cost per run should be verified before
  locking in N for L1.
- **Specific L2 networks** beyond Base mainnet are left to the operator via config. No
  networks are hardcoded.
- **ECS task triggering mechanism** — the Java service is a long-running self-scheduling
  process; write-bench may run as either a long-running process with internal hourly
  scheduling or a short-lived Fargate task triggered by EventBridge cron. This is an
  implementation choice for planning.
- **Wallet funding operations** (monitoring balances, topping up) are out of scope for
  this feature but will need an operational runbook.
