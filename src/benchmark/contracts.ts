// Shared domain types used across all benchmark modules.

export type StageStatus = 'ok' | 'failed' | 'timed-out' | 'observer-error' | 'not-observed'

export type Stage = {
  status: StageStatus
  ms?: number     // wall-clock ms from acceptance for 'ok' stages
  reason?: string // for non-ok stages
}

export type BlockPosition = {
  blockNumber: bigint
  txHash?: `0x${string}`       // present for canonical; may be absent for flashblock preconf
  flashblockIndex?: number     // position within the block's flashblock sequence (preconf only)
}

export type ProtocolClass = '4337-bundler' | 'intent-relay' | 'wallet-sendcalls'

export type ProviderRow = {
  readonly id: string
  readonly label: string
  readonly protocolClass: ProtocolClass
  readonly accountTypeLabel: string
  readonly requiredEnv: readonly string[]
  readonly runnable: boolean
  readonly missingEnv: readonly string[]
}

export type RunRecord = {
  provider: string
  runIndex: number
  protocolClass: ProtocolClass
  accountTypeLabel: string
  accountAddress: `0x${string}`
  userOpHash: `0x${string}`
  // Captured when the provider accepts the submitted identifier. Absent only
  // when submission itself fails.
  acceptedAtMs?: number
  stages: {
    submit: Stage
    preconf: Stage
    canonical: Stage
    providerReceipt: Stage
    prepare?: Stage  // Optional decomposition of submit (Wallet SendCalls only)
    send?: Stage     // Optional decomposition of submit (Wallet SendCalls only)
  }
  blockPositions: {
    preconf?: BlockPosition
    canonical?: BlockPosition
  }
  canonicalObservation?: {
    api: import('./oracle/canonical.js').CanonicalObserverApi
    pollCount: number
    terminalStatus?: string
    errorClass?: string
  }
  gas?: {
    // From neutral node canonical receipt (neutral-sourced)
    gasUsed?: bigint
    effectiveGasPrice?: bigint
    l1Fee?: bigint
    totalFee?: bigint
    // From provider userOp receipt (provider-sourced — not timing)
    providerActualGasUsed?: bigint
    providerActualGasCost?: bigint
  }
  deploymentGas?: bigint
  error?: string
}

export type StageMetrics = {
  median: number
  p95: number
  p99: number
  count: number
}

export type ProviderMetrics = {
  provider: string
  protocolClass: ProtocolClass
  accountTypeLabel: string
  runCount: number
  failureCount: number
  stages: {
    submit?: StageMetrics
    preconf?: StageMetrics
    canonical?: StageMetrics
    providerReceipt?: StageMetrics
    prepare?: StageMetrics  // Optional decomposition of submit (Wallet SendCalls only)
    send?: StageMetrics     // Optional decomposition of submit (Wallet SendCalls only)
  }
}
