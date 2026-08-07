/**
 * Plan steps 3 and 4 — live validation of the single Wallet+BSO path.
 *
 * Drives the real monitored code path (runOnce → createDefaultGridRunner →
 * runBenchmarkGrid), not a mock, so what it exercises is what AWS runs. Reads
 * credentials from the environment only — never from arguments.
 *
 * Checks everywhere:
 *   - canonical terminates on 200 only
 *   - firstStatus <= canonical, and both carry a terminal_status metric label
 *   - providerReceipt is not emitted for the wallet path
 *
 * On base-mainnet additionally:
 *   - preconf is observed, and preconf < firstStatus
 *
 * On any other network additionally:
 *   - preconf is not-observed (no Flashblock stream exists there)
 *   - no iteration burns the preconf timeout waiting on a stream that cannot
 *     produce anything
 *
 * Usage:
 *   set -a; source .env.aws-repro.local; set +a
 *   NETWORK=base-mainnet RUN_COUNT=5 bun run scripts/validate-single-path-run.ts
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

const network = process.env.NETWORK ?? 'base-mainnet'
const isBase = network === 'base-mainnet'
// The stall this guards against was one full preconf timeout per iteration on
// networks with no Flashblock stream.
const preconfTimeoutMs = Number(process.env.TIMEOUT_PRECONF_MS ?? 30_000)

console.log(`network=${network}  preconf timeout=${preconfTimeoutMs}ms\n`)

const started = Date.now()
await runOnce(credentials, metrics, process.env.AWS_REGION ?? 'us-east-1', {
  baseEnv: { ...process.env, NETWORKS: network } as Record<string, string>,
})
console.log = origLog

const elapsedMs = Date.now() - started
const elapsedS = (elapsedMs / 1000).toFixed(1)

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

if (attempts.length === 0) problems.push('no attempts were recorded')

const statusTimed = rows.filter(r => r.first != null && r.canon != null)
if (statusTimed.length === 0) problems.push('no attempt produced both status stage timings')
for (const r of statusTimed) {
  if (!(r.first! <= r.canon!)) problems.push(`attempt ${r.i}: firstStatus ${r.first} !<= canonical ${r.canon}`)
}

if (isBase) {
  const withPreconf = rows.filter(r => r.preconf != null)
  if (withPreconf.length === 0) problems.push('no attempt observed a preconf on base-mainnet')
  for (const r of withPreconf) {
    if (r.first != null && !(r.preconf! < r.first!)) {
      problems.push(`attempt ${r.i}: preconf ${r.preconf} !< firstStatus ${r.first}`)
    }
  }
} else {
  for (const a of attempts) {
    if (a.stages.preconf?.outcome !== 'not-observed') {
      problems.push(`attempt ${a.run_index}: preconf is "${a.stages.preconf?.outcome}", expected not-observed off Base`)
    }
  }
  // Before the fix, every iteration ran the no-op WS watch to the full preconf
  // timeout. Half that budget per iteration is a wide margin around the ~2s a
  // healthy iteration takes, and still far below a single stalled one.
  const perIterationMs = elapsedMs / Math.max(attempts.length, 1)
  if (perIterationMs >= preconfTimeoutMs / 2) {
    problems.push(
      `${Math.round(perIterationMs)}ms per iteration — at or above half the ${preconfTimeoutMs}ms ` +
      'preconf timeout, which is what the no-op Flashblock watch used to cost',
    )
  }
  console.log(`\nper-iteration wall clock: ${Math.round(perIterationMs)}ms ` +
    `(a stalled iteration would be >= ${preconfTimeoutMs}ms)`)
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
for (const s of isBase ? ['preconf', 'firstStatus', 'canonical'] : ['firstStatus', 'canonical']) {
  if (!stagesSeen.has(s)) problems.push(`no latency series emitted for stage "${s}"`)
}
if (!isBase && stagesSeen.has('preconf')) {
  problems.push('a preconf latency series was emitted off Base, where none can be measured')
}
if (stagesSeen.has('providerReceipt')) problems.push('providerReceipt series emitted for the wallet path')

const firstStatusTerminals = counts
  .filter(v => v.labels.stage === 'firstStatus')
  .map(v => String(v.labels.terminal_status))
if (firstStatusTerminals.includes('none')) problems.push('firstStatus emitted without a terminal_status label')

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`)
if (problems.length === 0) {
  console.log(`PASS — ${network}: ${attempts.length} attempts, ${statusTimed.length} with ordered status stages`)
} else {
  console.log(`FAIL — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
}
console.log('='.repeat(78))
console.log('\nSample size is small and uncontrolled — these are shape checks, not benchmark results.')
process.exit(problems.length === 0 ? 0 : 1)
