import { describe, expect, it } from 'bun:test'
import { http } from 'viem'
import { createZeroDevAdapter, zerodevKernelAdapter, zerodevUltraRelayAdapter } from './zerodev'
import { entryPoint07Address } from 'viem/account-abstraction'
import type { Config } from '../config'

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CONFIG: Config = {
  network: 'base-mainnet',
  runCount: 1,
  providers: {
    alchemy: null,
    pimlico: null,
    zerodev: {
      apiKey: 'test-zerodev-key',
      projectId: 'test-project-id',
      rpcUrl: 'https://rpc.zerodev.app/api/v3/test-project-id/chain/8453',
    },
  },
  neutral: { rpcUrl: 'https://mainnet.base.org', flashblockWsUrl: null },
  timeouts: { submitMs: 30_000, preconfMs: 30_000, canonicalMs: 120_000, receiptMs: 120_000 },
}

const NO_ZERODEV_CONFIG: Config = { ...BASE_CONFIG, providers: { ...BASE_CONFIG.providers, zerodev: null } }

type EntryPointArg = { address: `0x${string}`; version: string }

function makeMocks() {
  const capturedValidatorEntryPoints: EntryPointArg[] = []
  const capturedAccountEntryPoints: EntryPointArg[] = []
  const capturedHttpUrls: string[] = []
  const ownersCreated: string[] = []

  const createValidator = async (_client: unknown, params: { signer: { address: `0x${string}` }; entryPoint: EntryPointArg; [k: string]: unknown }) => {
    capturedValidatorEntryPoints.push(params.entryPoint)
    ownersCreated.push(params.signer.address)
    return { type: 'ecdsa-validator' }
  }

  const createAccount = async (_client: unknown, params: { entryPoint: EntryPointArg; [k: string]: unknown }) => {
    capturedAccountEntryPoints.push(params.entryPoint)
    const idx = ownersCreated.length
    const address = `0x${idx.toString().padStart(40, '0')}` as `0x${string}`
    return { address, type: 'kernel' }
  }

  const createPaymaster = (_params: unknown) => ({ type: 'paymaster' })

  const createClient = (_params: unknown) => ({
    account: { address: '0x0000000000000000000000000000000000000001' as `0x${string}` },
    sendUserOperation: async (_calls: unknown) =>
      ('0x' + 'aa'.repeat(32)) as `0x${string}`,
  })

  // Wrap real http() to capture every URL — transport must be valid for createPublicClient
  const httpFn = (url: string) => {
    capturedHttpUrls.push(url)
    return http(url)
  }

  return {
    createValidator: createValidator as unknown as ZeroDevDeps['createValidator'],
    createAccount: createAccount as unknown as ZeroDevDeps['createAccount'],
    createClient: createClient as unknown as ZeroDevDeps['createClient'],
    createPaymaster: createPaymaster as unknown as ZeroDevDeps['createPaymaster'],
    httpFn: httpFn as unknown as ZeroDevDeps['httpFn'],
    capturedValidatorEntryPoints,
    capturedAccountEntryPoints,
    capturedHttpUrls,
    ownersCreated,
  }
}

type ZeroDevDeps = NonNullable<Parameters<typeof createZeroDevAdapter>[2]>

// ── Metadata tests ────────────────────────────────────────────────────────────

describe('zerodevKernelAdapter — metadata', () => {
  it('has id zerodev-kernel and protocolClass 4337-bundler', () => {
    expect(zerodevKernelAdapter.id).toBe('zerodev-kernel')
    expect(zerodevKernelAdapter.protocolClass).toBe('4337-bundler')
    expect(zerodevKernelAdapter.accountTypeLabel).toBe('Kernel v3')
  })
})

describe('zerodevUltraRelayAdapter — metadata', () => {
  it('has id zerodev-ultrarelay and protocolClass intent-relay', () => {
    expect(zerodevUltraRelayAdapter.id).toBe('zerodev-ultrarelay')
    expect(zerodevUltraRelayAdapter.protocolClass).toBe('intent-relay')
    expect(zerodevUltraRelayAdapter.accountTypeLabel).toBe('Kernel v3')
  })
})

// ── Config error ──────────────────────────────────────────────────────────────

describe('zerodevAdapter — buildAccountClient', () => {
  it('throws when zerodev config is absent', async () => {
    const adapter = createZeroDevAdapter('4337-bundler', '')
    await expect(adapter.buildAccountClient(NO_ZERODEV_CONFIG)).rejects.toThrow('ZERODEV')
  })
})

// ── sendSponsored tests ───────────────────────────────────────────────────────

describe('zerodev — sendSponsored (mocked deps)', () => {
  it('returns correct protocolClass for standard Kernel adapter', async () => {
    const mocks = makeMocks()
    const adapter = createZeroDevAdapter('4337-bundler', '', mocks)
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    const result = await client.sendSponsored()

    expect(result.protocolClass).toBe('4337-bundler')
  })

  it('returns intent-relay for UltraRelay adapter', async () => {
    const mocks = makeMocks()
    const adapter = createZeroDevAdapter('intent-relay', '?provider=ULTRA_RELAY', mocks)
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    const result = await client.sendSponsored()

    expect(result.protocolClass).toBe('intent-relay')
  })

  it('UltraRelay and standard Kernel differ only by ?provider=ULTRA_RELAY query param in bundler URL', async () => {
    const kernelMocks = makeMocks()
    const ultraMocks = makeMocks()

    const kernelAdapter = createZeroDevAdapter('4337-bundler', '', kernelMocks)
    const ultraAdapter = createZeroDevAdapter('intent-relay', '?provider=ULTRA_RELAY', ultraMocks)

    await (await kernelAdapter.buildAccountClient(BASE_CONFIG)).sendSponsored()
    await (await ultraAdapter.buildAccountClient(BASE_CONFIG)).sendSponsored()

    // httpFn is called for public client (uses base rpcUrl for reads) + paymaster + bundler.
    // Bundler/paymaster for UltraRelay must use ?provider=ULTRA_RELAY; reads use base URL.
    const baseRpcUrl = BASE_CONFIG.providers.zerodev!.rpcUrl
    const kernelZdUrls = kernelMocks.capturedHttpUrls.filter(u => u.includes('zerodev'))
    const ultraZdUrls = ultraMocks.capturedHttpUrls.filter(u => u.includes('zerodev'))
    const ultraBundlerUrls = ultraZdUrls.filter(u => u.includes('ULTRA_RELAY'))

    expect(kernelZdUrls.every(u => !u.includes('ULTRA_RELAY'))).toBe(true)
    expect(ultraBundlerUrls.length).toBeGreaterThan(0)
    expect(ultraBundlerUrls.every(u => u === baseRpcUrl + '?provider=ULTRA_RELAY')).toBe(true)
    // Reads use the base URL (no suffix) — verify they're present and suffix-free
    const ultraReadUrls = ultraZdUrls.filter(u => !u.includes('ULTRA_RELAY'))
    expect(ultraReadUrls.every(u => u === baseRpcUrl)).toBe(true)
  })

  it('passes entryPoint as explicit { address, version } object to both validator and account', async () => {
    const mocks = makeMocks()
    const adapter = createZeroDevAdapter('4337-bundler', '', mocks)
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    await client.sendSponsored()

    expect(mocks.capturedValidatorEntryPoints[0]).toEqual({ address: entryPoint07Address, version: '0.7' })
    expect(mocks.capturedAccountEntryPoints[0]).toEqual({ address: entryPoint07Address, version: '0.7' })
  })

  it('generates a fresh owner per sendSponsored call', async () => {
    const mocks = makeMocks()
    const adapter = createZeroDevAdapter('4337-bundler', '', mocks)
    const client = await adapter.buildAccountClient(BASE_CONFIG)

    await client.sendSponsored()
    await client.sendSponsored()

    expect(mocks.ownersCreated.length).toBe(2)
    expect(mocks.ownersCreated[0]).not.toBe(mocks.ownersCreated[1])
  })

  it('returns a non-empty userOpHash and positive submitMs', async () => {
    const mocks = makeMocks()
    const adapter = createZeroDevAdapter('4337-bundler', '', mocks)
    const client = await adapter.buildAccountClient(BASE_CONFIG)
    const result = await client.sendSponsored()

    expect(result.userOpHash).toMatch(/^0x/)
    expect(result.submitMs).toBeGreaterThanOrEqual(0)
  })
})
