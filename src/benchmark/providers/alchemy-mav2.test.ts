import { describe, expect, it } from 'bun:test'
import { createAlchemyMAv2Adapter } from './alchemy-mav2'
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
  return { fn: fn as unknown as typeof import('@account-kit/smart-contracts').createModularAccountV2Client, capturedPolicyIds }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('alchemyMAv2Adapter — metadata', () => {
  it('has id alchemy-modular-account-v2 and protocolClass 4337-bundler', () => {
    const adapter = createAlchemyMAv2Adapter()
    expect(adapter.id).toBe('alchemy-modular-account-v2')
    expect(adapter.protocolClass).toBe('4337-bundler')
    expect(adapter.accountTypeLabel).toBe('Modular Account v2')
  })
})

describe('alchemyMAv2Adapter — buildAccountClient', () => {
  it('throws when alchemy config is absent', async () => {
    const adapter = createAlchemyMAv2Adapter()
    await expect(adapter.buildAccountClient(NO_ALCHEMY_CONFIG)).rejects.toThrow('ALCHEMY_API_KEY')
  })
})

describe('alchemyMAv2Adapter — sendSponsored', () => {
  it('returns userOpHash, protocolClass 4337-bundler, and positive submitMs', async () => {
    const { fn: mockCreate } = makeMockCreateClient()
    const adapter = createAlchemyMAv2Adapter({ createClient: mockCreate })
    const client = await adapter.buildAccountClient(BASE_CONFIG)

    const result = await client.sendSponsored()

    expect(result.protocolClass).toBe('4337-bundler')
    expect(result.userOpHash).toMatch(/^0x[0-9a-f]+$/)
    expect(result.submitMs).toBeGreaterThanOrEqual(0)
    expect(result.accountAddress).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('uses policyId from config when calling the SDK', async () => {
    const { fn: mockCreate, capturedPolicyIds } = makeMockCreateClient()
    const adapter = createAlchemyMAv2Adapter({ createClient: mockCreate })
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    await client.sendSponsored()

    expect(capturedPolicyIds).toContain('test-policy')
  })

  it('generates a fresh owner key per sendSponsored call', async () => {
    const { fn: mockCreate } = makeMockCreateClient()
    const keys: string[] = []
    const adapter = createAlchemyMAv2Adapter({
      createClient: mockCreate,
      generateKey: () => {
        const k = `0x${'ab'.repeat(32)}` as `0x${string}`
        keys.push(k)
        return k
      },
    })
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    await client.sendSponsored()
    await client.sendSponsored()

    expect(keys).toHaveLength(2)
  })
})
