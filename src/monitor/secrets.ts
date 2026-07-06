import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

const SECRET_NAME = 'benchmarking-txe-write-bench-keys'
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

export type MonitoringCredentials = {
  ALCHEMY_API_KEY: string
  ALCHEMY_POLICY_ID: string
  OWNER_PRIVATE_KEY: `0x${string}`
  ALCHEMY_BSO_POLICY_ID?: string
  NEUTRAL_RPC_URL?: string
  ALCHEMY_RPC_URL?: string
}

export async function loadMonitoringCredentials(
  region: string,
  client: SecretsManagerClient = new SecretsManagerClient({ region }),
): Promise<MonitoringCredentials> {
  const response = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))
  const raw: unknown = JSON.parse(response.SecretString ?? '{}')

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Secret ${SECRET_NAME}: expected a JSON object`)
  }

  const obj = raw as Record<string, unknown>

  for (const key of ['ALCHEMY_API_KEY', 'ALCHEMY_POLICY_ID', 'OWNER_PRIVATE_KEY'] as const) {
    if (typeof obj[key] !== 'string' || !obj[key]) {
      throw new Error(`Secret ${SECRET_NAME}: missing required key "${key}"`)
    }
  }

  const ownerPrivateKey = obj['OWNER_PRIVATE_KEY'] as string
  if (!PRIVATE_KEY_RE.test(ownerPrivateKey)) {
    throw new Error(
      `Secret ${SECRET_NAME}: OWNER_PRIVATE_KEY must be 0x followed by 64 hex characters`,
    )
  }

  return {
    ALCHEMY_API_KEY: obj['ALCHEMY_API_KEY'] as string,
    ALCHEMY_POLICY_ID: obj['ALCHEMY_POLICY_ID'] as string,
    OWNER_PRIVATE_KEY: ownerPrivateKey as `0x${string}`,
    ...(typeof obj['ALCHEMY_BSO_POLICY_ID'] === 'string' && { ALCHEMY_BSO_POLICY_ID: obj['ALCHEMY_BSO_POLICY_ID'] }),
    ...(typeof obj['NEUTRAL_RPC_URL'] === 'string' && { NEUTRAL_RPC_URL: obj['NEUTRAL_RPC_URL'] }),
    ...(typeof obj['ALCHEMY_RPC_URL'] === 'string' && { ALCHEMY_RPC_URL: obj['ALCHEMY_RPC_URL'] }),
  }
}
