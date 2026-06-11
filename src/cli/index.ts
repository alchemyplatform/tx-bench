#!/usr/bin/env bun
import { Command } from 'commander'
import { loadConfig } from '../benchmark/config.js'
import { buildRows, getRunnableRows } from '../benchmark/rows.js'
import { runPreflight } from '../benchmark/preflight.js'
import { createCanonicalOracle } from '../benchmark/oracle/canonical.js'
import { createFlashblockOracle } from '../benchmark/oracle/flashblocks.js'
import { runBenchmarkGrid, type ProviderEntry } from '../benchmark/service.js'
import { buildOutput, serializeOutput } from '../benchmark/output.js'
import { renderTable } from './render.js'
import { alchemyAdapter } from '../benchmark/providers/alchemy.js'
import { alchemyMAv2Adapter } from '../benchmark/providers/alchemy-mav2.js'
import { alchemyMAv2BSOAdapter } from '../benchmark/providers/alchemy-mav2-bso.js'
import { alchemyWalletSendCallsAdapter } from '../benchmark/providers/alchemy-wallet-sendcalls.js'
import { pimlicoAdapter } from '../benchmark/providers/pimlico.js'
import { zerodevKernelAdapter, zerodevUltraRelayAdapter } from '../benchmark/providers/zerodev.js'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ALL_ADAPTERS = [alchemyAdapter, alchemyMAv2Adapter, alchemyMAv2BSOAdapter, alchemyWalletSendCallsAdapter, pimlicoAdapter, zerodevKernelAdapter, zerodevUltraRelayAdapter]
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url))

type DashboardOptions = {
  port?: string
  host?: string
}

function parsePort(value: string | undefined): number {
  if (!value) return 4173
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return port
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

function resolveAssetPath(pathname: string): string | undefined {
  const assetName = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const assetPath = resolve(WEB_ROOT, assetName)
  const rootPath = resolve(WEB_ROOT)

  if (assetPath !== rootPath && !assetPath.startsWith(rootPath + '/')) {
    return undefined
  }

  return assetPath
}

function readDashboardPayload(file: string | undefined): { json: string; source: Record<string, string | boolean> } {
  if (!file) {
    const samplePath = join(WEB_ROOT, 'sample-results.json')
    const json = readFileSync(samplePath, 'utf8')
    JSON.parse(json)
    return {
      json,
      source: { kind: 'sample', name: 'sample-results.json', sample: true },
    }
  }

  const resultPath = resolve(file)
  if (!existsSync(resultPath)) {
    throw new Error(`Result file not found: ${resultPath}`)
  }

  const json = readFileSync(resultPath, 'utf8')
  JSON.parse(json)
  return {
    json,
    source: { kind: 'file', name: basename(resultPath), path: resultPath, sample: false },
  }
}

function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('EADDRINUSE') || (message.includes('port') && message.includes('use'))
}

async function serveDashboard(file: string | undefined, opts: DashboardOptions): Promise<void> {
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
  console.log(`\nwrite-bench dashboard: ${url}`)
  console.log(`Data source: ${String(source.name)}${source.sample ? ' (sample)' : ''}`)
  console.log('Press Ctrl+C to stop.\n')

  process.on('SIGINT', () => {
    server?.stop()
    process.exit(0)
  })

  await new Promise(() => {})
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command()
  .name('write-bench')
  .description('ERC-4337 write-path benchmark — neutral inclusion oracle, per-stage timing')
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
  .description('Run the benchmark')
  .option('--providers <list>', 'comma-separated provider IDs to run (default: all runnable)')
  .option('-n, --count <number>', 'number of runs per provider (overrides RUN_COUNT env)', String)
  .option('--json [file]', 'emit JSON output; omit file to write to stdout')
  .option('--output <file>', 'write human-readable table to this file')
  .action(async (opts: { providers?: string; count?: string; json?: boolean | string; output?: string }) => {
    const config = loadConfig()
    if (opts.count) config.runCount = parseInt(opts.count, 10)

    const rows = buildRows(process.env)
    let runnable = getRunnableRows(rows)

    if (opts.providers) {
      const requested = opts.providers.split(',').map(s => s.trim())
      runnable = runnable.filter(r => requested.includes(r.id))
      if (runnable.length === 0) {
        console.error(`No matching runnable providers for: ${requested.join(', ')}`)
        process.exit(1)
      }
    }

    // Preflight
    const preflight = await runPreflight(config, runnable)
    if (!preflight.ok) {
      console.error('Preflight failed:')
      for (const err of preflight.errors) console.error(`  ${err}`)
      process.exit(1)
    }
    for (const w of preflight.warnings) console.warn(`⚠️   ${w}`)

    // Build provider entries
    const adapterMap = new Map(ALL_ADAPTERS.map(a => [a.id, a]))
    const providers: ProviderEntry[] = runnable
      .map(row => ({ row, adapter: adapterMap.get(row.id) }))
      .filter((e): e is ProviderEntry => !!e.adapter)

    // Create oracles
    const neutralPublicClient = createPublicClient({ chain: base, transport: http(config.neutral.rpcUrl) })
    const canonicalOracle = createCanonicalOracle(neutralPublicClient)
    const flashblockOracle = config.neutral.flashblockWsUrl && preflight.flashblockAvailable
      ? createFlashblockOracle(config.neutral.flashblockWsUrl)
      : createFlashblockOracle('wss://no-op', { ws: (_url) => ({ readyState: 3, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null }) })

    console.log(`\nRunning ${config.runCount} iteration(s) across ${providers.length} provider(s)...\n`)

    const results = await runBenchmarkGrid(config, providers, canonicalOracle, flashblockOracle,
      e => {
        if (e.kind === 'provider-done') {
          console.log(`  [${e.iteration + 1}/${config.runCount}] ${e.provider}: ${e.status}`)
        }
      }
    )

    canonicalOracle.close()
    flashblockOracle.close()

    const output = buildOutput({ config, results, preconfAvailable: preflight.flashblockAvailable })
    const jsonStr = serializeOutput(output)
    const humanStr = renderTable(output)

    // Emit outputs
    if (opts.json) {
      if (typeof opts.json === 'string') {
        writeFileSync(opts.json, jsonStr)
        console.log(`\nJSON written to: ${opts.json}`)
      } else {
        console.log(jsonStr)
        return
      }
    }

    if (opts.output) {
      writeFileSync(opts.output, humanStr)
      console.log(`Table written to: ${opts.output}`)
    } else {
      console.log('\n' + humanStr)
    }
  })

// ── view ──────────────────────────────────────────────────────────────────────

program
  .command('view [file]')
  .description('Serve a local web dashboard for a benchmark JSON output')
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

program.parse()
