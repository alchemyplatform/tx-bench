import { describe, expect, it } from 'bun:test'
import { redactConfig, buildOutput, serializeOutput } from './output'
import type { Config } from './config'
import type { ProviderRunResult } from './service'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const API_KEY = 'actual-api-key-12345'
const POLICY_ID = 'actual-policy-id-67890'
const ZD_KEY = 'zerodev-key-abcdef'
const ZD_PROJECT = 'project-id-xyz'
const PRIV_KEY = ('0x' + 'f'.repeat(64)) as `0x${string}`

const FULL_CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 3,
  ownerPrivateKey: PRIV_KEY,
  providers: {
    alchemy: { apiKey: API_KEY, policyId: POLICY_ID, rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${API_KEY}` },
    pimlico: { apiKey: 'pimlico-key', policyId: 'pimlico-policy', rpcUrl: `https://api.pimlico.io/v2/8453/rpc?apikey=pimlico-key` },
    zerodev: { apiKey: ZD_KEY, projectId: ZD_PROJECT, rpcUrl: `https://rpc.zerodev.app/api/v3/${ZD_PROJECT}/chain/8453` },
  },
  neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
  timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
}

const EMPTY_RESULTS: ProviderRunResult[] = []

// ── redactConfig ──────────────────────────────────────────────────────────────

describe('redactConfig', () => {
  it('replaces API key with [REDACTED]', () => {
    const redacted = JSON.stringify(redactConfig(FULL_CONFIG))
    expect(redacted).not.toContain(API_KEY)
    expect(redacted).toContain('[REDACTED]')
  })

  it('replaces policy ID with [REDACTED]', () => {
    const redacted = JSON.stringify(redactConfig(FULL_CONFIG))
    expect(redacted).not.toContain(POLICY_ID)
  })

  it('replaces private key with [REDACTED]', () => {
    const redacted = JSON.stringify(redactConfig(FULL_CONFIG))
    expect(redacted).not.toContain(PRIV_KEY)
  })

  it('redacts API key embedded in URL path/query segment', () => {
    // Alchemy key is in the RPC URL path; Pimlico key is in apikey= query param
    const redacted = JSON.stringify(redactConfig(FULL_CONFIG))
    expect(redacted).not.toContain(API_KEY)          // Alchemy key in URL path
    expect(redacted).not.toContain('pimlico-key')    // Pimlico key in URL query
    expect(redacted).not.toContain(ZD_KEY)            // ZeroDev API key
  })

  it('preserves non-secret config fields after redaction', () => {
    const redacted = redactConfig(FULL_CONFIG) as Record<string, unknown>
    expect(redacted.network).toBe('base-mainnet')
    expect(redacted.runCount).toBe(3)
  })
})

// ── buildOutput ───────────────────────────────────────────────────────────────

describe('buildOutput', () => {
  it('includes a preconfAvailable flag', () => {
    const out = buildOutput({ config: FULL_CONFIG, results: EMPTY_RESULTS, preconfAvailable: false })
    expect(out.preconfAvailable).toBe(false)
  })

  it('includes an environment block with toolVersion and generatedAt', () => {
    const out = buildOutput({ config: FULL_CONFIG, results: EMPTY_RESULTS, preconfAvailable: false })
    expect(out.env.toolVersion).toBeTruthy()
    expect(out.env.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('redacts config secrets in the output', () => {
    const out = buildOutput({ config: FULL_CONFIG, results: EMPTY_RESULTS, preconfAvailable: false })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain(POLICY_ID)
    expect(serialized).not.toContain(PRIV_KEY)
  })
})

// ── serializeOutput ───────────────────────────────────────────────────────────

describe('serializeOutput', () => {
  it('round-trips as valid JSON', () => {
    const out = buildOutput({ config: FULL_CONFIG, results: EMPTY_RESULTS, preconfAvailable: false })
    const json = serializeOutput(out)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('serializes bigint values as strings', () => {
    const out = buildOutput({
      config: FULL_CONFIG,
      results: [{
        row: { id: 'test', label: 'Test', protocolClass: '4337-bundler', accountTypeLabel: 'T', requiredEnv: [], runnable: true, missingEnv: [] },
        records: [{
          provider: 'test',
          runIndex: 0,
          protocolClass: '4337-bundler',
          accountTypeLabel: 'T',
          accountAddress: '0x0000000000000000000000000000000000000001',
          userOpHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
          stages: {
            submit: { status: 'ok', ms: 300 },
            preconf: { status: 'not-observed' },
            canonical: { status: 'ok', ms: 3000 },
            providerReceipt: { status: 'not-observed' },
          },
          blockPositions: { canonical: { blockNumber: 999999n, txHash: ('0x' + 'cc'.repeat(32)) as `0x${string}` } },
        }],
        metrics: { provider: 'test', protocolClass: '4337-bundler', accountTypeLabel: 'T', runCount: 1, failureCount: 0, stages: {} },
      }],
      preconfAvailable: false,
    })
    const json = serializeOutput(out)
    // bigint 999999n should be serialized as the string "999999"
    expect(json).toContain('"999999"')
    // Should not appear as a JSON number (which would be 999999 without quotes)
    expect(json).not.toContain(': 999999')
  })

  it('renders failed stages explicitly — no blank or zero substitution', () => {
    const out = buildOutput({
      config: FULL_CONFIG,
      results: [{
        row: { id: 'test', label: 'Test', protocolClass: '4337-bundler', accountTypeLabel: 'T', requiredEnv: [], runnable: true, missingEnv: [] },
        records: [{
          provider: 'test',
          runIndex: 0,
          protocolClass: '4337-bundler',
          accountTypeLabel: 'T',
          accountAddress: '0x0000000000000000000000000000000000000001',
          userOpHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
          stages: {
            submit: { status: 'failed', reason: 'bundler rejected' },
            preconf: { status: 'not-observed' },
            canonical: { status: 'timed-out' },
            providerReceipt: { status: 'not-observed' },
          },
          blockPositions: {},
          error: 'bundler rejected',
        }],
        metrics: { provider: 'test', protocolClass: '4337-bundler', accountTypeLabel: 'T', runCount: 1, failureCount: 1, stages: {} },
      }],
      preconfAvailable: false,
    })
    const json = serializeOutput(out)
    expect(json).toContain('"failed"')
    expect(json).toContain('"timed-out"')
    expect(json).toContain('"not-observed"')
  })
})
