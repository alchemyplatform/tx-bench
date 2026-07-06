import { describe, expect, it } from 'bun:test'
import { median, p95, p99, computeStageMetrics, aggregateRuns } from './aggregate'
import type { RunRecord } from './contracts'

// ── median / p95 ──────────────────────────────────────────────────────────────

describe('median', () => {
  it('returns 0 for empty input', () => expect(median([])).toBe(0))
  it('returns the single value', () => expect(median([42])).toBe(42))
  it('returns middle value for odd count', () => expect(median([1, 3, 2])).toBe(2))
  it('returns average of two middle values for even count', () => expect(median([1, 2, 3, 4])).toBe(2.5))
  it('is not affected by input order', () => expect(median([5, 1, 3])).toBe(3))
})

describe('p95', () => {
  it('returns 0 for empty input', () => expect(p95([])).toBe(0))
  it('returns the single value for a one-element array', () => expect(p95([42])).toBe(42))
  it('returns the highest value for a two-element array', () => expect(p95([10, 20])).toBe(20))
  it('selects the 95th-percentile bucket', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(p95(values)).toBe(95)
  })
})

describe('p99', () => {
  it('returns 0 for empty input', () => expect(p99([])).toBe(0))
  it('returns the single value for a one-element array', () => expect(p99([42])).toBe(42))
  it('returns the highest value for a two-element array', () => expect(p99([10, 20])).toBe(20))
  it('selects the 99th-percentile bucket', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(p99(values)).toBe(99)
  })
  it('is >= p95 for any input', () => {
    const values = [10, 50, 100, 200, 500, 1000, 9999]
    expect(p99(values)).toBeGreaterThanOrEqual(p95(values))
  })
})

describe('computeStageMetrics', () => {
  it('returns undefined for empty input', () => expect(computeStageMetrics([])).toBeUndefined())
  it('returns median, p95, p99, and count', () => {
    const result = computeStageMetrics([100, 200, 300])
    expect(result?.median).toBe(200)
    expect(result?.p95).toBe(300)
    expect(result?.p99).toBe(300)
    expect(result?.count).toBe(3)
  })
  it('p99 matches standalone p99() for same input', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const result = computeStageMetrics(values)
    expect(result?.p99).toBe(p99(values))
  })
})

// ── aggregateRuns ─────────────────────────────────────────────────────────────

function makeRecord(submitMs: number, canonicalMs: number, error?: string): RunRecord {
  return {
    provider: 'alchemy-light-account',
    runIndex: 0,
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Light Account v2',
    accountAddress: '0x0000000000000000000000000000000000000001',
    userOpHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    stages: {
      submit: error ? { status: 'failed', reason: error } : { status: 'ok', ms: submitMs },
      preconf: { status: 'not-observed' },
      canonical: error ? { status: 'not-observed' } : { status: 'ok', ms: canonicalMs },
      providerReceipt: { status: 'not-observed' },
    },
    blockPositions: {},
    error,
  }
}

describe('aggregateRuns', () => {
  it('computes median and p95 per stage across N successful runs', () => {
    const records = [
      makeRecord(100, 1000),
      makeRecord(200, 2000),
      makeRecord(300, 3000),
    ]
    const metrics = aggregateRuns('alchemy-light-account', '4337-bundler', 'Light Account v2', records)

    expect(metrics.runCount).toBe(3)
    expect(metrics.failureCount).toBe(0)
    expect(metrics.stages.submit?.median).toBe(200)
    expect(metrics.stages.submit?.p95).toBe(300)
    expect(metrics.stages.submit?.p99).toBe(300)
    expect(metrics.stages.submit?.count).toBe(3)
    expect(metrics.stages.canonical?.median).toBe(2000)
  })

  it('counts failures but excludes them from stage metrics', () => {
    const records = [
      makeRecord(100, 1000),
      makeRecord(200, 2000),
      makeRecord(0, 0, 'bundler rejected'),
    ]
    const metrics = aggregateRuns('alchemy-light-account', '4337-bundler', 'Light Account v2', records)

    expect(metrics.runCount).toBe(3)
    expect(metrics.failureCount).toBe(1)
    expect(metrics.stages.submit?.count).toBe(2)
    expect(metrics.stages.submit?.median).toBe(150)
  })

  it('returns undefined stage metrics when all runs failed', () => {
    const records = [makeRecord(0, 0, 'error'), makeRecord(0, 0, 'error')]
    const metrics = aggregateRuns('alchemy-light-account', '4337-bundler', 'Light Account v2', records)

    expect(metrics.failureCount).toBe(2)
    expect(metrics.stages.submit).toBeUndefined()
    expect(metrics.stages.canonical).toBeUndefined()
  })

  it('handles a single-run input without crashing', () => {
    const metrics = aggregateRuns('alchemy-light-account', '4337-bundler', 'Light Account v2', [makeRecord(150, 3000)])
    expect(metrics.stages.submit?.median).toBe(150)
    expect(metrics.stages.submit?.count).toBe(1)
  })

  it('uses median not mean — right-skewed outlier does not inflate the center', () => {
    // median of [100, 110, 5000] = 110; mean would be ~1737
    const records = [makeRecord(100, 1000), makeRecord(110, 1100), makeRecord(5000, 50000)]
    const metrics = aggregateRuns('p', '4337-bundler', 'L', records)
    expect(metrics.stages.submit?.median).toBe(110)
  })
})
