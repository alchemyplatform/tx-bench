/**
 * Plan step 3 — live validation of the single Wallet+BSO path on base-mainnet.
 *
 * Drives the real monitored code path (runOnce → createDefaultGridRunner →
 * runBenchmarkGrid), not a mock, so what it exercises is what AWS runs. Reads
 * credentials from the environment only — never from arguments.
 *
 * Checks:
 *   1. three distinct stage timings per attempt
 *   2. preconf < firstStatus <= canonical
 *   3. canonical terminates on 200 only
 *   4. firstStatus and canonical both emit a terminal_status metric label
 *
 * Usage:
 *   set -a; source .env.aws-repro.local; set +a
 *   RUN_COUNT=5 bun run scripts/validate-single-path-run.ts
 */
import { Registry } from 'prom-client'
import { buildMetrics } from '../src/monitor/metrics.js'
import { runOnce } from '../src/monitor/loop.js'
import type { MonitoringCredentials } from '../src/monitor/secrets.js'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} in the environment`)
  return v
}

const credentials: MonitoringCredentials = {
  ALCHEMY_API_KEY: required('ALCHEMY_API_KEY'),
  ALCHEMY_POLICY_ID: required('ALCHEMY_POLICY_ID'),
  ALCHEMY_BSO_POLICY_ID: required('ALCHEMY_BSO_POLICY_ID'),
  OWNER_PRIVATE_KEY: required('OWNER_PRIVATE_KEY') as `0x${string}`,
}

const registry = new Registry()
const metrics = buildMetrics(registry)

type StageLog = { outcome: string; duration_ms?: number; reason?: string }
type AttemptLog = {
  event: string
  provider: string
  run_index: number
  terminal_status: string | null
  stages: Record<string, StageLog>
}

const attempts: AttemptLog[] = []
const origLog = console.log
console.log = (...args: unknown[]) => {
  const line = args.join(' ')
  origLog(line)
  try {
    const parsed = JSON.parse(line)
    if (parsed?.event === 'benchmark_attempt') attempts.push(parsed)
  } catch { /* not a JSON log line */ }
}

const started = Date.now()
await runOnce(credentials, metrics, process.env.AWS_REGION ?? 'us-east-1', {
  baseEnv: { ...process.env, NETWORKS: 'base-mainnet' } as Record<string, string>,
})
console.log = origLog

const elapsedS = ((Date.now() - started) / 1000).toFixed(1)

// ── Per-attempt table ────────────────────────────────────────────────────────
const ms = (s?: StageLog) => (s?.duration_ms != null ? Math.round(s.duration_ms) : null)
const cell = (v: number | null, s?: StageLog) => (v != null ? String(v).padStart(7) : (s?.outcome ?? '—').padStart(7))

console.log(`\n${'='.repeat(78)}`)
console.log(`ATTEMPTS (${attempts.length}) — wall clock ${elapsedS}s`)
console.log('='.repeat(78))
console.log(['  #', 'preconf', ' first', ' canon', 'term', 'submit'].join(' | '))

const rows: Array<{ i: number; preconf: number | null; first: number | null; canon: number | null; term: string }> = []
for (const a of attempts) {
  const preconf = ms(a.stages.preconf)
  const first = ms(a.stages.firstStatus)
  const canon = ms(a.stages.canonical)
  rows.push({ i: a.run_index, preconf, first, canon, term: a.terminal_status ?? 'none' })
  console.log([
    String(a.run_index).padStart(3),
    cell(preconf, a.stages.preconf),
    cell(first, a.stages.firstStatus),
    cell(canon, a.stages.canonical),
    (a.terminal_status ?? 'none').padStart(4),
    cell(ms(a.stages.submit), a.stages.submit),
  ].join(' | '))
  for (const [name, st] of Object.entries(a.stages)) {
    if (st.reason) console.log(`      ${name}: ${st.outcome} — ${st.reason}`)
  }
}

// ── Assertions ───────────────────────────────────────────────────────────────
const problems: string[] = []
const complete = rows.filter(r => r.preconf != null && r.first != null && r.canon != null)

if (attempts.length === 0) problems.push('no attempts were recorded')
if (complete.length === 0) problems.push('no attempt produced all three stage timings')

for (const r of complete) {
  if (!(r.preconf! < r.first!)) problems.push(`attempt ${r.i}: preconf ${r.preconf} !< firstStatus ${r.first}`)
  if (!(r.first! <= r.canon!)) problems.push(`attempt ${r.i}: firstStatus ${r.first} !<= canonical ${r.canon}`)
}

const badTerminal = rows.filter(r => r.canon != null && r.term !== '200')
for (const r of badTerminal) problems.push(`attempt ${r.i}: canonical terminated on ${r.term}, expected 200`)

// ── Metric shape ─────────────────────────────────────────────────────────────
const counts = (await metrics.stageLatency.get()).values
  .filter(v => v.metricName === 'txe_bench_stage_latency_seconds_count')

console.log(`\n${'='.repeat(78)}`)
console.log('METRIC SERIES (stage / terminal_status / count)')
console.log('='.repeat(78))
for (const v of counts.sort((a, b) => String(a.labels.stage).localeCompare(String(b.labels.stage)))) {
  console.log(`  ${String(v.labels.stage).padEnd(14)} ${String(v.labels.terminal_status).padEnd(6)} ${v.value}`)
  console.log(`     epoch=${v.labels.measurement_epoch} provider=${v.labels.provider_id}`)
}

const stagesSeen = new Set(counts.map(v => String(v.labels.stage)))
for (const s of ['preconf', 'firstStatus', 'canonical']) {
  if (!stagesSeen.has(s)) problems.push(`no latency series emitted for stage "${s}"`)
}
if (stagesSeen.has('providerReceipt')) problems.push('providerReceipt series emitted for the wallet path')

const firstStatusTerminals = counts
  .filter(v => v.labels.stage === 'firstStatus')
  .map(v => String(v.labels.terminal_status))
if (firstStatusTerminals.includes('none')) problems.push('firstStatus emitted without a terminal_status label')

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`)
if (problems.length === 0) {
  console.log(`PASS — ${complete.length}/${attempts.length} attempts with three ordered stage timings`)
} else {
  console.log(`FAIL — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
}
console.log('='.repeat(78))
console.log('\nSample size is small and uncontrolled — these are shape checks, not benchmark results.')
process.exit(problems.length === 0 ? 0 : 1)
