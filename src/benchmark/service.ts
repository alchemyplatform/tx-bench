import { buildRunRecord } from './metrics.js'
import { aggregateRuns } from './aggregate.js'
import { serializeErrorRedacted } from './serialize.js'
import type { Config } from './config.js'
import type { ProtocolClass, ProviderMetrics, ProviderRow, RunRecord } from './contracts.js'
import type { ProviderAdapter, StatusStages } from './providers/types.js'
import type { CanonicalOracle, CanonicalResult } from './oracle/canonical.js'
import type { FlashblockOracle, FlashblockResult } from './oracle/flashblocks.js'

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
  | { kind: 'provider-done'; provider: string; iteration: number; status: 'ok' }
  | { kind: 'provider-done'; provider: string; iteration: number; status: 'failed'; error: string }
  | { kind: 'iteration-done'; iteration: number }

// ── Service ───────────────────────────────────────────────────────────────────

export async function runBenchmarkGrid(
  config: Config,
  providers: readonly ProviderEntry[],
  canonicalOracle: CanonicalOracle,
  flashblockOracle: FlashblockOracle,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ProviderRunResult[]> {
  const alchemyCfg = config.providers.alchemy
  const serializeBenchmarkError = (error: unknown): string => serializeErrorRedacted(
    error,
    config.ownerPrivateKey,
    alchemyCfg ? [alchemyCfg.apiKey] : [],
    alchemyCfg ? [alchemyCfg.policyId, alchemyCfg.bsoPolicyId ?? ''] : [],
  ).message

  // Build account clients for all providers upfront (validates config once)
  const clientMap = new Map<string, ReturnType<ProviderAdapter['buildAccountClient']> extends Promise<infer T> ? T : never>()
  const buildErrors = new Map<string, string>()

  await Promise.allSettled(
    providers.map(async ({ row, adapter }) => {
      try {
        const client = await adapter.buildAccountClient(config)
        clientMap.set(row.id, client as never)
      } catch (e) {
        buildErrors.set(row.id, serializeBenchmarkError(e))
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
      if (!client || buildErrors.has(row.id) || typeof client.ensureDeployed !== 'function') return
      try {
        await withTimeout((signal) => client.ensureDeployed!(signal), BOOTSTRAP_PHASE_TIMEOUT_MS, `bootstrap timeout for ${row.id}`)
      } catch (e) {
        buildErrors.set(row.id, serializeBenchmarkError(e))
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
          onProgress?.({ kind: 'provider-done', provider: row.id, iteration: i, status: 'failed', error: buildErr })
          return
        }

        const client = clientMap.get(row.id)!
        try {
          // The generic oracle needs a pre-submit block bound. Adapter-owned
          // observers operate directly on the accepted identifier and skip it.
          const fromBlock = client.canonicalObserver
            ? undefined
            : await canonicalOracle.getBlockNumber()

          const sponsored = await client.sendSponsored()
          const acceptedAtMs = sponsored.acceptedAtMs ?? performance.now()

          // Neither canonical nor preconfirmation observation is allowed to
          // rewrite an already-accepted submission as submit-failed.
          let canonical: CanonicalResult
          let firstStatus: CanonicalResult | undefined
          let preconf: FlashblockResult

          const statusObserver = client.statusStagesObserver
          const observerApi = statusObserver?.api ?? client.canonicalObserver?.api ?? 'generic-log-scan'
          const identifier = sponsored.canonicalIdentifier ?? sponsored.userOpHash
          const observerError = (error: unknown): CanonicalResult => ({
            status: 'observer-error',
            reason: serializeBenchmarkError(error),
            observation: {
              api: observerApi,
              pollCount: 0,
              errorClass: error instanceof Error ? error.name : typeof error,
            },
          })

          // Status stages come from ONE poll stream, not two. firstStatus and
          // canonical describe the same response whenever the provider emits no
          // early terminal signal, so polling twice would make them disagree
          // about it by up to one poll interval.
          // Modalities without a staged status API report canonical only.
          type ObservedStages = { firstStatus?: CanonicalResult; canonical: CanonicalResult }
          const observeStatusStages = (): Promise<ObservedStages> => {
            if (statusObserver) {
              return statusObserver.watch(identifier, config.timeouts.canonicalMs)
                .catch((error): StatusStages => {
                  const failed = observerError(error)
                  return { firstStatus: failed, canonical: failed }
                })
            }
            return (
              client.canonicalObserver
                ? client.canonicalObserver.watch(identifier, config.timeouts.canonicalMs)
                : canonicalOracle.watch(sponsored.userOpHash, fromBlock!, config.timeouts.canonicalMs)
            )
              .catch(observerError)
              .then((result): ObservedStages => ({ canonical: result }))
          }

          // preconf is measured concurrently and independently — it is the
          // neutral Flashblocks oracle, not a status poll.
          const [stages, observedPreconf] = await Promise.all([
            observeStatusStages(),
            flashblockOracle.watch(sponsored.userOpHash, config.timeouts.preconfMs)
              .catch(() => ({ status: 'not-observed' as const })),
          ])
          canonical = stages.canonical
          firstStatus = stages.firstStatus
          preconf = observedPreconf

          records.push(buildRunRecord({
            kind: 'success',
            provider: row.id,
            accountTypeLabel: row.accountTypeLabel,
            sponsored,
            acceptedAtMs,
            canonical,
            preconf,
            ...(firstStatus ? { firstStatus } : {}),
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
            error: serializeBenchmarkError(e),
          }))
          onProgress?.({ kind: 'provider-done', provider: row.id, iteration: i, status: 'failed', error: serializeBenchmarkError(e) })
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

export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(message))
    }, ms)
  })
  return Promise.race([fn(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
