import { describe, expect, it } from 'bun:test'
import { runPreflight, isNeutralOverlap } from './preflight'
import type { Config } from './config'
import type { ProviderRow } from './contracts'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 3,
  providers: {
    alchemy: { apiKey: 'key', policyId: 'policy', rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/key' },
    pimlico: null,
    zerodev: null,
  },
  neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
  timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
}

const ALCHEMY_ROW: ProviderRow = {
  id: 'alchemy-light-account',
  label: 'Alchemy (Light Account)',
  protocolClass: '4337-bundler',
  accountTypeLabel: 'Light Account v2',
  requiredEnv: ['ALCHEMY_API_KEY', 'ALCHEMY_POLICY_ID'],
  runnable: true,
  missingEnv: [],
}

// Mock deps
const sameChainId = async (_url: string) => 8453
const differentChainId = (badUrl: string) => async (url: string) =>
  url === badUrl ? 1 : 8453

// ── isNeutralOverlap ─────────────────────────────────────────────────────────

describe('isNeutralOverlap', () => {
  it('detects when neutral host matches a provider host', () => {
    expect(isNeutralOverlap(
      'https://base-mainnet.g.alchemy.com/v2/KEY',
      ['https://base-mainnet.g.alchemy.com/v2/OTHER']
    )).toBe(true)
  })

  it('returns false when neutral host is distinct from all providers', () => {
    expect(isNeutralOverlap(
      'https://mainnet.base.org',
      ['https://base-mainnet.g.alchemy.com/v2/KEY', 'https://api.pimlico.io/v2/8453/rpc']
    )).toBe(false)
  })
})

// ── runPreflight — neutrality guard ──────────────────────────────────────────

describe('runPreflight — neutrality guard', () => {
  it('returns error when neutral node URL overlaps a provider', async () => {
    const config: Config = {
      ...BASE_CONFIG,
      neutral: { rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/key', flashblockWsUrl: null },
    }
    const result = await runPreflight(config, [ALCHEMY_ROW], {
      probeChainId: sameChainId,
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('overlaps')
    }
  })
})

// ── runPreflight — chain ID checks ───────────────────────────────────────────

describe('runPreflight — chain ID agreement', () => {
  it('passes when neutral and all providers agree on chain ID', async () => {
    const result = await runPreflight(BASE_CONFIG, [ALCHEMY_ROW], {
      probeChainId: sameChainId,
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(true)
  })

  it('fails when a provider returns a different chain ID', async () => {
    const badProber = differentChainId('https://base-mainnet.g.alchemy.com/v2/key')
    const result = await runPreflight(BASE_CONFIG, [ALCHEMY_ROW], {
      probeChainId: badProber,
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('mismatch')
    }
  })

  it('fails when chain ID probe throws (invalid key / down node)', async () => {
    const result = await runPreflight(BASE_CONFIG, [ALCHEMY_ROW], {
      probeChainId: async () => { throw new Error('Connection refused') },
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('probe failed')
    }
  })
})

// ── runPreflight — flashblock probe ──────────────────────────────────────────

describe('runPreflight — flashblock probe', () => {
  it('sets flashblockAvailable=true when WS probe succeeds', async () => {
    const config: Config = {
      ...BASE_CONFIG,
      neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: 'wss://flashblocks.example.com' },
    }
    const result = await runPreflight(config, [ALCHEMY_ROW], {
      probeChainId: sameChainId,
      probeFlashblock: async () => true,
    })

    expect(result.ok).toBe(true)
    expect(result.flashblockAvailable).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('sets flashblockAvailable=false and warns when WS probe fails', async () => {
    const config: Config = {
      ...BASE_CONFIG,
      neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: 'wss://unreachable.example.com' },
    }
    const result = await runPreflight(config, [ALCHEMY_ROW], {
      probeChainId: sameChainId,
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(true)
    expect(result.flashblockAvailable).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('warns and proceeds in canonical-only mode when no WS URL is configured', async () => {
    const result = await runPreflight(BASE_CONFIG, [ALCHEMY_ROW], {
      probeChainId: sameChainId,
      probeFlashblock: async () => false,
    })

    expect(result.ok).toBe(true)
    expect(result.flashblockAvailable).toBe(false)
    expect(result.warnings.some(w => w.includes('canonical-only'))).toBe(true)
  })
})
