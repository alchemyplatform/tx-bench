import { createPublicClient, http } from 'viem'
import { base, mainnet, optimism, arbitrum } from 'viem/chains'
import type { Chain } from 'viem'
import { loadConfig, type Config, type EnvSource } from '../benchmark/config.js'
import { buildRows, getRunnableRows } from '../benchmark/rows.js'
import { createCanonicalOracle } from '../benchmark/oracle/canonical.js'
import { createFlashblockOracle } from '../benchmark/oracle/flashblocks.js'
import { runBenchmarkGrid, type ProviderEntry, type ProviderRunResult } from '../benchmark/service.js'
import { alchemyWalletSendCallsAdapter } from '../benchmark/providers/alchemy-wallet-sendcalls.js'
import type { MonitoringCredentials } from './secrets.js'
import { MEASUREMENT_EPOCH, TERMINAL_STATUS_NONE, type MonitorMetrics } from './metrics.js'
import { serializeErrorRedacted } from '../benchmark/serialize.js'
import type { ProtocolClass, RunRecord } from '../benchmark/contracts.js'

// Monitoring covers exactly one path: the recommended config — Wallet APIs with
// a BSO policy and defaults (EIP-7702 + MAv2). The MAv2 BSO adapter stays in the
// codebase for CLI and public cross-provider runs, which still need a raw 4337
// path to compare against Pimlico and ZeroDev; it is just not monitored.
const ALCHEMY_ADAPTERS = [alchemyWalletSendCallsAdapter]
const NO_OP_WS = (_url: string) => ({ readyState: 3, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null })
const MONITORING_RUN_COUNT_DEFAULT = 20
const MONITOR_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_JITTER_WINDOW_MS = 60 * 1000
const BASE_MAINNET = 'base-mainnet'

// Keep the four production regions in non-overlapping hourly slots. A complete
// 20-attempt production batch currently takes about 10–12 minutes, so 15-minute
// spacing leaves a few minutes of headroom while fitting every region into one
// hour. The small per-process jitter avoids exact second-level alignment.
const REGION_START_MINUTE: Record<string, number> = {
  'us-east-1': 0,
  'us-west-2': 15,
  'eu-central-1': 30,
  'ap-southeast-1': 45,
}

// Known monitoring networks. Endpoint URLs are always derived from the
// Alchemy API key; this map only selects the viem chain definition.
const KNOWN_NETWORKS: Record<string, Chain> = {
  'eth-mainnet': mainnet,
  'base-mainnet': base,
  'opt-mainnet': optimism,
  'arb-mainnet': arbitrum,
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type GridRunner = (config: Config, env: EnvSource) => Promise<ProviderRunResult[]>

export type RunOnceOptions = {
  gridRunner?: GridRunner
  baseEnv?: EnvSource
}

type LoopTimer = (callback: () => void, delayMs: number) => unknown

export type StartLoopOptions = RunOnceOptions & {
  now?: () => number
  random?: () => number
  setTimeoutFn?: LoopTimer
  setIntervalFn?: LoopTimer
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveChain(network: string): Chain {
  return KNOWN_NETWORKS[network] ?? mainnet
}

export function computeRegionalStartDelayMs(
  region: string,
  nowMs: number,
  jitterMs: number,
): number {
  const slotMinute = REGION_START_MINUTE[region] ?? 0
  const hourStartMs = Math.floor(nowMs / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS
  let targetMs = hourStartMs + slotMinute * 60_000 + jitterMs
  if (targetMs < nowMs) targetMs += MONITOR_INTERVAL_MS
  return targetMs - nowMs
}

// NETWORKS is a comma-separated list (e.g. "base-mainnet,eth-mainnet,opt-mainnet"),
// letting one task monitor several networks per hourly run. Falls back to the
// single NETWORK var (or its default) so existing single-network deployments
// and tests keep working unchanged.
function parseNetworks(env: EnvSource): string[] {
  const raw = env.NETWORKS ?? env.NETWORK ?? 'base-mainnet'
  const networks = raw.split(',').map(s => s.trim()).filter(Boolean)
  return networks.length > 0 ? networks : ['base-mainnet']
}

function resolveAlchemyRpcUrl(
  network: string,
  credentials: MonitoringCredentials,
): string {
  return `https://${network}.g.alchemy.com/v2/${credentials.ALCHEMY_API_KEY}`
}

function resolveAlchemyFlashblockWsUrl(credentials: MonitoringCredentials): string {
  return `wss://${BASE_MAINNET}.g.alchemy.com/v2/${credentials.ALCHEMY_API_KEY}`
}

function buildEnv(credentials: MonitoringCredentials, baseEnv: EnvSource): EnvSource {
  const sanitizedBaseEnv = { ...baseEnv }
  delete sanitizedBaseEnv.NEUTRAL_RPC_URL
  delete sanitizedBaseEnv.NEUTRAL_RPC_URLS
  delete sanitizedBaseEnv.NEUTRAL_FLASHBLOCK_WS_URL
  delete sanitizedBaseEnv.ALCHEMY_RPC_URL
  return {
    ...sanitizedBaseEnv,
    ALCHEMY_API_KEY: credentials.ALCHEMY_API_KEY,
    ALCHEMY_POLICY_ID: credentials.ALCHEMY_POLICY_ID,
    ALCHEMY_BSO_POLICY_ID: credentials.ALCHEMY_BSO_POLICY_ID,
    OWNER_PRIVATE_KEY: credentials.OWNER_PRIVATE_KEY,
    // Use a monitoring-appropriate default run count unless already set in baseEnv
    RUN_COUNT: baseEnv.RUN_COUNT ?? String(MONITORING_RUN_COUNT_DEFAULT),
  }
}

export function buildAdapterEntries(env: EnvSource): ProviderEntry[] {
  const rows = buildRows(env)
  const runnable = getRunnableRows(rows)
  const adapterMap = new Map(ALCHEMY_ADAPTERS.map(a => [a.id, a]))
  return runnable
    .filter(row => adapterMap.has(row.id))
    .map(row => ({ row, adapter: adapterMap.get(row.id)! }))
}

function createDefaultGridRunner(): GridRunner {
  return async (config, env) => {
    const entries = buildAdapterEntries(env)
    if (entries.length === 0) {
      throw new Error(
        'No monitored adapter is runnable — the Wallet path requires ALCHEMY_API_KEY and ALCHEMY_BSO_POLICY_ID',
      )
    }
    const chain = resolveChain(config.network)
    const client = createPublicClient({ chain, transport: http(config.neutral.rpcUrl) })
    const canonicalOracle = createCanonicalOracle(client)
    const hasFlashblocks = config.network === BASE_MAINNET
    if (hasFlashblocks && !config.neutral.flashblockWsUrl) {
      throw new Error('Base monitoring requires a Flashblocks WebSocket endpoint')
    }
    const flashblockOracle = hasFlashblocks
      ? createFlashblockOracle(config.neutral.flashblockWsUrl!)
      : createFlashblockOracle('wss://no-op', { ws: NO_OP_WS })

    const region = env.REGION ?? env.AWS_REGION ?? null

    try {
      return await runBenchmarkGrid(config, entries, canonicalOracle, flashblockOracle, (ev) => {
        // Trace every lifecycle event so CloudWatch Logs shows a run progressing
        // in real time: iteration_start → provider_done (per adapter) →
        // iteration_done, repeated for each of runCount iterations. Without this
        // a long run looks silent for minutes and there's no way to tell it's
        // alive vs hung.
        if (ev.kind === 'iteration-start') {
          console.log(JSON.stringify({
            event: 'iteration_start',
            network: config.network,
            region,
            iteration: ev.iteration,
            total: ev.total,
          }))
        } else if (ev.kind === 'provider-done') {
          console.log(JSON.stringify({
            event: 'provider_done',
            network: config.network,
            region,
            provider: ev.provider,
            iteration: ev.iteration,
            status: ev.status,
            // Include the redacted error reason on failure so the cause is
            // visible the moment it happens, not only in the end-of-run
            // run_failed event. The reason is already private-key-redacted by
            // the service (serializeErrorRedacted).
            ...(ev.status === 'failed' && { error: ev.error }),
          }))
        } else if (ev.kind === 'iteration-done') {
          console.log(JSON.stringify({
            event: 'iteration_done',
            network: config.network,
            region,
            iteration: ev.iteration,
          }))
        }
      })
    } finally {
      canonicalOracle.close()
      flashblockOracle.close()
    }
  }
}

// ── Structured logging ──────────────────────────────────────────────────────
// All monitor logs are single-line JSON so CloudWatch Logs Insights can filter
// by `event`. Error reasons are defensively redacted again at this boundary.
function observerApiForProvider(provider: string, network: string): string {
  if (network === BASE_MAINNET && provider === 'alchemy-wallet-sendcalls') return 'wallet_getCallsStatus'
  if (network === BASE_MAINNET) return 'newFlashblockTransactions'
  if (provider === 'alchemy-mav2-bso') return 'eth_getUserOperationReceipt'
  if (provider === 'alchemy-wallet-sendcalls') return 'wallet_getCallsStatus'
  return 'generic-log-scan'
}

function expectedStages(protocolClass: ProtocolClass): Array<keyof RunRecord['stages']> {
  const common: Array<keyof RunRecord['stages']> = ['submit', 'preconf', 'firstStatus', 'canonical', 'providerReceipt']
  return protocolClass === 'wallet-sendcalls' ? ['prepare', 'send', ...common] : common
}

// terminalStatus describes what ended a *status observation*, so only the two
// stages driven by wallet_getCallsStatus get a real value. Tagging
// submit/prepare/preconf with it would be meaningless and would multiply those
// series by every observed status value.
//
// This is what makes the 110-vs-200 split visible in Grafana. `canonical` now
// only ever ends on 200, so the informative split lives on `firstStatus`: 110
// fires only intermittently and lands ~1s behind actual Flashblock inclusion,
// and once the rundler dedup fix lands firstStatus should drop toward preconf.
function terminalStatusForStage(
  record: RunRecord,
  stage: keyof RunRecord['stages'],
): string {
  if (stage === 'canonical') return record.canonicalObservation?.terminalStatus ?? TERMINAL_STATUS_NONE
  if (stage === 'firstStatus') return record.firstStatusObservation?.terminalStatus ?? TERMINAL_STATUS_NONE
  return TERMINAL_STATUS_NONE
}

function redactLogText(value: string | undefined, credentials: MonitoringCredentials): string | undefined {
  if (value == null) return undefined
  return serializeErrorRedacted(value, credentials.OWNER_PRIVATE_KEY, [credentials.ALCHEMY_API_KEY]).message
}

function logRunResults(
  results: ProviderRunResult[],
  network: string,
  region: string,
  credentials: MonitoringCredentials,
): void {
  for (const { row, records, metrics: pm } of results) {
    const stages: Record<string, { median: number; p95: number; count: number }> = {}
    for (const [stage, sm] of Object.entries(pm.stages)) {
      if (sm) stages[stage] = { median: sm.median, p95: sm.p95, count: sm.count }
    }
    console.log(JSON.stringify({
      event: 'provider_summary',
      measurement_epoch: MEASUREMENT_EPOCH,
      network,
      region,
      provider: row.id,
      protocol_class: pm.protocolClass,
      run_count: pm.runCount,
      failure_count: pm.failureCount,
      success_rate: pm.runCount > 0 ? (pm.runCount - pm.failureCount) / pm.runCount : 0,
      stages,
    }))

    for (const rec of records) {
      const observerApi = rec.canonicalObservation?.api ?? observerApiForProvider(row.id, network)
      const attemptStages = Object.fromEntries(expectedStages(rec.protocolClass).map((stage) => {
        const value = rec.stages[stage] ?? { status: 'not-observed' as const }
        return [stage, {
          outcome: value.status,
          ...(value.ms != null ? { duration_ms: value.ms } : {}),
          ...(value.reason ? { reason: redactLogText(value.reason, credentials) } : {}),
        }]
      }))
      console.log(JSON.stringify({
        event: 'benchmark_attempt',
        measurement_epoch: MEASUREMENT_EPOCH,
        network,
        region,
        provider: row.id,
        protocol_class: rec.protocolClass,
        run_index: rec.runIndex,
        accepted_at_ms: rec.acceptedAtMs ?? null,
        observer_api: observerApi,
        poll_count: rec.canonicalObservation?.pollCount ?? 0,
        terminal_status: rec.canonicalObservation?.terminalStatus ?? null,
        error_class: rec.canonicalObservation?.errorClass ?? null,
        stages: attemptStages,
      }))

      const failed = Object.entries(rec.stages).filter(([, s]) =>
        s.status === 'failed' || s.status === 'timed-out' || s.status === 'observer-error')
      if (failed.length === 0) continue
      console.log(JSON.stringify({
        event: 'run_failed',
        measurement_epoch: MEASUREMENT_EPOCH,
        network,
        region,
        provider: row.id,
        run_index: rec.runIndex,
        account: rec.accountAddress,
        error: redactLogText(rec.error, credentials) ?? null,
        stages: failed.map(([stage, s]) => ({
          stage,
          status: s.status,
          reason: redactLogText(s.reason, credentials) ?? null,
        })),
      }))
    }
  }
}

function emitRunMetrics(results: ProviderRunResult[], metrics: MonitorMetrics, network: string, region: string): void {
  for (const { records, metrics: pm } of results) {
    const recordsByObserver = new Map<string, RunRecord[]>()
    for (const record of records) {
      const observerApi = record.canonicalObservation?.api
        ?? observerApiForProvider(pm.provider, network)
      const observerRecords = recordsByObserver.get(observerApi) ?? []
      observerRecords.push(record)
      recordsByObserver.set(observerApi, observerRecords)
    }

    for (const [observerApi, observerRecords] of recordsByObserver) {
      const summaryLabels = {
        protocol_class: pm.protocolClass,
        provider_id: pm.provider,
        observer_api: observerApi,
        measurement_epoch: MEASUREMENT_EPOCH,
        network,
        region,
      }

      // Counters are cumulative across runs; Prometheus `rate()` / `increase()`
      // derive windowed attempt counts and success rates from them.
      metrics.attemptsTotal.inc(summaryLabels, observerRecords.length)
      metrics.failuresTotal.inc(
        summaryLabels,
        observerRecords.filter(record => record.stages.submit.status !== 'ok').length,
      )

      for (const rec of observerRecords) {
        for (const stage of expectedStages(rec.protocolClass)) {
          const value = rec.stages[stage] ?? { status: 'not-observed' as const }
          const terminal_status = terminalStatusForStage(rec, stage)
          metrics.stageOutcomesTotal.inc({ ...summaryLabels, stage, outcome: value.status, terminal_status })
          if (value.status === 'ok' && value.ms != null) {
            metrics.stageLatency.observe({ ...summaryLabels, stage, terminal_status }, value.ms / 1000)
          }
        }
      }

      metrics.lastRunTimestampUnix.set(summaryLabels, Date.now() / 1000)
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function runOnceForNetwork(
  network: string,
  credentials: MonitoringCredentials,
  metrics: MonitorMetrics,
  region: string,
  mergedEnv: EnvSource,
  runner: GridRunner,
): Promise<void> {
  const alchemyRpcUrl = resolveAlchemyRpcUrl(network, credentials)
  const env: EnvSource = {
    ...mergedEnv,
    NETWORK: network,
    NEUTRAL_RPC_URL: alchemyRpcUrl,
    ALCHEMY_RPC_URL: alchemyRpcUrl,
    ...(network === BASE_MAINNET && {
      NEUTRAL_FLASHBLOCK_WS_URL: resolveAlchemyFlashblockWsUrl(credentials),
    }),
  }
  const config = loadConfig(env)

  const adapterIds = buildAdapterEntries(env).map(e => e.row.id)
  console.log(JSON.stringify({
    event: 'run_start',
    measurement_epoch: MEASUREMENT_EPOCH,
    network: config.network,
    region,
    run_count: config.runCount,
    providers: adapterIds,
  }))

  try {
    const results = await runner(config, env)
    // Log the detailed per-provider / per-failed-run breakdown BEFORE emitting
    // metrics so diagnostics are emitted even if metric publishing throws.
    logRunResults(results, config.network, region, credentials)
    emitRunMetrics(results, metrics, config.network, region)
    console.log(JSON.stringify({ event: 'run_complete', measurement_epoch: MEASUREMENT_EPOCH, network: config.network, region, providerCount: results.length }))
  } catch (e) {
    const message = redactLogText(e instanceof Error ? e.message : String(e), credentials)
    console.error(JSON.stringify({ event: 'run_error', measurement_epoch: MEASUREMENT_EPOCH, network: config.network, region, error: message }))
  }
}

export async function runOnce(
  credentials: MonitoringCredentials,
  metrics: MonitorMetrics,
  region: string,
  { gridRunner, baseEnv = process.env as EnvSource }: RunOnceOptions = {},
): Promise<void> {
  const runner = gridRunner ?? createDefaultGridRunner()
  const mergedEnv = buildEnv(credentials, baseEnv)
  const networks = parseNetworks(mergedEnv)

  // Each network runs independently — one network's failure or slow RPC does
  // not block the others, matching how providers within a network already run
  // concurrently via Promise.allSettled in runBenchmarkGrid.
  await Promise.all(
    networks.map(network => runOnceForNetwork(network, credentials, metrics, region, mergedEnv, runner))
  )
}

export function startLoop(
  credentials: MonitoringCredentials,
  metrics: MonitorMetrics,
  region: string,
  options: StartLoopOptions = {},
): void {
  const runner = options.gridRunner ?? createDefaultGridRunner()
  const opts: RunOnceOptions = { gridRunner: runner, baseEnv: options.baseEnv }
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const jitterMs = Math.floor(random() * STARTUP_JITTER_WINDOW_MS)
  const nowMs = now()
  const startupDelayMs = computeRegionalStartDelayMs(region, nowMs, jitterMs)
  let runActive = false

  const runScheduled = async (): Promise<void> => {
    if (runActive) {
      console.log(JSON.stringify({
        event: 'run_skipped',
        measurement_epoch: MEASUREMENT_EPOCH,
        region,
        reason: 'previous_run_active',
      }))
      return
    }

    runActive = true
    try {
      await runOnce(credentials, metrics, region, opts)
    } finally {
      runActive = false
    }
  }

  console.log(JSON.stringify({
    event: 'run_scheduled',
    measurement_epoch: MEASUREMENT_EPOCH,
    region,
    slot_minute: REGION_START_MINUTE[region] ?? 0,
    jitter_ms: jitterMs,
    startup_delay_ms: startupDelayMs,
    first_run_at: new Date(nowMs + startupDelayMs).toISOString(),
  }))

  setTimeoutFn(() => {
    void runScheduled()
    setIntervalFn(() => void runScheduled(), MONITOR_INTERVAL_MS)
  }, startupDelayMs)
}
