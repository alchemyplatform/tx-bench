import type { ProtocolClass, ProviderMetrics, RunRecord, StageMetrics } from './contracts.js'

// ── Statistics ────────────────────────────────────────────────────────────────

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!
}

export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[idx]!
}

export function p99(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil(sorted.length * 0.99) - 1)
  return sorted[idx]!
}

export function computeStageMetrics(values: readonly number[]): StageMetrics | undefined {
  if (values.length === 0) return undefined
  return { median: median(values), p95: p95(values), p99: p99(values), count: values.length }
}

// ── Per-provider aggregation ──────────────────────────────────────────────────

export function aggregateRuns(
  provider: string,
  protocolClass: ProtocolClass,
  accountTypeLabel: string,
  records: readonly RunRecord[]
): ProviderMetrics {
  const successRecords = records.filter(r => !r.error && r.stages.submit.status === 'ok')

  function collectMs(stage: keyof RunRecord['stages']): number[] {
    return successRecords
      .map(r => r.stages[stage]?.ms)
      .filter((ms): ms is number => ms != null)
  }

  return {
    provider,
    protocolClass,
    accountTypeLabel,
    runCount: records.length,
    failureCount: records.length - successRecords.length,
    stages: {
      submit: computeStageMetrics(collectMs('submit')),
      preconf: computeStageMetrics(collectMs('preconf')),
      canonical: computeStageMetrics(collectMs('canonical')),
      providerReceipt: computeStageMetrics(collectMs('providerReceipt')),
      prepare: computeStageMetrics(collectMs('prepare')),
      send: computeStageMetrics(collectMs('send')),
    },
  }
}
