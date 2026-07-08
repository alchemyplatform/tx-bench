import { buildRunRecord } from './metrics.js'
import { aggregateRuns } from './aggregate.js'
import { serializeErrorRedacted } from './serialize.js'
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
        buildErrors.set(row.id, serializeErrorRedacted(e, config.ownerPrivateKey).message)
      }
    })
  )

  // Bootstrap phase: call ensureDeployed() on each client that exposes it.
  // This is excluded from all metrics (runs before the timed loop). A bootstrap
  // failure is treated the same as a build failure — all timed iterations for
  // that provider are recorded as failures, other providers are unaffected.
  //
  // An overall per-provider timeout guards against a hanging ensureDeployed()
  // (e.g. a slow setup op + polling) blocking the entire benchmark before any
  // timed iterations run. A timeout is recorded as a build error.
  const BOOTSTRAP_PHASE_TIMEOUT_MS = 60_000
  await Promise.allSettled(
    providers.map(async ({ row }) => {
      const client = clientMap.get(row.id)
      if (!client || typeof client.ensureDeployed !== 'function') return
      try {
        await withTimeout(client.ensureDeployed(), BOOTSTRAP_PHASE_TIMEOUT_MS, `bootstrap timeout for ${row.id}`)
      } catch (e) {
        buildErrors.set(row.id, serializeErrorRedacted(e, config.ownerPrivateKey).message)
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
          const acceptedAtMs = sponsored.acceptedAtMs ?? performance.now()

          // For wallet-sendcalls providers, canonical is resolved inline during sendSponsored().
          // For all others, watch the neutral oracle concurrently with the flashblock oracle.
          const [canonical, preconf] = await Promise.all([
            sponsored.inlineCanonical
              ? Promise.resolve(sponsored.inlineCanonical)
              : canonicalOracle.watch(sponsored.userOpHash, fromBlock, config.timeouts.canonicalMs),
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
            error: serializeErrorRedacted(e, config.ownerPrivateKey).message,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
