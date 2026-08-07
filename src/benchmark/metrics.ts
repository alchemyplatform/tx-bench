import type { RunRecord, Stage, StageStatus } from './contracts.js'
import type { SponsoredResult } from './providers/types.js'
import type { CanonicalResult } from './oracle/canonical.js'
import type { FlashblockResult } from './oracle/flashblocks.js'

// ── Gas helpers ───────────────────────────────────────────────────────────────

export function calculateTotalFee(
  gasUsed: bigint | undefined,
  gasPrice: bigint | undefined,
  l1Fee: bigint | undefined
): bigint | undefined {
  if (gasUsed == null || gasPrice == null) return undefined
  return gasUsed * gasPrice + (l1Fee ?? 0n)
}

// Normalize a potentially numeric-string or hex value to bigint
export function numericToBigInt(value: string | number | bigint | undefined): bigint | undefined {
  if (value == null) return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

// ── Stage builder ─────────────────────────────────────────────────────────────

export function makeStage(status: StageStatus, ms?: number, reason?: string): Stage {
  return { status, ...(ms != null ? { ms } : {}), ...(reason ? { reason } : {}) }
}

function stageFromCanonical(result: CanonicalResult, acceptedMs: number): Stage {
  switch (result.status) {
    case 'ok':
      return makeStage('ok', result.tMs - acceptedMs)
    case 'timed-out':
      return makeStage('timed-out')
    case 'integrity-fail':
      return makeStage('failed', undefined, result.reason)
    case 'observer-error':
      return makeStage('observer-error', undefined, result.reason)
  }
}

function stageFromFlashblock(result: FlashblockResult, acceptedMs: number): Stage {
  switch (result.status) {
    case 'ok':
      return makeStage('ok', result.tMs - acceptedMs)
    case 'not-observed':
      return makeStage('not-observed')
    case 'not-attributable':
      return makeStage('not-observed', undefined, 'inclusion not neutrally attributable')
  }
}

// ── Run record assembly ───────────────────────────────────────────────────────

export type GasInput = {
  // From neutral canonical receipt (neutral-sourced)
  gasUsed?: bigint
  effectiveGasPrice?: bigint
  l1Fee?: bigint
  // From provider userOp receipt (labeled provider-sourced)
  providerActualGasUsed?: bigint
  providerActualGasCost?: bigint
}

export type RunInput =
  | {
      kind: 'success'
      provider: string       // row id e.g. 'alchemy-light-account'
      accountTypeLabel: string
      sponsored: SponsoredResult
      acceptedAtMs: number   // performance.now() when userOpHash was received
      ttm: CanonicalResult
      preconf: FlashblockResult
      // Absent for modalities without an early-inclusion observer.
      firstStatus?: CanonicalResult
      providerReceiptMs?: number  // wall-clock from acceptance to provider receipt arrival
      gas?: GasInput
      runIndex: number
    }
  | {
      kind: 'submit-failed'
      provider: string
      protocolClass: import('./contracts.js').ProtocolClass
      accountTypeLabel: string
      runIndex: number
      error: string
    }

export function buildRunRecord(input: RunInput): RunRecord {
  if (input.kind === 'submit-failed') {
    return {
      provider: input.provider,
      runIndex: input.runIndex,
      protocolClass: input.protocolClass,
      accountTypeLabel: input.accountTypeLabel,
      accountAddress: '0x0000000000000000000000000000000000000000',
      userOpHash: '0x',
      stages: {
        submit: makeStage('failed', undefined, input.error),
        preconf: makeStage('not-observed'),
        ttm: makeStage('not-observed'),
        providerReceipt: makeStage('not-observed'),
      },
      blockPositions: {},
      error: input.error,
    }
  }

  const { provider, accountTypeLabel, sponsored, acceptedAtMs, ttm, preconf, firstStatus, providerReceiptMs, gas, runIndex } = input
  const submitMs = sponsored.submitMs

  const preconfStage = stageFromFlashblock(preconf, acceptedAtMs)
  const ttmStage = stageFromCanonical(ttm, acceptedAtMs)
  const firstStatusStage = firstStatus ? stageFromCanonical(firstStatus, acceptedAtMs) : undefined

  const providerReceiptStage: Stage =
    providerReceiptMs != null
      ? makeStage('ok', providerReceiptMs)
      : makeStage('not-observed')

  const blockPositions: RunRecord['blockPositions'] = {}

  if (preconf.status === 'ok') {
    blockPositions.preconf = {
      blockNumber: preconf.blockNumber,
      flashblockIndex: preconf.flashblockIndex,
    }
  }

  if (ttm.status === 'ok' && ttm.blockNumber != null) {
    blockPositions.ttm = {
      blockNumber: ttm.blockNumber,
      ...(ttm.txHash ? { txHash: ttm.txHash } : {}),
    }
  }

  const totalFee = gas
    ? calculateTotalFee(gas.gasUsed, gas.effectiveGasPrice, gas.l1Fee)
    : undefined

  return {
    provider,
    runIndex,
    protocolClass: sponsored.protocolClass,
    accountTypeLabel,
    accountAddress: sponsored.accountAddress,
    userOpHash: sponsored.userOpHash,
    acceptedAtMs,
    stages: {
      submit: makeStage('ok', submitMs),
      preconf: preconfStage,
      ttm: ttmStage,
      providerReceipt: providerReceiptStage,
      ...(firstStatusStage ? { firstStatus: firstStatusStage } : {}),
      ...(sponsored.prepareMs != null ? { prepare: makeStage('ok', sponsored.prepareMs) } : {}),
      ...(sponsored.sendMs != null ? { send: makeStage('ok', sponsored.sendMs) } : {}),
    },
    blockPositions,
    ...(ttm.observation ? { ttmObservation: ttm.observation } : {}),
    ...(firstStatus?.observation ? { firstStatusObservation: firstStatus.observation } : {}),
    ...(gas
      ? {
          gas: {
            gasUsed: gas.gasUsed,
            effectiveGasPrice: gas.effectiveGasPrice,
            l1Fee: gas.l1Fee,
            totalFee,
            providerActualGasUsed: gas.providerActualGasUsed,
            providerActualGasCost: gas.providerActualGasCost,
          },
        }
      : {}),
  }
}
