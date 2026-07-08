import { describe, expect, it } from 'bun:test'
import { createAlchemyWalletSendCallsAdapter } from './alchemy-wallet-sendcalls'
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
      },
      pimlico: null,
      zerodev: null,
    },
    neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
    timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
  }
}

function makeMockCreateClient(chainCaptures: Chain[]) {
  const fn = (params: { chain: Chain; signer: unknown; [k: string]: unknown }) => {
    chainCaptures.push(params.chain)
    const signerAddr = (params.signer as { address: `0x${string}` }).address
    return {
      sendCalls: async () => ({ id: '0x' + '1'.repeat(64) }),
      waitForCallsStatus: async () => ({
        status: 'success',
        receipts: [{ blockNumber: 100n, transactionHash: '0x' + '2'.repeat(64) }],
      }),
    }
  }
  return fn as unknown as typeof import('@alchemy/wallet-apis').createSmartWalletClient
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('alchemyWalletSendCallsAdapter — metadata', () => {
  it('has id alchemy-wallet-sendcalls and protocolClass wallet-sendcalls', () => {
    const adapter = createAlchemyWalletSendCallsAdapter()
    expect(adapter.id).toBe('alchemy-wallet-sendcalls')
    expect(adapter.protocolClass).toBe('wallet-sendcalls')
    expect(adapter.accountTypeLabel).toBe('Smart Wallet (EIP-7702)')
  })
})

describe('alchemyWalletSendCallsAdapter — buildAccountClient', () => {
  it('throws when alchemy config is absent', async () => {
    const adapter = createAlchemyWalletSendCallsAdapter()
    const config = makeConfig()
    config.providers.alchemy = null
    await expect(adapter.buildAccountClient(config)).rejects.toThrow('ALCHEMY_API_KEY')
  })
})

describe('alchemyWalletSendCallsAdapter — network-aware chain resolution', () => {
  it('uses the Ethereum chain (id 1) when config.network = eth-mainnet', async () => {
    const chainCaptures: Chain[] = []
    const adapter = createAlchemyWalletSendCallsAdapter({
      createClient: makeMockCreateClient(chainCaptures),
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('eth-mainnet'))
    await client.sendSponsored()

    expect(chainCaptures).toHaveLength(1)
    expect(chainCaptures[0].id).toBe(1)
  })

  it('uses the Base chain (id 8453) when config.network = base-mainnet', async () => {
    const chainCaptures: Chain[] = []
    const adapter = createAlchemyWalletSendCallsAdapter({
      createClient: makeMockCreateClient(chainCaptures),
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('base-mainnet'))
    await client.sendSponsored()

    expect(chainCaptures).toHaveLength(1)
    expect(chainCaptures[0].id).toBe(8453)
  })

  it('throws a descriptive error for an unknown network', async () => {
    const adapter = createAlchemyWalletSendCallsAdapter({
      createClient: makeMockCreateClient([]),
      generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('unknown-chain'))

    await expect(client.sendSponsored()).rejects.toThrow('Unknown network "unknown-chain"')
  })

  it('resolves distinct chains across eth-mainnet, base-mainnet, opt-mainnet, arb-mainnet', async () => {
    const networks = ['eth-mainnet', 'base-mainnet', 'opt-mainnet', 'arb-mainnet']
    const expectedChainIds = [1, 8453, 10, 42161]

    for (let i = 0; i < networks.length; i++) {
      const chainCaptures: Chain[] = []
      const adapter = createAlchemyWalletSendCallsAdapter({
        createClient: makeMockCreateClient(chainCaptures),
        generateKey: () => '0x' + 'ab'.repeat(32) as `0x${string}`,
      })
      const client = await adapter.buildAccountClient(makeConfig(networks[i]))
      await client.sendSponsored()

      expect(chainCaptures[0].id).toBe(expectedChainIds[i])
    }
  })

  it('returns correct SponsoredResult with resolved chain (happy path)', async () => {
    const chainCaptures: Chain[] = []
    const adapter = createAlchemyWalletSendCallsAdapter({
      createClient: makeMockCreateClient(chainCaptures),
      generateKey: () => '0x' + 'cd'.repeat(32) as `0x${string}`,
    })
    const client = await adapter.buildAccountClient(makeConfig('base-mainnet'))
    const result = await client.sendSponsored()

    expect(result.protocolClass).toBe('wallet-sendcalls')
    expect(result.userOpHash).toMatch(/^0x[0-9a-f]+$/)
    expect(result.submitMs).toBeGreaterThanOrEqual(0)
    expect(result.accountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(result.inlineCanonical).toBeDefined()
    expect(chainCaptures[0].id).toBe(8453)
  })
})
