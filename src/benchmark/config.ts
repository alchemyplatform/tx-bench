import { z } from 'zod'

export type EnvSource = Record<string, string | undefined>

// ── URL validators ────────────────────────────────────────────────────────────

const httpsUrl = z
  .string()
  .refine(v => v.startsWith('https://'), { message: 'URL must use https://' })
  .refine(v => !/:\/\/[^@/]+:[^@/]+@/.test(v), { message: 'URL must not embed credentials' })

const wssUrl = z
  .string()
  .refine(v => v.startsWith('wss://'), { message: 'URL must use wss://' })
  .refine(v => !/:\/\/[^@/]+:[^@/]+@/.test(v), { message: 'URL must not embed credentials' })

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: 'must be 0x followed by 64 hex characters' })

// ── Raw env schema (all provider fields optional — runnability checked below) ─

const rawEnvSchema = z.object({
  // Alchemy
  ALCHEMY_API_KEY: z.string().optional(),
  ALCHEMY_POLICY_ID: z.string().optional(),
  ALCHEMY_BSO_POLICY_ID: z.string().optional(),
  ALCHEMY_RPC_URL: httpsUrl.optional(),

  // Pimlico
  PIMLICO_API_KEY: z.string().optional(),
  PIMLICO_POLICY_ID: z.string().optional(),
  PIMLICO_RPC_URL: httpsUrl.optional(),

  // ZeroDev
  ZERODEV_API_KEY: z.string().optional(),
  ZERODEV_PROJECT_ID: z.string().optional(),
  ZERODEV_RPC_URL: httpsUrl.optional(),

  // Neutral node
  NEUTRAL_RPC_URL: httpsUrl.optional(),
  NEUTRAL_FLASHBLOCK_WS_URL: wssUrl.optional(),

  // Settings
  NETWORK: z.string().default('base-mainnet'),
  RUN_COUNT: z.coerce.number().int().positive().max(100).default(5),
  OWNER_PRIVATE_KEY: privateKey.optional(),
  TIMEOUT_SUBMIT_MS: z.coerce.number().int().positive().default(30_000),
  TIMEOUT_PRECONF_MS: z.coerce.number().int().positive().default(30_000),
  TIMEOUT_CANONICAL_MS: z.coerce.number().int().positive().default(120_000),
  TIMEOUT_RECEIPT_MS: z.coerce.number().int().positive().default(120_000),
})

// ── Typed config ──────────────────────────────────────────────────────────────

export type AlchemyConfig = { apiKey: string; policyId: string; rpcUrl: string; bsoPolicyId?: string | null }
export type PimlicoConfig = { apiKey: string; policyId: string; rpcUrl: string }
export type ZeroDevConfig = { apiKey: string; projectId: string; rpcUrl: string }

export type NeutralConfig = {
  rpcUrl: string
  flashblockWsUrl: string | null
}

export type Timeouts = {
  submitMs: number
  preconfMs: number
  canonicalMs: number
  receiptMs: number
}

export type Config = {
  network: string
  runCount: number
  ownerPrivateKey?: `0x${string}`
  providers: {
    alchemy: AlchemyConfig | null
    pimlico: PimlicoConfig | null
    zerodev: ZeroDevConfig | null
  }
  neutral: NeutralConfig
  timeouts: Timeouts
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isEnvConfigured(env: EnvSource, keys: readonly string[]): boolean {
  return keys.every(k => !!env[k])
}

// Returns true if fully configured, false if absent, throws if partial.
function checkProvider(env: EnvSource, requiredKeys: string[], label: string): boolean {
  const present = requiredKeys.filter(k => !!env[k])
  if (present.length === 0) return false
  const missing = requiredKeys.filter(k => !env[k])
  if (missing.length === 0) return true
  throw new Error(`Partial ${label} config — set: [${present.join(', ')}], missing: [${missing.join(', ')}]`)
}

// ── loadConfig ────────────────────────────────────────────────────────────────

export function loadConfig(env: EnvSource = process.env): Config {
  // Normalize: treat empty strings as absent so optional detection is consistent
  const normalized: EnvSource = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v])
  )

  const raw = rawEnvSchema.parse(normalized)

  const hasAlchemy = checkProvider(normalized, ['ALCHEMY_API_KEY', 'ALCHEMY_POLICY_ID'], 'Alchemy')
  const hasPimlico = checkProvider(normalized, ['PIMLICO_API_KEY', 'PIMLICO_POLICY_ID'], 'Pimlico')
  const hasZeroDev = checkProvider(normalized, ['ZERODEV_API_KEY', 'ZERODEV_PROJECT_ID'], 'ZeroDev')

  const alchemy: AlchemyConfig | null = hasAlchemy
    ? {
        apiKey: normalized.ALCHEMY_API_KEY!,
        policyId: normalized.ALCHEMY_POLICY_ID!,
        rpcUrl:
          raw.ALCHEMY_RPC_URL ??
          `https://${raw.NETWORK}.g.alchemy.com/v2/${normalized.ALCHEMY_API_KEY!}`,
        bsoPolicyId: normalized.ALCHEMY_BSO_POLICY_ID ?? null,
      }
    : null

  const pimlico: PimlicoConfig | null = hasPimlico
    ? {
        apiKey: normalized.PIMLICO_API_KEY!,
        policyId: normalized.PIMLICO_POLICY_ID!,
        rpcUrl:
          raw.PIMLICO_RPC_URL ??
          `https://api.pimlico.io/v2/8453/rpc?apikey=${normalized.PIMLICO_API_KEY!}`,
      }
    : null

  const zerodev: ZeroDevConfig | null = hasZeroDev
    ? {
        apiKey: normalized.ZERODEV_API_KEY!,
        projectId: normalized.ZERODEV_PROJECT_ID!,
        rpcUrl:
          raw.ZERODEV_RPC_URL ??
          `https://rpc.zerodev.app/api/v3/${normalized.ZERODEV_PROJECT_ID!}/chain/8453`,
      }
    : null

  return {
    network: raw.NETWORK,
    runCount: raw.RUN_COUNT,
    ownerPrivateKey: raw.OWNER_PRIVATE_KEY as `0x${string}` | undefined,
    providers: { alchemy, pimlico, zerodev },
    neutral: {
      rpcUrl: raw.NEUTRAL_RPC_URL ?? 'https://mainnet.base.org',
      flashblockWsUrl: raw.NEUTRAL_FLASHBLOCK_WS_URL ?? null,
    },
    timeouts: {
      submitMs: raw.TIMEOUT_SUBMIT_MS,
      preconfMs: raw.TIMEOUT_PRECONF_MS,
      canonicalMs: raw.TIMEOUT_CANONICAL_MS,
      receiptMs: raw.TIMEOUT_RECEIPT_MS,
    },
  }
}
