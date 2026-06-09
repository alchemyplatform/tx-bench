import { isEnvConfigured, type EnvSource } from './config.js'
import type { ProtocolClass, ProviderRow } from './contracts.js'

type RowDefinition = {
  readonly id: string
  readonly label: string
  readonly protocolClass: ProtocolClass
  readonly accountTypeLabel: string
  readonly requiredEnv: readonly string[]
}

const ROW_DEFINITIONS: readonly RowDefinition[] = [
  {
    id: 'alchemy-light-account',
    label: 'Alchemy (Light Account)',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Light Account v2',
    requiredEnv: ['ALCHEMY_API_KEY', 'ALCHEMY_POLICY_ID'],
  },
  {
    id: 'pimlico-safe',
    label: 'Pimlico (Safe)',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Safe',
    requiredEnv: ['PIMLICO_API_KEY', 'PIMLICO_POLICY_ID'],
  },
  {
    id: 'zerodev-kernel',
    label: 'ZeroDev (Kernel)',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Kernel v3',
    requiredEnv: ['ZERODEV_API_KEY', 'ZERODEV_PROJECT_ID'],
  },
  {
    id: 'zerodev-ultrarelay',
    label: 'ZeroDev (UltraRelay)',
    protocolClass: 'intent-relay',
    accountTypeLabel: 'Kernel v3',
    requiredEnv: ['ZERODEV_API_KEY', 'ZERODEV_PROJECT_ID'],
  },
] as const

export function buildRows(env: EnvSource): ProviderRow[] {
  return ROW_DEFINITIONS.map(def => {
    const runnable = isEnvConfigured(env, def.requiredEnv)
    const missingEnv = runnable ? [] : def.requiredEnv.filter(k => !env[k])
    return { ...def, runnable, missingEnv }
  })
}

export function getRunnableRows(rows: ProviderRow[]): ProviderRow[] {
  return rows.filter(r => r.runnable)
}

export function assertRowsExist(ids: string[], rows: ProviderRow[]): void {
  const knownIds = new Set(rows.map(r => r.id))
  const unknown = ids.filter(id => !knownIds.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider row(s): [${unknown.join(', ')}]. Available: [${[...knownIds].join(', ')}]`
    )
  }
}
