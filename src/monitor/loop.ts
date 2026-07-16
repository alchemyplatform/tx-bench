import { createPublicClient, http } from 'viem'
import { base, mainnet, optimism, arbitrum } from 'viem/chains'
import type { Chain } from 'viem'
import { loadConfig, type Config, type EnvSource } from '../benchmark/config.js'
import { buildRows, getRunnableRows } from '../benchmark/rows.js'
import { createCanonicalOracle } from '../benchmark/oracle/canonical.js'
import { createFlashblockOracle } from '../benchmark/oracle/flashblocks.js'
import { runBenchmarkGrid, type ProviderEntry, type ProviderRunResult } from '../benchmark/service.js'
import { alchemyMAv2BSOAdapter } from '../benchmark/providers/alchemy-mav2-bso.js'
import { alchemyWalletSendCallsAdapter } from '../benchmark/providers/alchemy-wallet-sendcalls.js'
import type { MonitoringCredentials } from './secrets.js'
import type { MonitorMetrics } from './metrics.js'

// Monitoring covers only these two adapters for now — MAv2 BSO (ERC-4337) and
// Wallet SendCalls (EIP-7702) — per operator decision. Others can be added later.
const ALCHEMY_ADAPTERS = [alchemyMAv2BSOAdapter, alchemyWalletSendCallsAdapter]
const NO_OP_WS = (_url: string) => ({ readyState: 3, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null })
const MONITORING_RUN_COUNT_DEFAULT = 20

// Known networks: viem chain + a neutral (non-Alchemy) public RPC default, so a
// single task can monitor a configurable set of networks without per-network
// secret configuration. Unknown networks fall back to mainnet/undefined below.
const KNOWN_NETWORKS: Record<string, { chain: Chain; defaultNeutralRpcUrl: string }> = {
  'eth-mainnet': { chain: mainnet, defaultNeutralRpcUrl: 'https://ethereum-rpc.publicnode.com' },
  'base-mainnet': { chain: base, defaultNeutralRpcUrl: 'https://base-rpc.publicnode.com' },
  'opt-mainnet': { chain: optimism, defaultNeutralRpcUrl: 'https://optimism-rpc.publicnode.com' },
  'arb-mainnet': { chain: arbitrum, defaultNeutralRpcUrl: 'https://arbitrum-one-rpc.publicnode.com' },
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type GridRunner = (config: Config, env: EnvSource) => Promise<ProviderRunResult[]>

export type RunOnceOptions = {
  gridRunner?: GridRunner
  baseEnv?: EnvSource
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveChain(network: string): Chain {
  return KNOWN_NETWORKS[network]?.chain ?? mainnet
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

function resolveNeutralRpcUrl(
  network: string,
  credentials: MonitoringCredentials,
  mergedEnv: EnvSource,
): string | undefined {
  // Explicit per-network or single neutral overrides win (for future
  // mixed-provider monitoring where a truly independent node is required).
  const explicit = credentials.NEUTRAL_RPC_URLS?.[network] ?? mergedEnv.NEUTRAL_RPC_URL
  if (explicit) return explicit
  // Default for Alchemy-only monitoring: use the Alchemy chain-specific URL as
  // the neutral canonical oracle. The preflight allows this when all runnable
  // providers are Alchemy (no contestant disadvantaged), and it is reliable for
  // UserOperationEvent log delivery on chains where free public nodes miss logs.
  if (credentials.ALCHEMY_API_KEY) {
    return `https://${network}.g.alchemy.com/v2/${credentials.ALCHEMY_API_KEY}`
  }
  // Last resort: the built-in public neutral default for known networks.
  return KNOWN_NETWORKS[network]?.defaultNeutralRpcUrl
}

function buildEnv(credentials: MonitoringCredentials, baseEnv: EnvSource): EnvSource {
  return {
    ...baseEnv,
    ALCHEMY_API_KEY: credentials.ALCHEMY_API_KEY,
    ALCHEMY_POLICY_ID: credentials.ALCHEMY_POLICY_ID,
    OWNER_PRIVATE_KEY: credentials.OWNER_PRIVATE_KEY,
    ...(credentials.ALCHEMY_BSO_POLICY_ID && { ALCHEMY_BSO_POLICY_ID: credentials.ALCHEMY_BSO_POLICY_ID }),
    ...(credentials.NEUTRAL_RPC_URL && { NEUTRAL_RPC_URL: credentials.NEUTRAL_RPC_URL }),
    ...(credentials.ALCHEMY_RPC_URL && { ALCHEMY_RPC_URL: credentials.ALCHEMY_RPC_URL }),
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
    const chain = resolveChain(config.network)
    const client = createPublicClient({ chain, transport: http(config.neutral.rpcUrl) })
    const canonicalOracle = createCanonicalOracle(client)
    const flashblockOracle = createFlashblockOracle('wss://no-op', { ws: NO_OP_WS })
    const entries = buildAdapterEntries(env)

    try {
      return await runBenchmarkGrid(config, entries, canonicalOracle, flashblockOracle, (ev) => {
        // Surface per-iteration failures in real time so CloudWatch Logs shows
        // *why* a run is failing as it happens, not just the aggregate later.
        if (ev.kind === 'provider-done' && ev.status === 'failed') {
          console.log(JSON.stringify({
            event: 'iteration_failed',
            network: config.network,
            provider: ev.provider,
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
// by `event`. Error reasons here are already private-key-redacted by the
// service (serializeErrorRedacted), so they are safe to emit.
function logRunResults(results: ProviderRunResult[], network: string, region: string): void {
  for (const { row, records, metrics: pm } of results) {
    const stages: Record<string, { median: number; p95: number; count: number }> = {}
    for (const [stage, sm] of Object.entries(pm.stages)) {
      if (sm) stages[stage] = { median: sm.median, p95: sm.p95, count: sm.count }
    }
    console.log(JSON.stringify({
      event: 'provider_summary',
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
      const failed = Object.entries(rec.stages).filter(([, s]) => s.status === 'failed' || s.status === 'timed-out')
      if (failed.length === 0) continue
      console.log(JSON.stringify({
        event: 'run_failed',
        network,
        region,
        provider: row.id,
        run_index: rec.runIndex,
        account: rec.accountAddress,
        error: rec.error ?? null,
        stages: failed.map(([stage, s]) => ({ stage, status: s.status, reason: s.reason ?? null })),
      }))
    }
  }
}

function pushGauges(results: ProviderRunResult[], metrics: MonitorMetrics, network: string, region: string): void {
  for (const { metrics: pm } of results) {
    const summaryLabels = {
      protocol_class: pm.protocolClass,
      provider_id: pm.provider,
      network,
      region,
    }

    metrics.sampleCount.set(summaryLabels, pm.runCount)
    metrics.failureCount.set(summaryLabels, pm.failureCount)
    metrics.successRate.set(
      summaryLabels,
      pm.runCount > 0 ? (pm.runCount - pm.failureCount) / pm.runCount : 0,
    )

    for (const [stage, stageMetrics] of Object.entries(pm.stages)) {
      if (!stageMetrics) continue  // no successful samples — skip to avoid zero-inflation
      const latencyLabels = { ...summaryLabels, stage }
      metrics.stageLatencyP50.set(latencyLabels, stageMetrics.median)
      metrics.stageLatencyP95.set(latencyLabels, stageMetrics.p95)
      metrics.stageLatencyP99.set(latencyLabels, stageMetrics.p99)
    }

    metrics.lastRunTimestampUnix.set(summaryLabels, Date.now() / 1000)
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
  const neutralRpcUrl = resolveNeutralRpcUrl(network, credentials, mergedEnv)
  const env: EnvSource = {
    ...mergedEnv,
    NETWORK: network,
    ...(neutralRpcUrl && { NEUTRAL_RPC_URL: neutralRpcUrl }),
  }
  const config = loadConfig(env)

  try {
    const results = await runner(config, env)
    // Log the detailed per-provider / per-failed-run breakdown BEFORE pushing
    // gauges so diagnostics are emitted even if gauge publishing throws.
    logRunResults(results, config.network, region)
    pushGauges(results, metrics, config.network, region)
    console.log(JSON.stringify({ event: 'run_complete', network: config.network, region, providerCount: results.length }))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(JSON.stringify({ event: 'run_error', network: config.network, region, error: message }))
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
  options: RunOnceOptions = {},
): void {
  const runner = options.gridRunner ?? createDefaultGridRunner()
  const opts = { ...options, gridRunner: runner }
  void runOnce(credentials, metrics, region, opts)
  setInterval(() => void runOnce(credentials, metrics, region, opts), 60 * 60 * 1000)
}
