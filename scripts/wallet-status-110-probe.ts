#!/usr/bin/env bun
/**
 * Does wallet_getCallsStatus ever emit status 110 (Flashblock-preconfirmed) on Base?
 *
 * The monitor treats 110 as its preconfirmation signal for the wallet-sendcalls
 * modality, but production data shows the `ttm` stage landing at ~1.7s (one
 * Base block) with zero observations under 500ms — consistent with the API going
 * 100 → 200 and never surfacing 110. Our normal observer polls on a 250ms fast
 * interval, so this probe re-checks at a much tighter cadence to rule out the
 * alternative explanation: that 110 is real but too short-lived for us to sample.
 *
 * Method, per iteration:
 *   1. Send one sponsored sendCalls through the production adapter path.
 *   2. Poll wallet_getCallsStatus on a FIXED cadence with concurrent in-flight
 *      requests, so sampling resolution is set by the cadence and not by RPC
 *      round-trip time. Every response is recorded, not just transitions.
 *   3. Concurrently watch the neutral Flashblocks WS for the same userOpHash to
 *      get ground truth for when the op was actually preconfirmed.
 *
 * The output reports the largest gap between consecutive status samples. That is
 * the honest bound on this probe: a 110 window shorter than that gap could have
 * been missed, so "110 never appeared" is only as strong as that number is small.
 *
 * Prerequisites: ALCHEMY_API_KEY, ALCHEMY_POLICY_ID, OWNER_PRIVATE_KEY, and
 * NEUTRAL_FLASHBLOCK_WS_URL (optional, but without it there is no ground truth
 * to compare against).
 *
 * Run: bun --env-file=.env.aws-repro.local run scripts/wallet-status-110-probe.ts
 *
 * Tunables (env): PROBE_POLL_MS (default 40), PROBE_ITERATIONS (default 5),
 * PROBE_TIMEOUT_MS (default 15000).
 *
 * NOTE: this sends real sponsored transactions on Base mainnet and draws on the
 * configured Gas Manager policy — the same operation the monitor performs 20x an
 * hour, but be deliberate about the iteration count.
 */

import { alchemyWalletTransport } from '@alchemy/wallet-apis'
import { loadConfig } from '../src/benchmark/config'
import { alchemyWalletSendCallsAdapter } from '../src/benchmark/providers/alchemy-wallet-sendcalls'
import { createFlashblockOracle } from '../src/benchmark/oracle/flashblocks'
import { resolveChain } from '../src/benchmark/chains'
import { serializeErrorRedacted } from '../src/benchmark/serialize'

const STATUS_PRECONFIRMED = 110
const STATUS_CONFIRMED = 200

// Observed 110 windows are 123-224ms wide, so the cadence has to keep the worst
// sample gap comfortably under ~120ms or absences cannot be distinguished from
// missed samples. A 100ms cadence measured a 206ms worst gap — too coarse. These
// defaults measured 66-113ms.
const POLL_MS = Number(process.env.PROBE_POLL_MS ?? 40)
const ITERATIONS = Number(process.env.PROBE_ITERATIONS ?? 5)
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 15_000)
const MAX_IN_FLIGHT = Number(process.env.PROBE_MAX_IN_FLIGHT ?? 8)
// Sending again too soon reuses the stable owner's nonce while the prior op is
// still settling, which the bundler rejects as "replacement underpriced".
// All iterations share one stable owner EOA, so an op still in the mempool makes
// the next send collide on nonce ("replacement underpriced"). That failure then
// cascades: the dropped bundle leaves later polls hitting an unknown bundle id and
// later ops queued behind it for seconds. A settle gap well over one block avoids
// the whole class of contamination.
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS ?? 12_000)
// An iteration whose polls mostly failed cannot support a claim about whether
// 110 appeared, so it is excluded from the frequency statistic.
const MAX_CLEAN_ERROR_RATE = 0.1

type Sample = { atMs: number; status: number | null; error?: string }

type IterationResult = {
  iteration: number
  callId: string
  userOpHash: string
  submitMs: number
  samples: Sample[]
  first110Ms: number | null
  first200Ms: number | null
  statusesSeen: number[]
  maxSampleGapMs: number
  flashblockMs: number | null
  errorRate: number
  sendError?: string
}

// JSON.stringify chokes on the BigInts that appear in receipt payloads.
const jsonSafe = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
const fmt = (ms: number | null): string => (ms == null ? '     —' : `${Math.round(ms).toString().padStart(5)}ms`)

async function main() {
  const config = loadConfig(process.env)

  if (config.network !== 'base-mainnet') {
    throw new Error(`This probe is Base-specific; NETWORK is "${config.network}". Flashblocks and status 110 only apply to base-mainnet.`)
  }
  const alchemy = config.providers.alchemy
  if (!alchemy) {
    throw new Error('Alchemy is not configured — set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID')
  }
  const redact = (e: unknown) =>
    serializeErrorRedacted(e, config.ownerPrivateKey, [alchemy.apiKey]).message

  // Same transport the adapter's own status observer builds, so we are exercising
  // the identical RPC path rather than an approximation of it.
  const chain = resolveChain(config.network)
  const request = alchemyWalletTransport({ apiKey: alchemy.apiKey })({ chain }).request
  const getStatus = (callId: `0x${string}`) =>
    request({ method: 'wallet_getCallsStatus', params: [callId] } as never) as Promise<{
      status?: number
      [k: string]: unknown
    }>

  console.log('wallet_getCallsStatus 110 probe')
  console.log(`  network            ${config.network}`)
  console.log(`  poll cadence       ${POLL_MS}ms (fixed, concurrent in-flight up to ${MAX_IN_FLIGHT})`)
  console.log(`  iterations         ${ITERATIONS}`)
  console.log(`  per-op timeout     ${TIMEOUT_MS}ms`)
  console.log(`  owner key          ${config.ownerPrivateKey ? 'stable (bootstrapped)' : 'per-run random'}`)

  const fb = config.neutral.flashblockWsUrl
    ? createFlashblockOracle(config.neutral.flashblockWsUrl)
    : null
  if (fb) {
    const ok = await fb.ready(10_000).then(() => true, () => false)
    console.log(`  flashblock oracle  ${ok ? 'subscribed (ground truth available)' : 'NOT subscribed — no ground truth'}`)
  } else {
    console.log('  flashblock oracle  NEUTRAL_FLASHBLOCK_WS_URL unset — no ground truth')
  }
  console.log('')

  const client = await alchemyWalletSendCallsAdapter.buildAccountClient(config)
  if (typeof client.ensureDeployed === 'function') {
    console.log('Bootstrapping EIP-7702 delegation (untimed)…')
    await client.ensureDeployed()
    console.log('Bootstrap complete.\n')
  }

  // Keep one raw response per distinct status so we can inspect the payload shape
  // for any preconfirmation hint the status code itself does not carry.
  const rawByStatus = new Map<number, unknown>()
  const results: IterationResult[] = []

  for (let i = 0; i < ITERATIONS; i++) {
    let sent: Awaited<ReturnType<typeof client.sendSponsored>>
    try {
      sent = await client.sendSponsored()
    } catch (e) {
      results.push({
        iteration: i, callId: '—', userOpHash: '—', submitMs: 0, samples: [],
        first110Ms: null, first200Ms: null, statusesSeen: [], maxSampleGapMs: 0,
        flashblockMs: null, errorRate: 1, sendError: redact(e),
      })
      console.log(`#${i + 1}  send failed: ${redact(e)}`)
      continue
    }

    const callId = (sent.canonicalIdentifier ?? sent.userOpHash) as `0x${string}`
    const t0 = sent.acceptedAtMs ?? performance.now()

    // Registered after send — the oracle's lookback buffer covers the window
    // between inclusion and this call, so nothing is lost by not pre-registering.
    const fbPromise: Promise<{ status: string; tMs?: number }> = fb
      ? fb.watch(sent.userOpHash, TIMEOUT_MS).catch(() => ({ status: 'not-observed' }))
      : Promise.resolve({ status: 'not-observed' })

    const samples: Sample[] = []
    let inFlight = 0
    let terminal = false

    await new Promise<void>(resolve => {
      const started = performance.now()
      const timer = setInterval(() => {
        if (terminal || performance.now() - started >= TIMEOUT_MS) {
          clearInterval(timer)
          resolve()
          return
        }
        if (inFlight >= MAX_IN_FLIGHT) return
        inFlight++
        getStatus(callId)
          .then(res => {
            const status = typeof res?.status === 'number' ? res.status : null
            samples.push({ atMs: performance.now() - t0, status })
            if (status != null && !rawByStatus.has(status)) rawByStatus.set(status, res)
            if (status != null && status >= STATUS_CONFIRMED) terminal = true
          })
          .catch(err => {
            samples.push({ atMs: performance.now() - t0, status: null, error: redact(err) })
          })
          .finally(() => { inFlight-- })
      }, POLL_MS)
    })

    // Let in-flight requests land so late samples are not dropped from the record.
    for (let waited = 0; inFlight > 0 && waited < 3_000; waited += 50) await sleep(50)

    const fbResult = await fbPromise
    const flashblockMs =
      fbResult.status === 'ok' && fbResult.tMs != null ? fbResult.tMs - t0 : null

    samples.sort((a, b) => a.atMs - b.atMs)
    const first110Ms = samples.find(s => s.status === STATUS_PRECONFIRMED)?.atMs ?? null
    const first200Ms = samples.find(s => s.status != null && s.status >= STATUS_CONFIRMED)?.atMs ?? null
    const statusesSeen = [...new Set(samples.map(s => s.status).filter((s): s is number => s != null))].sort((a, b) => a - b)

    // Largest gap between consecutive samples up to the terminal observation —
    // the resolution bound on any "we would have seen it" claim.
    const upTo = first200Ms ?? Infinity
    const relevant = samples.filter(s => s.atMs <= upTo)
    let maxSampleGapMs = 0
    for (let k = 1; k < relevant.length; k++) {
      maxSampleGapMs = Math.max(maxSampleGapMs, relevant[k]!.atMs - relevant[k - 1]!.atMs)
    }

    const errCountForRate = samples.filter(s => s.error).length
    const errorRate = samples.length > 0 ? errCountForRate / samples.length : 1

    results.push({
      iteration: i, callId, userOpHash: sent.userOpHash, submitMs: sent.submitMs,
      samples, first110Ms, first200Ms, statusesSeen, maxSampleGapMs, flashblockMs, errorRate,
    })

    const transitions: string[] = []
    let prev: number | null | undefined
    for (const s of samples) {
      if (s.status !== prev) {
        transitions.push(`${s.status ?? 'err'}@${Math.round(s.atMs)}ms`)
        prev = s.status
      }
    }
    const errCount = errCountForRate
    const clean = errorRate <= MAX_CLEAN_ERROR_RATE
    console.log(
      `#${i + 1}  flashblock ${fmt(flashblockMs)} | first 200 ${fmt(first200Ms)} | 110 ${first110Ms == null ? 'NOT SEEN' : `SEEN at ${Math.round(first110Ms)}ms`}${clean ? '' : '  [CONTAMINATED — excluded]'}`,
    )
    console.log(
      `     samples ${samples.length} (max gap ${Math.round(maxSampleGapMs)}ms${errCount ? `, ${errCount} errored = ${Math.round(errorRate * 100)}%` : ''}) | timeline ${transitions.join(' → ')}`,
    )
    if (errCount > 0) {
      const kinds = [...new Set(samples.filter(s => s.error).map(s => s.error!.split('\n')[0]!.slice(0, 90)))]
      for (const k of kinds.slice(0, 2)) console.log(`     poll error: ${k}`)
    }

    if (i < ITERATIONS - 1 && SETTLE_MS > 0) await sleep(SETTLE_MS)
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const sent = results.filter(r => !r.sendError)
  // Only iterations whose polling actually worked can speak to whether 110 appeared.
  const ok = sent.filter(r => r.errorRate <= MAX_CLEAN_ERROR_RATE)
  const contaminated = sent.length - ok.length
  const saw110 = ok.filter(r => r.first110Ms != null)
  const allStatuses = [...new Set(ok.flatMap(r => r.statusesSeen))].sort((a, b) => a - b)
  const worstGap = Math.max(0, ...ok.map(r => r.maxSampleGapMs))
  const medFb = median(ok.map(r => r.flashblockMs).filter((x): x is number => x != null))
  const med200 = median(ok.map(r => r.first200Ms).filter((x): x is number => x != null))
  const med110 = median(saw110.map(r => r.first110Ms).filter((x): x is number => x != null))
  // How far 110 trails the op actually being in a flashblock, paired per iteration.
  const lag110 = median(
    saw110
      .filter(r => r.flashblockMs != null && r.first110Ms != null)
      .map(r => r.first110Ms! - r.flashblockMs!),
  )

  console.log('\n' + '─'.repeat(78))
  console.log(`sends succeeded            ${sent.length}/${ITERATIONS}`)
  console.log(`usable iterations          ${ok.length}${contaminated ? ` (${contaminated} excluded: >${MAX_CLEAN_ERROR_RATE * 100}% poll errors)` : ''}`)
  console.log(`distinct statuses observed ${allStatuses.join(', ') || 'none'}`)
  console.log(`iterations showing 110     ${saw110.length}/${ok.length}`)
  console.log(`median flashblock inclusion${fmt(medFb)}   (neutral ground truth)`)
  console.log(`median first status 110    ${fmt(med110)}   (when observed at all)`)
  console.log(`median first status 200    ${fmt(med200)}   (what the API tells a caller)`)
  if (lag110 != null) {
    console.log(`110 lag behind flashblock  ${fmt(lag110)}   (paired per iteration)`)
  }
  if (medFb != null && med200 != null) {
    console.log(`withheld until 200         ${fmt(med200 - medFb)}   (200 minus flashblock)`)
  }
  console.log(`worst sampling gap         ${Math.round(worstGap)}ms   (resolution bound — see caveat)`)

  for (const [status, raw] of [...rawByStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const s = jsonSafe(raw)
    console.log(`\nraw response at status ${status}:\n  ${s.length > 1200 ? s.slice(0, 1200) + '… (truncated)' : s}`)
  }

  console.log('\n' + '─'.repeat(78))
  if (ok.length === 0) {
    console.log('VERDICT: INCONCLUSIVE — no iteration produced usable polling data.')
  } else if (saw110.length === ok.length) {
    console.log(`VERDICT: 110 flows through, on every one of ${ok.length} usable iterations.`)
  } else if (saw110.length > 0) {
    // Whether the 110-absent iterations are real absences or sampling misses hinges
    // on how the sampling gap compares to the narrowest 110 window actually seen.
    const windows = saw110
      .filter(r => r.first200Ms != null && r.first110Ms != null)
      .map(r => r.first200Ms! - r.first110Ms!)
    const narrowest = windows.length ? Math.min(...windows) : null
    console.log(`VERDICT: 110 flows through, but not on every op — ${saw110.length}/${ok.length} usable iterations.`)
    if (narrowest != null && worstGap < narrowest) {
      console.log(`  Narrowest observed 110 window ${Math.round(narrowest)}ms > worst sampling gap ${Math.round(worstGap)}ms, so`)
      console.log('  the 110-absent iterations are unlikely to be sampling misses: a window that')
      console.log('  wide should have been caught. Reads as genuinely intermittent emission.')
    } else {
      console.log(`  INCONCLUSIVE on frequency: worst sampling gap ${Math.round(worstGap)}ms is not smaller than the`)
      console.log(`  narrowest observed 110 window (${narrowest == null ? 'unknown' : Math.round(narrowest) + 'ms'}), so absences may just be missed samples.`)
      console.log('  Re-run with a smaller PROBE_POLL_MS before claiming anything about how often')
      console.log('  110 is emitted. Existence is already proven; frequency is not.')
    }
  } else {
    console.log(`VERDICT: 110 never observed across ${ok.length} usable iterations (only ${allStatuses.join(' → ')}).`)
  }
  if (saw110.length > 0 && lag110 != null) {
    console.log('')
    console.log(`  Crucially, 110 is NOT a flashblock-speed signal: it trails actual flashblock`)
    console.log(`  inclusion by ~${Math.round(lag110)}ms (median, paired). The 110 payload carries a full receipt`)
    console.log('  with a real blockHash whose blockNumber is one past pendingBundle.sentAtBlock,')
    console.log('  so it reads as early *block* inclusion, not sub-block preconfirmation. Treating')
    console.log('  110 as "preconfirmed" therefore does not buy flashblock latency — compare the')
    console.log('  neutral flashblock timing above against status 110/200 to see the real gap.')
  }
  console.log('')
  console.log('  Caveat: absence of 110 in an iteration is not proof it is unreachable there —')
  console.log('  it may depend on a capability opt-in, bundle shape, or block phase. Confirm the')
  console.log('  intended semantics with the Wallet API team before filing anything.')

  fb?.close()
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('probe failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
