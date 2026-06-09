import { describe, expect, it } from 'bun:test'
import { createPimlicoAdapter } from './pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import type { Config } from '../config'

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 1,
  providers: {
    alchemy: null,
    pimlico: {
      apiKey: 'test-pimlico-key',
      policyId: 'test-pimlico-policy',
      rpcUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=test-pimlico-key',
    },
    zerodev: null,
  },
  neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
  timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
}

const NO_PIMLICO_CONFIG: Config = { ...BASE_CONFIG, providers: { ...BASE_CONFIG.providers, pimlico: null } }

type EntryPointArg = { address: `0x${string}`; version: string }

function makeMocks() {
  let callIndex = 0
  const capturedEntryPoints: EntryPointArg[] = []
  const capturedPolicies: string[] = []

  const createSafeAccount = async (params: { entryPoint: EntryPointArg; [k: string]: unknown }) => {
    capturedEntryPoints.push(params.entryPoint)
    const idx = ++callIndex
    const address = `0x${idx.toString().padStart(40, '0')}` as `0x${string}`
    return { address, type: 'smart' } as unknown as Awaited<ReturnType<typeof import('./pimlico').createPimlicoAdapter>>
  }

  const createPimlicoClient = (_params: unknown) => ({
    getPaymasterData: async () => ({ paymaster: '0x' as `0x${string}`, paymasterData: '0x' as `0x${string}` }),
    getPaymasterStubData: async () => ({ paymaster: '0x' as `0x${string}`, paymasterData: '0x' as `0x${string}` }),
  })

  // Intercept bundlerClient.sendUserOperation via the sendSponsored call
  // We need to patch createBundlerClient — but since we can't easily inject it,
  // we verify behavior at the createSafeAccount level and trust the bundler chain.
  // The hash is produced by the mock Pimlico paymaster responses above.

  return { createSafeAccount, createPimlicoClient, capturedEntryPoints, capturedPolicies }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pimlicoAdapter — metadata', () => {
  it('has id pimlico-safe and protocolClass 4337-bundler', () => {
    const adapter = createPimlicoAdapter()
    expect(adapter.id).toBe('pimlico-safe')
    expect(adapter.protocolClass).toBe('4337-bundler')
    expect(adapter.accountTypeLabel).toBe('Safe')
  })
})

describe('pimlicoAdapter — buildAccountClient', () => {
  it('throws when pimlico config is absent', async () => {
    const adapter = createPimlicoAdapter()
    await expect(adapter.buildAccountClient(NO_PIMLICO_CONFIG)).rejects.toThrow('PIMLICO_API_KEY')
  })
})

describe('pimlicoAdapter — sendSponsored (mocked account creation)', () => {
  it('passes entryPoint as explicit { address, version } object — guards against 0.1 API', async () => {
    const { capturedEntryPoints } = makeMocks()
    let capturedEP: EntryPointArg | null = null

    const createSafeAccount = async (params: { entryPoint: EntryPointArg; [k: string]: unknown }) => {
      capturedEP = params.entryPoint
      const address = '0x0000000000000000000000000000000000000001' as `0x${string}`
      return { address, type: 'smart' } as unknown as Awaited<ReturnType<typeof import('permissionless/accounts').toSafeSmartAccount>>
    }

    // We cannot fully exercise sendSponsored without a bundler — but we can verify
    // the entryPoint shape that reaches toSafeSmartAccount via a spy wrapper.
    // Since createBundlerClient uses real networking, we only assert the entryPoint capture.
    const adapter = createPimlicoAdapter({
      createSafeAccount: createSafeAccount as unknown as typeof import('permissionless/accounts').toSafeSmartAccount,
    })

    const client = await adapter.buildAccountClient(BASE_CONFIG)
    // sendSponsored will fail at the bundler step (no real network), but we capture before that
    await client.sendSponsored().catch(() => {})

    expect(capturedEP).not.toBeNull()
    expect(capturedEP!.address).toBe(entryPoint07Address)
    expect(capturedEP!.version).toBe('0.7')
  })

  it('generates a fresh owner per call — createSafeAccount called with different owners', async () => {
    const ownersSeen: string[] = []

    const createSafeAccount = async (params: { owners: Array<{ address: `0x${string}` }>; entryPoint: EntryPointArg; [k: string]: unknown }) => {
      ownersSeen.push(params.owners[0].address)
      const address = `0x${ownersSeen.length.toString().padStart(40, '0')}` as `0x${string}`
      return { address, type: 'smart' } as unknown as Awaited<ReturnType<typeof import('permissionless/accounts').toSafeSmartAccount>>
    }

    const adapter = createPimlicoAdapter({
      createSafeAccount: createSafeAccount as unknown as typeof import('permissionless/accounts').toSafeSmartAccount,
    })

    const client = await adapter.buildAccountClient(BASE_CONFIG)
    await client.sendSponsored().catch(() => {})
    await client.sendSponsored().catch(() => {})

    expect(ownersSeen.length).toBe(2)
    expect(ownersSeen[0]).not.toBe(ownersSeen[1])
  })
})
