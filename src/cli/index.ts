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
import { pimlicoAdapter } from '../benchmark/providers/pimlico.js'
import { zerodevKernelAdapter, zerodevUltraRelayAdapter } from '../benchmark/providers/zerodev.js'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { writeFileSync } from 'fs'

const ALL_ADAPTERS = [alchemyAdapter, pimlicoAdapter, zerodevKernelAdapter, zerodevUltraRelayAdapter]

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

program.parse()
