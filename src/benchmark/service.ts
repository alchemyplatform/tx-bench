import { buildRunRecord } from './metrics.js'
import { aggregateRuns } from './aggregate.js'
import { serializeErrorRedacted } from './serialize.js'
import type { Config } from './config.js'
import type { ProtocolClass, ProviderMetrics, ProviderRow, RunRecord } from './contracts.js'
import type { ProviderAdapter } from './providers/types.js'
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

export type RunBenchmarkOptions = {
  canonicalSource?: 'default' | 'preconfirmation'
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function runBenchmarkGrid(
  config: Config,
  providers: readonly ProviderEntry[],
  canonicalOracle: CanonicalOracle,
  flashblockOracle: FlashblockOracle,
  onProgress?: (event: ProgressEvent) => void,
  options: RunBenchmarkOptions = {},
): Promise<ProviderRunResult[]> {
  const usePreconfirmationCanonical = options.canonicalSource === 'preconfirmation'

  const serializeBenchmarkError = (error: unknown): string => serializeErrorRedacted(
    error,
    config.ownerPrivateKey,
    config.providers.alchemy ? [config.providers.alchemy.apiKey] : [],
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

  // Only modalities without a provider-native preconfirmation signal depend
  // on the shared Flashblock subscription. Pre-warm it before any timed write,
  // but keep confirmed inclusion available as the fallback if readiness fails.
  const needsRawFlashblocks = usePreconfirmationCanonical && providers.some(({ row }) => {
    const client = clientMap.get(row.id)
    return client != null && client.preconfirmationObserver == null
  })
  const rawFlashblocksReady = needsRawFlashblocks
    ? await flashblockOracle.ready(config.timeouts.preconfMs).then(
        () => true,
        () => false,
      )
    : false

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
          let preconf: FlashblockResult

          const observerApi = client.canonicalObserver?.api ?? 'generic-log-scan'
          const observeConfirmedCanonical = (): Promise<CanonicalResult> => (
            client.canonicalObserver
              ? client.canonicalObserver.watch(
                  sponsored.canonicalIdentifier ?? sponsored.userOpHash,
                  config.timeouts.canonicalMs,
                )
              : canonicalOracle.watch(sponsored.userOpHash, fromBlock!, config.timeouts.canonicalMs)
          ).catch((error): CanonicalResult => ({
            status: 'observer-error',
            reason: serializeBenchmarkError(error),
            observation: {
              api: observerApi,
              pollCount: 0,
              errorClass: error instanceof Error ? error.name : typeof error,
            },
          }))

          if (usePreconfirmationCanonical && client.preconfirmationObserver) {
            const preconfirmationObserverApi = client.preconfirmationObserver.api
            const [observedCanonical, observedPreconf] = await Promise.all([
              client.preconfirmationObserver.watch(
                sponsored.canonicalIdentifier ?? sponsored.userOpHash,
                config.timeouts.preconfMs,
              ).catch((error): CanonicalResult => ({
                status: 'observer-error',
                reason: serializeBenchmarkError(error),
                observation: {
                  api: preconfirmationObserverApi,
                  pollCount: 0,
                  errorClass: error instanceof Error ? error.name : typeof error,
                },
              })),
              flashblockOracle.watch(sponsored.userOpHash, config.timeouts.preconfMs)
                .catch(() => ({ status: 'not-observed' as const })),
            ])
            canonical = observedCanonical
            preconf = observedPreconf
          } else if (usePreconfirmationCanonical) {
            const [confirmedCanonical, observedPreconf] = await Promise.all([
              observeConfirmedCanonical(),
              rawFlashblocksReady
                ? flashblockOracle.watch(sponsored.userOpHash, config.timeouts.preconfMs)
                    .catch(() => ({ status: 'not-observed' as const }))
                : Promise.resolve({ status: 'not-observed' as const }),
            ])
            preconf = observedPreconf
            canonical = preconf.status === 'ok'
              ? canonicalFromFlashblock(preconf)
              : confirmedCanonical
          } else {
            const [observedCanonical, observedPreconf] = await Promise.all([
              observeConfirmedCanonical(),
              flashblockOracle.watch(sponsored.userOpHash, config.timeouts.preconfMs)
                .catch(() => ({ status: 'not-observed' as const })),
            ])
            canonical = observedCanonical
            preconf = observedPreconf
          }

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

function canonicalFromFlashblock(
  result: Extract<FlashblockResult, { status: 'ok' }>,
): CanonicalResult {
  return {
    status: 'ok',
    blockNumber: result.blockNumber,
    tMs: result.tMs,
    observation: {
      api: 'newFlashblockTransactions',
      pollCount: 0,
    },
  }
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
