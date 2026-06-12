#!/usr/bin/env bun
import { Command } from 'commander'
import { loadConfig } from '../benchmark/config.js'
import { assertRowsExist, buildRows, getRunnableRows } from '../benchmark/rows.js'
import { runPreflight } from '../benchmark/preflight.js'
import { createCanonicalOracle } from '../benchmark/oracle/canonical.js'
import { createFlashblockOracle } from '../benchmark/oracle/flashblocks.js'
import { runBenchmarkGrid, type ProviderEntry, type ProviderRunResult } from '../benchmark/service.js'
import { buildOutput, serializeOutput } from '../benchmark/output.js'
import { renderTable } from './render.js'
import { writeRunArtifact, findLatestRunJson, resolveRunDirectoryJson, sourceNameForRunJson } from './run-artifacts.js'
import { openBrowser } from './open-browser.js'
import { alchemyAdapter } from '../benchmark/providers/alchemy.js'
import { alchemyMAv2Adapter } from '../benchmark/providers/alchemy-mav2.js'
import { alchemyMAv2BSOAdapter } from '../benchmark/providers/alchemy-mav2-bso.js'
import { alchemyWalletSendCallsAdapter } from '../benchmark/providers/alchemy-wallet-sendcalls.js'
import { pimlicoAdapter } from '../benchmark/providers/pimlico.js'
import { zerodevKernelAdapter, zerodevUltraRelayAdapter } from '../benchmark/providers/zerodev.js'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const ALL_ADAPTERS = [alchemyAdapter, alchemyMAv2Adapter, alchemyMAv2BSOAdapter, alchemyWalletSendCallsAdapter, pimlicoAdapter, zerodevKernelAdapter, zerodevUltraRelayAdapter]
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url))

type DashboardOptions = {
  port?: string
  host?: string
}

type DashboardSource = Record<string, string | boolean>

type RunOptions = {
  providers?: string
  count?: string
  json?: boolean | string
  output?: string
}

export function parsePort(value: string | undefined): number {
  if (!value) return 4173
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return port
}

export function parseRunCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid run count: ${value}`)
  const count = Number.parseInt(value, 10)
  if (!Number.isInteger(count) || count <= 0 || count > 100) {
    throw new Error(`Invalid run count: ${value}. Must be an integer between 1 and 100.`)
  }
  return count
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function resolveAssetPath(pathname: string): string | undefined {
  const assetName = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const assetPath = resolve(WEB_ROOT, assetName)
  const rootPath = resolve(WEB_ROOT)
  const rel = relative(rootPath, assetPath)

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined
  }

  return assetPath
}

function validateDashboardJson(json: string, label: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error(`Invalid JSON in ${label}: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error(`Invalid tx-bench output in ${label}: expected top-level results array`)
  }
}

export function readDashboardPayload(file: string | undefined): { json: string; source: DashboardSource } {
  if (!file) {
    const samplePath = join(WEB_ROOT, 'sample-results.json')
    const json = readFileSync(samplePath, 'utf8')
    validateDashboardJson(json, 'sample-results.json')
    return {
      json,
      source: { kind: 'sample', name: 'sample-results.json', sample: true },
    }
  }

  let resultPath: string
  let source: DashboardSource

  if (file === 'latest') {
    resultPath = findLatestRunJson()
    source = { kind: 'run', name: sourceNameForRunJson(resultPath), sample: false }
  } else {
    const resolved = resolve(file)
    if (!existsSync(resolved)) throw new Error(`Result file not found: ${resolved}`)

    if (statSync(resolved).isDirectory()) {
      resultPath = resolveRunDirectoryJson(resolved)
      source = { kind: 'run', name: basename(resolved), sample: false }
    } else {
      resultPath = resolved
      source = { kind: 'file', name: basename(resultPath), sample: false }
    }
  }

  const json = readFileSync(resultPath, 'utf8')
  validateDashboardJson(json, resultPath)
  return { json, source }
}

function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('EADDRINUSE') || (message.includes('port') && message.includes('use'))
}

async function serveDashboard(file: string | undefined, opts: DashboardOptions, serverOpts: { open?: boolean } = {}): Promise<void> {
  const { json, source } = readDashboardPayload(file)
  const preferredPort = parsePort(opts.port)
  const host = opts.host ?? '127.0.0.1'
  let server: ReturnType<typeof Bun.serve> | undefined
  let lastPortError: unknown

  const start = (port: number) => Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/results.json') {
        return new Response(json, {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }

      if (url.pathname === '/source.json') {
        return jsonResponse(source)
      }

      const assetPath = resolveAssetPath(url.pathname)
      if (!assetPath || !existsSync(assetPath)) {
        return new Response('Not found', { status: 404 })
      }

      return new Response(Bun.file(assetPath), {
        headers: { 'content-type': contentTypeFor(assetPath) },
      })
    },
  })

  for (let offset = 0; offset < 50; offset++) {
    const port = preferredPort + offset
    try {
      server = start(port)
      break
    } catch (e) {
      if (!isPortConflict(e)) throw e
      lastPortError = e
    }
  }

  if (!server) {
    try {
      server = start(0)
    } catch (e) {
      throw lastPortError ?? e
    }
  }

  if (!server) throw new Error('Unable to start dashboard server')

  const url = `http://${host}:${server.port}`
  console.log(`\ntx-bench dashboard: ${url}`)
  console.log(`Data source: ${String(source.name)}${source.sample ? ' (sample)' : ''}`)

  if (serverOpts.open) {
    const opened = await openBrowser(url)
    if (!opened.ok) {
      console.warn(`⚠️   Could not open browser automatically: ${opened.error}`)
      console.warn(`     Open this URL manually: ${url}`)
    }
  }

  console.log('Press Ctrl+C to stop.\n')

  process.on('SIGINT', () => {
    server?.stop()
    process.exit(0)
  })

  await new Promise(() => {})
}

export function selectRunnableRows(rows: ReturnType<typeof buildRows>, providers?: string): ReturnType<typeof buildRows> {
  const runnable = getRunnableRows(rows)

  if (!providers) {
    if (runnable.length === 0) throw new Error('No providers are runnable. Check your .env file.')
    return runnable
  }

  const requested = providers.split(',').map(s => s.trim()).filter(Boolean)
  if (requested.length === 0) throw new Error('No provider IDs supplied.')

  assertRowsExist(requested, rows)
  const requestedSet = new Set(requested)
  const selected = rows.filter(row => requestedSet.has(row.id))
  const notRunnable = selected.filter(row => !row.runnable)

  if (notRunnable.length > 0) {
    throw new Error(notRunnable.map(row => `${row.id} is not runnable — missing: ${row.missingEnv.join(', ')}`).join('\n'))
  }

  if (selected.length === 0) throw new Error(`No matching runnable providers for: ${requested.join(', ')}`)
  return selected
}

function providerEntriesFor(rows: ReturnType<typeof buildRows>): ProviderEntry[] {
  const adapterMap = new Map(ALL_ADAPTERS.map(a => [a.id, a]))
  return rows.map(row => {
    const adapter = adapterMap.get(row.id)
    if (!adapter) throw new Error(`No adapter registered for provider row: ${row.id}`)
    return { row, adapter }
  })
}

function allProvidersFailed(results: ProviderRunResult[]): boolean {
  return results.length > 0 && results.every(result => result.metrics.runCount > 0 && result.metrics.failureCount >= result.metrics.runCount)
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command()
  .name('tx-bench')
  .description('Provider-neutral transaction write-path benchmarks — submission, preconfirmation, and inclusion timing')
  .version('0.1.0')

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check provider runnability and run preflight without timing')
  .action(async () => {
    const config = loadConfig()
    const rows = buildRows(process.env)
    const runnable = getRunnableRows(rows)
    const notRunnable = rows.filter(r => !r.runnable)

    console.log('\nProvider status:')
    for (const row of runnable) {
      console.log(`  ✅  ${row.id} (${row.protocolClass})`)
    }
    for (const row of notRunnable) {
      console.log(`  ⛔  ${row.id} — missing: ${row.missingEnv.join(', ')}`)
    }

    if (runnable.length === 0) {
      console.log('\nNo providers are runnable. Check your .env file.')
      process.exit(1)
    }

    console.log('\nRunning preflight...')
    const preflight = await runPreflight(config, runnable)

    if (!preflight.ok) {
      console.error('\n❌  Preflight failed:')
      for (const err of preflight.errors) console.error(`     ${err}`)
      process.exit(1)
    }

    for (const warn of preflight.warnings) {
      console.warn(`  ⚠️   ${warn}`)
    }

    console.log(`\n✅  Preflight passed. Flashblock: ${preflight.flashblockAvailable ? 'available' : 'unavailable (canonical-only)'}`)
  })

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Run the benchmark, save a run folder, and open the local browser report')
  .option('--providers <list>', 'comma-separated provider IDs to run (default: all runnable)')
  .option('-n, --count <number>', 'number of runs per provider (overrides RUN_COUNT env)', String)
  .option('--json [file]', 'emit JSON output; omit file for JSON-only stdout without opening the report')
  .option('--output <file>', 'write human-readable table to this file without opening the report')
  .action(async (opts: RunOptions) => {
    try {
      const jsonStdout = opts.json === true
      const explicitJsonFile = typeof opts.json === 'string'
      const explicitExport = explicitJsonFile || !!opts.output
      const log = jsonStdout ? console.error : console.log

      const config = loadConfig()
      if (opts.count) config.runCount = parseRunCount(opts.count)

      const rows = buildRows(process.env)
      const runnable = selectRunnableRows(rows, opts.providers)

      const preflight = await runPreflight(config, runnable)
      if (!preflight.ok) {
        console.error('Preflight failed:')
        for (const err of preflight.errors) console.error(`  ${err}`)
        process.exit(1)
      }
      for (const w of preflight.warnings) console.warn(`⚠️   ${w}`)

      const providers = providerEntriesFor(runnable)

      const neutralPublicClient = createPublicClient({ chain: base, transport: http(config.neutral.rpcUrl) })
      const canonicalOracle = createCanonicalOracle(neutralPublicClient)
      const flashblockOracle = config.neutral.flashblockWsUrl && preflight.flashblockAvailable
        ? createFlashblockOracle(config.neutral.flashblockWsUrl)
        : createFlashblockOracle('wss://no-op', { ws: (_url) => ({ readyState: 3, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null }) })

      log(`\nRunning ${config.runCount} iteration(s) across ${providers.length} provider(s)...\n`)

      let results: ProviderRunResult[]
      try {
        results = await runBenchmarkGrid(config, providers, canonicalOracle, flashblockOracle,
          e => {
            if (e.kind === 'provider-done') {
              log(`  [${e.iteration + 1}/${config.runCount}] ${e.provider}: ${e.status}`)
            }
          }
        )
      } finally {
        canonicalOracle.close()
        flashblockOracle.close()
      }

      const output = buildOutput({ config, results, preconfAvailable: preflight.flashblockAvailable })
      const jsonStr = serializeOutput(output)
      const humanStr = renderTable(output)

      if (jsonStdout) {
        console.log(jsonStr)
        return
      }

      if (explicitJsonFile) {
        writeFileSync(opts.json as string, jsonStr)
        console.log(`\nJSON written to: ${opts.json}`)
      }

      if (opts.output) {
        writeFileSync(opts.output, humanStr)
        console.log(`Table written to: ${opts.output}`)
      }

      if (explicitExport) return

      if (allProvidersFailed(results)) {
        console.warn('⚠️   All provider attempts failed. Saving the run so failures are inspectable.')
      }

      console.log('\n' + humanStr)
      const artifact = writeRunArtifact({ output, json: jsonStr, table: humanStr })
      console.log(`\nRun saved to: ${artifact.runDir}`)
      console.log(`Canonical JSON: ${artifact.runJsonPath}`)
      console.log('Opening report...')
      await serveDashboard(artifact.runDir, {}, { open: true })
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  })

// ── view ──────────────────────────────────────────────────────────────────────

program
  .command('view [file]')
  .description('Serve a local web dashboard for sample data, latest, a run folder, or a benchmark JSON output')
  .option('-p, --port <number>', 'preferred local port (default: 4173)')
  .option('--host <host>', 'host to bind (default: 127.0.0.1)')
  .action(async (file: string | undefined, opts: DashboardOptions) => {
    try {
      await serveDashboard(file, opts)
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  })

if (import.meta.main) program.parse()
