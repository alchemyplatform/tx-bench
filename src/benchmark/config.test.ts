import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { loadConfig, isEnvConfigured } from './config'

const FULL_ENV = {
  ALCHEMY_API_KEY: 'alchemy-key',
  ALCHEMY_POLICY_ID: 'alchemy-policy',
  PIMLICO_API_KEY: 'pimlico-key',
  PIMLICO_POLICY_ID: 'pimlico-policy',
  ZERODEV_API_KEY: 'zerodev-key',
  ZERODEV_PROJECT_ID: 'zerodev-project',
  NEUTRAL_RPC_URL: 'https://mainnet.base.org',
  NEUTRAL_FLASHBLOCK_WS_URL: 'wss://flashblocks.example.com',
}

describe('loadConfig', () => {
  it('parses a valid full config into typed config object', () => {
    const cfg = loadConfig(FULL_ENV)

    expect(cfg.providers.alchemy).toEqual({
      apiKey: 'alchemy-key',
      policyId: 'alchemy-policy',
      rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/alchemy-key',
      bsoPolicyId: null,
    })
    expect(cfg.providers.pimlico).toEqual({
      apiKey: 'pimlico-key',
      policyId: 'pimlico-policy',
      rpcUrl: 'https://api.pimlico.io/v2/8453/rpc?apikey=pimlico-key',
    })
    expect(cfg.providers.zerodev).toEqual({
      apiKey: 'zerodev-key',
      projectId: 'zerodev-project',
      rpcUrl: 'https://rpc.zerodev.app/api/v3/zerodev-project/chain/8453',
    })
    expect(cfg.neutral.rpcUrl).toBe('https://mainnet.base.org')
    expect(cfg.neutral.flashblockWsUrl).toBe('wss://flashblocks.example.com')
    expect(cfg.runCount).toBe(5)
    expect(cfg.network).toBe('base-mainnet')
  })

  it('returns null for providers whose env is completely absent', () => {
    const cfg = loadConfig({ ALCHEMY_API_KEY: 'key', ALCHEMY_POLICY_ID: 'policy' })
    expect(cfg.providers.alchemy).not.toBeNull()
    expect(cfg.providers.pimlico).toBeNull()
    expect(cfg.providers.zerodev).toBeNull()
  })

  it('uses provider RPC override when ALCHEMY_RPC_URL is set', () => {
    const cfg = loadConfig({
      ...FULL_ENV,
      ALCHEMY_RPC_URL: 'https://custom.alchemy.example.com',
    })
    expect(cfg.providers.alchemy?.rpcUrl).toBe('https://custom.alchemy.example.com')
  })

  it('derives the default Alchemy RPC URL from NETWORK, not a hardcoded network', () => {
    const cfg = loadConfig({ ...FULL_ENV, NETWORK: 'eth-mainnet' })
    expect(cfg.providers.alchemy?.rpcUrl).toBe('https://eth-mainnet.g.alchemy.com/v2/alchemy-key')
  })

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({})
    expect(cfg.runCount).toBe(5)
    expect(cfg.network).toBe('base-mainnet')
    expect(cfg.timeouts.submitMs).toBe(30_000)
    expect(cfg.timeouts.canonicalMs).toBe(120_000)
    expect(cfg.neutral.rpcUrl).toBe('https://mainnet.base.org')
    expect(cfg.neutral.flashblockWsUrl).toBeNull()
  })

  it('parses RUN_COUNT and timeouts from env strings', () => {
    const cfg = loadConfig({ RUN_COUNT: '10', TIMEOUT_SUBMIT_MS: '5000' })
    expect(cfg.runCount).toBe(10)
    expect(cfg.timeouts.submitMs).toBe(5000)
  })

  it('throws on partial Alchemy config naming the missing field', () => {
    expect(() => loadConfig({ ALCHEMY_API_KEY: 'key' })).toThrow('ALCHEMY_POLICY_ID')
    expect(() => loadConfig({ ALCHEMY_POLICY_ID: 'policy' })).toThrow('ALCHEMY_API_KEY')
  })

  it('throws on partial Pimlico config naming the missing field', () => {
    expect(() => loadConfig({ PIMLICO_API_KEY: 'key' })).toThrow('PIMLICO_POLICY_ID')
  })

  it('throws on partial ZeroDev config naming the missing field', () => {
    expect(() => loadConfig({ ZERODEV_API_KEY: 'key' })).toThrow('ZERODEV_PROJECT_ID')
  })

  it('throws on malformed private key', () => {
    expect(() => loadConfig({ OWNER_PRIVATE_KEY: 'not-a-key' })).toThrow('64 hex')
    expect(() => loadConfig({ OWNER_PRIVATE_KEY: '0x' + 'g'.repeat(64) })).toThrow()
  })

  it('accepts a valid 32-byte hex private key', () => {
    const key = `0x${'a'.repeat(64)}` as `0x${string}`
    const cfg = loadConfig({ OWNER_PRIVATE_KEY: key })
    expect(cfg.ownerPrivateKey).toBe(key)
  })

  it('throws on a non-https NEUTRAL_RPC_URL', () => {
    expect(() => loadConfig({ NEUTRAL_RPC_URL: 'http://mainnet.base.org' })).toThrow('https')
  })

  it('throws on a non-wss NEUTRAL_FLASHBLOCK_WS_URL', () => {
    expect(() =>
      loadConfig({ NEUTRAL_FLASHBLOCK_WS_URL: 'ws://flashblocks.example.com' })
    ).toThrow('wss')
  })

  it('throws on a URL with embedded credentials', () => {
    expect(() =>
      loadConfig({ NEUTRAL_RPC_URL: 'https://user:password@mainnet.base.org' })
    ).toThrow('credentials')
  })

  it('treats empty-string env values as absent', () => {
    const cfg = loadConfig({ ALCHEMY_API_KEY: '', ALCHEMY_POLICY_ID: '' })
    expect(cfg.providers.alchemy).toBeNull()
  })
})

describe('isEnvConfigured', () => {
  it('returns true when all keys are present', () => {
    expect(isEnvConfigured({ A: '1', B: '2' }, ['A', 'B'])).toBe(true)
  })

  it('returns false when any key is missing', () => {
    expect(isEnvConfigured({ A: '1' }, ['A', 'B'])).toBe(false)
  })

  it('returns false for empty-string values', () => {
    expect(isEnvConfigured({ A: '' }, ['A'])).toBe(false)
  })
})

describe('.env.example guard', () => {
  it('contains only YOUR_* placeholder values (no real credentials)', async () => {
    const path = join(import.meta.dir, '../../.env.example')
    const text = await Bun.file(path).text()

    const entries = text
      .split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => {
        const eq = line.indexOf('=')
        return eq !== -1 ? { key: line.slice(0, eq), value: line.slice(eq + 1).trim() } : null
      })
      .filter(Boolean) as { key: string; value: string }[]

    for (const { key, value } of entries) {
      if (!value) continue
      expect(
        /^YOUR_[A-Z_]+$/.test(value),
        `${key} in .env.example must be a YOUR_* placeholder, got: ${value}`
      ).toBe(true)
    }
  })
})
