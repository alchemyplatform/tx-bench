import { buildRunRecord } from './metrics.js'
import { aggregateRuns } from './aggregate.js'
import { serializeError } from './serialize.js'
import type { Config } from './config.js'
import type { ProtocolClass, ProviderMetrics, ProviderRow, RunRecord } from './contracts.js'
import type { ProviderAdapter } from './providers/types.js'
import type { CanonicalOracle } from './oracle/canonical.js'
import type { FlashblockOracle } from './oracle/flashblocks.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderEntry = {
  row: ProviderRow
  adapter: ProviderAdapter
}

export type ProviderRunResult = {
  row: ProviderRow
  records: RunRecord[]
  metrics: ProviderMetrics
}

export type ProgressEvent =
  | { kind: 'iteration-start'; iteration: number; total: number }
  | { kind: 'provider-done'; provider: string; iteration: number; status: 'ok' | 'failed' }
  | { kind: 'iteration-done'; iteration: number }

// ── Service ───────────────────────────────────────────────────────────────────

export async function runBenchmarkGrid(
  config: Config,
  providers: readonly ProviderEntry[],
  canonicalOracle: CanonicalOracle,
  flashblockOracle: FlashblockOracle,
  onProgress?: (event: ProgressEvent) => void
): Promise<ProviderRunResult[]> {

  // Build account clients for all providers upfront (validates config once)
  const clientMap = new Map<string, ReturnType<ProviderAdapter['buildAccountClient']> extends Promise<infer T> ? T : never>()
  const buildErrors = new Map<string, string>()

  await Promise.allSettled(
    providers.map(async ({ row, adapter }) => {
      try {
        const client = await adapter.buildAccountClient(config)
        clientMap.set(row.id, client as never)
      } catch (e) {
        buildErrors.set(row.id, serializeError(e).message)
      }
    })
  )

  // Accumulate records per provider across N iterations
  const recordMap = new Map<string, RunRecord[]>(
    providers.map(({ row }) => [row.id, []])
  )

  for (let i = 0; i < config.runCount; i++) {
    onProgress?.({ kind: 'iteration-start', iteration: i, total: config.runCount })

    // All providers run concurrently per iteration
    await Promise.allSettled(
      providers.map(async ({ row }) => {
        const records = recordMap.get(row.id)!

        const buildErr = buildErrors.get(row.id)
        if (buildErr) {
          records.push(buildRunRecord({
            kind: 'submit-failed',
            provider: row.id,
            protocolClass: row.protocolClass as ProtocolClass,
            accountTypeLabel: row.accountTypeLabel,
            runIndex: i,
            error: buildErr,
          }))
          onProgress?.({ kind: 'provider-done', provider: row.id, iteration: i, status: 'failed' })
          return
        }

        const client = clientMap.get(row.id)!
        try {
          // Capture block before submission so oracle search is bounded
          const fromBlock = await canonicalOracle.getBlockNumber()

          const sponsored = await client.sendSponsored()
          const acceptedAtMs = performance.now()

          // Both oracle watches run concurrently
          const [canonical, preconf] = await Promise.all([
            canonicalOracle.watch(sponsored.userOpHash, fromBlock, config.timeouts.canonicalMs),
            flashblockOracle.watch(sponsored.userOpHash, config.timeouts.preconfMs),
          ])

          records.push(buildRunRecord({
            kind: 'success',
            provider: row.id,
            accountTypeLabel: row.accountTypeLabel,
            sponsored,
            acceptedAtMs,
            canonical,
            preconf,
            runIndex: i,
          }))
          onProgress?.({ kind: 'provider-done', provider: row.id, iteration: i, status: 'ok' })
        } catch (e) {
          records.push(buildRunRecord({
            kind: 'submit-failed',
            provider: row.id,
            protocolClass: row.protocolClass as ProtocolClass,
            accountTypeLabel: row.accountTypeLabel,
            runIndex: i,
            error: serializeError(e).message,
          }))
          onProgress?.({ kind: 'provider-done', provider: row.id, iteration: i, status: 'failed' })
        }
      })
    )

    onProgress?.({ kind: 'iteration-done', iteration: i })
  }

  return providers.map(({ row }) => {
    const records = recordMap.get(row.id)!
    return {
      row,
      records,
      metrics: aggregateRuns(row.id, row.protocolClass as ProtocolClass, row.accountTypeLabel, records),
    }
  })
}
