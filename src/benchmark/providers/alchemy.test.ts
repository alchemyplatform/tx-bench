import { describe, expect, it } from 'bun:test'
import { createAlchemyAdapter } from './alchemy'
import type { Config } from '../config'

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 1,
  providers: {
    alchemy: { apiKey: 'test-api-key', policyId: 'test-policy', rpcUrl: 'https://example.com' },
    pimlico: null,
    zerodev: null,
  },
  neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
  timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
}

const NO_ALCHEMY_CONFIG: Config = { ...BASE_CONFIG, providers: { ...BASE_CONFIG.providers, alchemy: null } }

// Minimal mock that captures the last policyId used and returns a deterministic result
function makeMockCreateClient(addressSeed = 0) {
  let callIndex = 0
  const capturedPolicyIds: string[] = []

  const fn = async (params: { policyId: string; [k: string]: unknown }) => {
    capturedPolicyIds.push(params.policyId)
    const idx = ++callIndex
    const address = `0x${idx.toString().padStart(40, '0')}` as `0x${string}`
    return {
      account: { address },
      sendUserOperation: async (_uo: unknown) => ({
        hash: `0x${(addressSeed + idx).toString(16).padStart(64, '0')}` as `0x${string}`,
      }),
    }
  }
  return { fn: fn as unknown as typeof import('@account-kit/smart-contracts').createLightAccountAlchemyClient, capturedPolicyIds }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('alchemyAdapter — metadata', () => {
  it('has id alchemy-light-account and protocolClass 4337-bundler', () => {
    const adapter = createAlchemyAdapter()
    expect(adapter.id).toBe('alchemy-light-account')
    expect(adapter.protocolClass).toBe('4337-bundler')
    expect(adapter.accountTypeLabel).toBe('Light Account v2')
  })
})

describe('alchemyAdapter — buildAccountClient', () => {
  it('throws when alchemy config is absent', async () => {
    const adapter = createAlchemyAdapter()
    await expect(adapter.buildAccountClient(NO_ALCHEMY_CONFIG)).rejects.toThrow('ALCHEMY_API_KEY')
  })
})

describe('alchemyAdapter — sendSponsored', () => {
  it('returns userOpHash, protocolClass 4337-bundler, and positive submitMs', async () => {
    const { fn: mockCreate } = makeMockCreateClient()
    const adapter = createAlchemyAdapter({ createClient: mockCreate })
    const client = await adapter.buildAccountClient(BASE_CONFIG)

    const result = await client.sendSponsored()

    expect(result.protocolClass).toBe('4337-bundler')
    expect(result.userOpHash).toMatch(/^0x[0-9a-f]+$/)
    expect(result.submitMs).toBeGreaterThanOrEqual(0)
    expect(result.accountAddress).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('uses policyId from config when calling the SDK', async () => {
    const { fn: mockCreate, capturedPolicyIds } = makeMockCreateClient()
    const adapter = createAlchemyAdapter({ createClient: mockCreate })
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    await client.sendSponsored()

    expect(capturedPolicyIds).toContain('test-policy')
  })

  it('generates a fresh owner per call — account addresses differ across runs', async () => {
    const { fn: mockCreate } = makeMockCreateClient()
    const adapter = createAlchemyAdapter({ createClient: mockCreate })
    const client = await adapter.buildAccountClient(BASE_CONFIG)

    const r1 = await client.sendSponsored()
    const r2 = await client.sendSponsored()

    expect(r1.accountAddress).not.toBe(r2.accountAddress)
  })
})
