import { describe, expect, it } from 'bun:test'
import { createAlchemyMAv2BSOAdapter } from './alchemy-mav2-bso'
import { resolveChain } from '../chains'
import type { Config } from '../config'
import type { Chain } from 'viem'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(network = 'base-mainnet'): Config {
  return {
    network,
    runCount: 1,
    providers: {
      alchemy: {
        apiKey: 'test-api-key',
        policyId: 'test-policy',
        rpcUrl: 'https://example.com',
        bsoPolicyId: 'test-bso-policy',
      },
      pimlico: null,
      zerodev: null,
    },
    neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
    timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
  }
}

function makeMockToAccount() {
  let callIndex = 0
  const capturedChains: Chain[] = []
  const fn = async (params: { client: { chain: Chain }; owner: unknown }) => {
    capturedChains.push(params.client.chain)
    const idx = ++callIndex
    return {
      address: `0x${idx.toString().padStart(40, '0')}` as `0x${string}`,
    }
  }
  return { fn: fn as unknown as typeof import('@alchemy/smart-accounts').toModularAccountV2, capturedChains }
}

function makeMockBundlerClient(chainCaptures: Chain[]) {
  const fn = (params: { chain: Chain; [k: string]: unknown }) => {
    chainCaptures.push(params.chain)
    return {
      sendUserOperation: async (_uo: unknown) => ({
        hash: '0x' + 'a'.repeat(64) as `0x${string}`,
      }),
    }
  }
  return fn
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('alchemyMAv2BSOAdapter — metadata', () => {
  it('has id alchemy-mav2-bso and protocolClass 4337-bundler', () => {
    const adapter = createAlchemyMAv2BSOAdapter()
    expect(adapter.id).toBe('alchemy-mav2-bso')
    expect(adapter.protocolClass).toBe('4337-bundler')
    expect(adapter.accountTypeLabel).toBe('Modular Account v2 (BSO)')
  })
})

describe('alchemyMAv2BSOAdapter — buildAccountClient', () => {
  it('throws when alchemy config is absent', async () => {
    const adapter = createAlchemyMAv2BSOAdapter()
    const config = makeConfig()
    config.providers.alchemy = null
    await expect(adapter.buildAccountClient(config)).rejects.toThrow('ALCHEMY_API_KEY')
  })

  it('throws when BSO policy is absent', async () => {
    const adapter = createAlchemyMAv2BSOAdapter()
    const config = makeConfig()
    config.providers.alchemy!.bsoPolicyId = null
    await expect(adapter.buildAccountClient(config)).rejects.toThrow('BSO_POLICY_ID')
  })
})

describe('alchemyMAv2BSOAdapter — network-aware chain resolution', () => {
  it('uses the Ethereum chain (id 1) when config.network = eth-mainnet', async () => {
    const { fn: mockToAccount, capturedChains } = makeMockToAccount()
    const bundlerChains: Chain[] = []
    // We need to intercept createBundlerClient — but it's not injectable.
    // Instead, verify the chain passed to toAccount (via publicClient) is correct.
    const adapter = createAlchemyMAv2BSOAdapter({
      toAccount: mockToAccount,
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('eth-mainnet'))

    // sendSponsored will throw after toAccount because the real bundler client
    // will fail without a real RPC — but the chain capture happens first.
    try {
      await client.sendSponsored()
    } catch {
      // expected — no real RPC
    }

    expect(capturedChains.length).toBeGreaterThanOrEqual(1)
    expect(capturedChains[0].id).toBe(1) // mainnet chain id
  })

  it('uses the Base chain (id 8453) when config.network = base-mainnet', async () => {
    const { fn: mockToAccount, capturedChains } = makeMockToAccount()
    const adapter = createAlchemyMAv2BSOAdapter({
      toAccount: mockToAccount,
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('base-mainnet'))

    try {
      await client.sendSponsored()
    } catch {
      // expected — no real RPC
    }

    expect(capturedChains.length).toBeGreaterThanOrEqual(1)
    expect(capturedChains[0].id).toBe(8453) // base chain id
  })

  it('throws a descriptive error for an unknown network', async () => {
    const adapter = createAlchemyMAv2BSOAdapter({
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('unknown-chain'))

    await expect(client.sendSponsored()).rejects.toThrow('Unknown network "unknown-chain"')
  })

  it('resolves distinct chains across eth-mainnet, base-mainnet, opt-mainnet, arb-mainnet', async () => {
    const networks = ['eth-mainnet', 'base-mainnet', 'opt-mainnet', 'arb-mainnet']
    const expectedChainIds = [1, 8453, 10, 42161]

    for (let i = 0; i < networks.length; i++) {
      const { fn: mockToAccount, capturedChains } = makeMockToAccount()
      const adapter = createAlchemyMAv2BSOAdapter({
        toAccount: mockToAccount,
        generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
      })
      const client = await adapter.buildAccountClient(makeConfig(networks[i]))

      try {
        await client.sendSponsored()
      } catch {
        // expected
      }

      expect(capturedChains[0]?.id).toBe(expectedChainIds[i])
    }
  })
})
