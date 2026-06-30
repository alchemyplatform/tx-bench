import { createPublicClient, http } from 'viem'
import { base, mainnet, optimism, arbitrum } from 'viem/chains'
import type { Chain } from 'viem'
import { loadConfig, type Config, type EnvSource } from '../benchmark/config.js'
import { buildRows, getRunnableRows } from '../benchmark/rows.js'
import { createCanonicalOracle } from '../benchmark/oracle/canonical.js'
import { createFlashblockOracle } from '../benchmark/oracle/flashblocks.js'
import { runBenchmarkGrid, type ProviderEntry, type ProviderRunResult } from '../benchmark/service.js'
import { alchemyAdapter } from '../benchmark/providers/alchemy.js'
import { alchemyMAv2Adapter } from '../benchmark/providers/alchemy-mav2.js'
import { alchemyMAv2BSOAdapter } from '../benchmark/providers/alchemy-mav2-bso.js'
import { alchemyWalletSendCallsAdapter } from '../benchmark/providers/alchemy-wallet-sendcalls.js'
import type { MonitoringCredentials } from './secrets.js'
import type { MonitorMetrics } from './metrics.js'

const ALCHEMY_ADAPTERS = [alchemyAdapter, alchemyMAv2Adapter, alchemyMAv2BSOAdapter, alchemyWalletSendCallsAdapter]
const NO_OP_WS = (_url: string) => ({ readyState: 3, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null })
const MONITORING_RUN_COUNT_DEFAULT = 20

// ── Types ─────────────────────────────────────────────────────────────────────

export type GridRunner = (config: Config, env: EnvSource) => Promise<ProviderRunResult[]>

export type RunOnceOptions = {
  gridRunner?: GridRunner
  baseEnv?: EnvSource
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveChain(network: string): Chain {
  const MAP: Record<string, Chain> = {
    'eth-mainnet': mainnet,
    'base-mainnet': base,
    'opt-mainnet': optimism,
    'arb-mainnet': arbitrum,
  }
  return MAP[network] ?? mainnet
}

function buildEnv(credentials: MonitoringCredentials, baseEnv: EnvSource): EnvSource {
  return {
    ...baseEnv,
    ALCHEMY_API_KEY: credentials.ALCHEMY_API_KEY,
    ALCHEMY_POLICY_ID: credentials.ALCHEMY_POLICY_ID,
    OWNER_PRIVATE_KEY: credentials.OWNER_PRIVATE_KEY,
    ...(credentials.NEUTRAL_RPC_URL && { NEUTRAL_RPC_URL: credentials.NEUTRAL_RPC_URL }),
    ...(credentials.ALCHEMY_RPC_URL && { ALCHEMY_RPC_URL: credentials.ALCHEMY_RPC_URL }),
    // Use a monitoring-appropriate default run count unless already set in baseEnv
    RUN_COUNT: baseEnv.RUN_COUNT ?? String(MONITORING_RUN_COUNT_DEFAULT),
  }
}

function buildAdapterEntries(env: EnvSource): ProviderEntry[] {
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
      return await runBenchmarkGrid(config, entries, canonicalOracle, flashblockOracle)
    } finally {
      canonicalOracle.close()
      flashblockOracle.close()
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

export async function runOnce(
  credentials: MonitoringCredentials,
  metrics: MonitorMetrics,
  region: string,
  { gridRunner, baseEnv = process.env as EnvSource }: RunOnceOptions = {},
): Promise<void> {
  const runner = gridRunner ?? createDefaultGridRunner()
  const env = buildEnv(credentials, baseEnv)
  const config = loadConfig(env)

  try {
    const results = await runner(config, env)
    pushGauges(results, metrics, config.network, region)
    console.log(JSON.stringify({ event: 'run_complete', network: config.network, region, providerCount: results.length }))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(JSON.stringify({ event: 'run_error', network: config.network, region, error: message }))
  }
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
