import { describe, expect, it } from 'bun:test'
import { buildRunRecord, calculateTotalFee, makeStage, numericToBigInt } from './metrics'
import type { SponsoredResult } from './providers/types'
import type { CanonicalResult } from './oracle/canonical'
import type { FlashblockResult } from './oracle/flashblocks'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HASH = ('0x' + 'aa'.repeat(32)) as `0x${string}`
const TX = ('0x' + 'cc'.repeat(32)) as `0x${string}`
const ADDR = ('0x' + '11'.repeat(20)) as `0x${string}`
const ACCEPTED_AT = 1000 // ms reference point

const SPONSORED: SponsoredResult = {
  userOpHash: HASH,
  protocolClass: '4337-bundler',
  submitMs: 300,
  accountAddress: ADDR,
}

const CANONICAL_OK: CanonicalResult = {
  status: 'ok',
  blockNumber: 999n,
  txHash: TX,
  tMs: ACCEPTED_AT + 4000,
}

const PRECONF_OK: FlashblockResult = {
  status: 'ok',
  blockNumber: 999n,
  flashblockIndex: 1,
  tMs: ACCEPTED_AT + 2000,
}

const PRECONF_NOT_OBSERVED: FlashblockResult = { status: 'not-observed' }
const CANONICAL_TIMEOUT: CanonicalResult = { status: 'timed-out' }

// ── calculateTotalFee ─────────────────────────────────────────────────────────

describe('calculateTotalFee', () => {
  it('returns gasUsed * gasPrice + l1Fee', () => {
    expect(calculateTotalFee(100n, 2n, 50n)).toBe(250n)
  })

  it('treats missing l1Fee as 0', () => {
    expect(calculateTotalFee(100n, 2n, undefined)).toBe(200n)
  })

  it('returns undefined when gasUsed is missing', () => {
    expect(calculateTotalFee(undefined, 2n, 10n)).toBeUndefined()
  })

  it('returns undefined when gasPrice is missing', () => {
    expect(calculateTotalFee(100n, undefined, 10n)).toBeUndefined()
  })
})

// ── numericToBigInt ───────────────────────────────────────────────────────────

describe('numericToBigInt', () => {
  it('converts a number string', () => expect(numericToBigInt('42')).toBe(42n))
  it('converts a hex string', () => expect(numericToBigInt('0xff')).toBe(255n))
  it('passes through bigint', () => expect(numericToBigInt(99n)).toBe(99n))
  it('returns undefined for undefined input', () => expect(numericToBigInt(undefined)).toBeUndefined())
  it('returns undefined for non-numeric string', () => expect(numericToBigInt('notanumber')).toBeUndefined())
})

// ── buildRunRecord — all stages present ──────────────────────────────────────

describe('buildRunRecord — complete run', () => {
  it('produces a complete record with correct stage statuses and timing', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_OK,
      preconf: PRECONF_OK,
      providerReceiptMs: 3000,
      gas: {
        gasUsed: 100_000n,
        effectiveGasPrice: 2n,
        l1Fee: 500n,
        providerActualGasUsed: 80_000n,
        providerActualGasCost: 160_000n,
      },
      runIndex: 0,
    })

    expect(record.stages.submit).toEqual({ status: 'ok', ms: 300 })
    expect(record.stages.preconf).toEqual({ status: 'ok', ms: 2000 })
    expect(record.stages.canonical).toEqual({ status: 'ok', ms: 4000 })
    expect(record.stages.providerReceipt).toEqual({ status: 'ok', ms: 3000 })

    expect(record.blockPositions.canonical?.blockNumber).toBe(999n)
    expect(record.blockPositions.canonical?.txHash).toBe(TX)
    expect(record.blockPositions.preconf?.blockNumber).toBe(999n)
    expect(record.blockPositions.preconf?.flashblockIndex).toBe(1)

    // Gas: l2 portion = 100_000 * 2 = 200_000; total = 200_000 + 500 = 200_500
    expect(record.gas?.totalFee).toBe(200_500n)
    // Provider-sourced gas labeled distinctly
    expect(record.gas?.providerActualGasUsed).toBe(80_000n)
    expect(record.gas?.providerActualGasCost).toBe(160_000n)

    expect(record.userOpHash).toBe(HASH)
    expect(record.accountAddress).toBe(ADDR)
  })

  it('records block position as the primary finish-line value (not wall-clock)', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_OK,
      preconf: PRECONF_OK,
      runIndex: 0,
    })

    // The blockNumber — skew-immune and independently verifiable — is the primary value
    expect(record.blockPositions.canonical?.blockNumber).toBe(999n)
    expect(record.blockPositions.preconf?.blockNumber).toBe(999n)
    // Wall-clock arrival is embedded in stage.ms only as a secondary tiebreaker
    expect(record.stages.canonical.ms).toBe(4000)
  })
})

// ── buildRunRecord — partial/failed stages ────────────────────────────────────

describe('buildRunRecord — submit failure', () => {
  it('marks submit failed and all downstream stages not-observed', () => {
    const record = buildRunRecord({
      kind: 'submit-failed',
      provider: 'alchemy-light-account',
      protocolClass: '4337-bundler',
      accountTypeLabel: 'Light Account v2',
      runIndex: 1,
      error: 'bundler rejected: gas limit too low',
    })

    expect(record.stages.submit.status).toBe('failed')
    expect(record.stages.submit.reason).toContain('gas limit')
    expect(record.stages.preconf.status).toBe('not-observed')
    expect(record.stages.canonical.status).toBe('not-observed')
    expect(record.stages.providerReceipt.status).toBe('not-observed')
    // No zero-latency masquerade — no ms field when stage is failed/not-observed
    expect(record.stages.submit.ms).toBeUndefined()
    expect(record.error).toContain('gas limit')
  })
})

describe('buildRunRecord — preconf not-observed, canonical ok', () => {
  it('sets preconf not-observed and canonical ok', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_OK,
      preconf: PRECONF_NOT_OBSERVED,
      runIndex: 0,
    })

    expect(record.stages.preconf.status).toBe('not-observed')
    expect(record.stages.canonical.status).toBe('ok')
    expect(record.blockPositions.preconf).toBeUndefined()
    expect(record.blockPositions.canonical?.blockNumber).toBe(999n)
  })
})

describe('buildRunRecord — canonical timed-out', () => {
  it('sets canonical timed-out, preconf ok', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_TIMEOUT,
      preconf: PRECONF_OK,
      runIndex: 0,
    })

    expect(record.stages.preconf.status).toBe('ok')
    expect(record.stages.canonical.status).toBe('timed-out')
    expect(record.blockPositions.canonical).toBeUndefined()
  })
})

describe('buildRunRecord — not-attributable intent relay', () => {
  it('maps not-attributable flashblock result to not-observed with reason', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'zerodev-ultrarelay',
      accountTypeLabel: 'Kernel v3',
      sponsored: { ...SPONSORED, protocolClass: 'intent-relay' },
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_TIMEOUT,
      preconf: { status: 'not-attributable' } satisfies FlashblockResult,
      runIndex: 0,
    })

    expect(record.stages.preconf.status).toBe('not-observed')
    expect(record.stages.preconf.reason).toContain('neutrally attributable')
  })
})

describe('buildRunRecord — null gas', () => {
  it('omits gas field when no gas data is provided', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_OK,
      preconf: PRECONF_NOT_OBSERVED,
      runIndex: 0,
    })

    expect(record.gas).toBeUndefined()
  })

  it('is null-safe when gas components are partially missing', () => {
    const record = buildRunRecord({
      kind: 'success',
      provider: 'alchemy-light-account',
      accountTypeLabel: 'Light Account v2',
      sponsored: SPONSORED,
      acceptedAtMs: ACCEPTED_AT,
      canonical: CANONICAL_OK,
      preconf: PRECONF_NOT_OBSERVED,
      gas: { gasUsed: undefined, effectiveGasPrice: undefined },
      runIndex: 0,
    })

    expect(record.gas?.totalFee).toBeUndefined()
  })
})
