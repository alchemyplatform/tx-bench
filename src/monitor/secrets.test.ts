import { describe, expect, it } from 'bun:test'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { mock } from 'bun:test'
import { loadMonitoringCredentials } from './secrets'

function makeClient(secretString: string): SecretsManagerClient {
  const client = new SecretsManagerClient({ region: 'us-east-1' })
  client.send = mock(async (_cmd: unknown) => ({ SecretString: secretString })) as any
  return client
}

function makeErrorClient(error: Error): SecretsManagerClient {
  const client = new SecretsManagerClient({ region: 'us-east-1' })
  client.send = mock(async (_cmd: unknown) => { throw error }) as any
  return client
}

const VALID_SECRET = JSON.stringify({
  ALCHEMY_API_KEY: 'test-api-key',
  ALCHEMY_POLICY_ID: 'test-policy-id',
  OWNER_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
  NEUTRAL_RPC_URL: 'https://base-mainnet.example.com',
})

describe('loadMonitoringCredentials', () => {
  it('returns a correctly typed credential object for a valid secret', async () => {
    const client = makeClient(VALID_SECRET)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.ALCHEMY_API_KEY).toBe('test-api-key')
    expect(creds.ALCHEMY_POLICY_ID).toBe('test-policy-id')
    expect(creds.OWNER_PRIVATE_KEY).toBe(('0x' + 'ab'.repeat(32)) as `0x${string}`)
    expect(creds.NEUTRAL_RPC_URL).toBe('https://base-mainnet.example.com')
  })

  it('OWNER_PRIVATE_KEY matches 0x${string} format', async () => {
    const client = makeClient(VALID_SECRET)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.OWNER_PRIVATE_KEY).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it('omits optional fields when absent from the secret', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + 'cc'.repeat(32),
    })
    const client = makeClient(secret)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.NEUTRAL_RPC_URL).toBeUndefined()
    expect(creds.ALCHEMY_RPC_URL).toBeUndefined()
    expect(creds.ALCHEMY_BSO_POLICY_ID).toBeUndefined()
  })

  it('includes ALCHEMY_BSO_POLICY_ID when present in the secret', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + 'ee'.repeat(32),
      ALCHEMY_BSO_POLICY_ID: 'bso-policy-id',
    })
    const client = makeClient(secret)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.ALCHEMY_BSO_POLICY_ID).toBe('bso-policy-id')
  })

  it('includes NEUTRAL_RPC_URLS map when present in the secret', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + 'ff'.repeat(32),
      NEUTRAL_RPC_URLS: {
        'eth-mainnet': 'https://eth.example.com',
        'base-mainnet': 'https://base.example.com',
      },
    })
    const client = makeClient(secret)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.NEUTRAL_RPC_URLS).toEqual({
      'eth-mainnet': 'https://eth.example.com',
      'base-mainnet': 'https://base.example.com',
    })
  })

  it('omits NEUTRAL_RPC_URLS when absent from the secret', async () => {
    const client = makeClient(VALID_SECRET)
    const creds = await loadMonitoringCredentials('us-east-1', client)
    expect(creds.NEUTRAL_RPC_URLS).toBeUndefined()
  })

  it('throws when NEUTRAL_RPC_URLS is not an object', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + '11'.repeat(32),
      NEUTRAL_RPC_URLS: 'not-an-object',
    })
    const client = makeClient(secret)
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'NEUTRAL_RPC_URLS must be a JSON object',
    )
  })

  it('throws when a NEUTRAL_RPC_URLS value is not a string', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + '22'.repeat(32),
      NEUTRAL_RPC_URLS: { 'eth-mainnet': 12345 },
    })
    const client = makeClient(secret)
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'NEUTRAL_RPC_URLS["eth-mainnet"] must be a string',
    )
  })

  it('throws a descriptive error when ALCHEMY_API_KEY is missing', async () => {
    const secret = JSON.stringify({
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: '0x' + 'dd'.repeat(32),
    })
    const client = makeClient(secret)
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'missing required key "ALCHEMY_API_KEY"',
    )
  })

  it('throws a descriptive error when OWNER_PRIVATE_KEY is missing', async () => {
    const secret = JSON.stringify({ ALCHEMY_API_KEY: 'k', ALCHEMY_POLICY_ID: 'p' })
    const client = makeClient(secret)
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'missing required key "OWNER_PRIVATE_KEY"',
    )
  })

  it('throws when OWNER_PRIVATE_KEY does not match the hex format', async () => {
    const secret = JSON.stringify({
      ALCHEMY_API_KEY: 'k',
      ALCHEMY_POLICY_ID: 'p',
      OWNER_PRIVATE_KEY: 'not-a-hex-key',
    })
    const client = makeClient(secret)
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'OWNER_PRIVATE_KEY must be 0x followed by 64 hex characters',
    )
  })

  it('throws when the ASM call itself fails', async () => {
    const client = makeErrorClient(new Error('AccessDeniedException'))
    await expect(loadMonitoringCredentials('us-east-1', client)).rejects.toThrow(
      'AccessDeniedException',
    )
  })
})
