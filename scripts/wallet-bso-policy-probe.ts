#!/usr/bin/env bun
/**
 * Unit 0 gate for docs/plans/2026-08-06-001-refactor-single-path-wallet-bso-benchmark-plan.md
 *
 * Question: is supplying a BSO policy ID as the Wallet API's paymaster policy
 * enough to get bundler-sponsored operations through the Wallet path?
 *
 * Why this needs checking rather than assuming: the two adapters sponsor by
 * different mechanisms today.
 *   - Wallet  (alchemy-wallet-sendcalls.ts): `paymaster: { policyId }` on the SDK
 *     client plus per-call `capabilities`. A paymaster *contract* pays.
 *   - BSO     (alchemy-mav2-bso.ts:170,277-280): an `x-alchemy-policy-id` HTTP
 *     header AND all three gas fields zeroed, which is the signal for the
 *     *bundler* to cover gas under the policy.
 *
 * So there are three possible outcomes, and the dangerous one is the third:
 *   (a) it errors            -> Unit 1 needs the header mechanism instead
 *   (b) it works as BSO      -> plan proceeds as written
 *   (c) it "works" but quietly applies ordinary paymaster sponsorship, i.e. we
 *       ship a benchmark labelled BSO that is not BSO
 *
 * To separate (b) from (c) this sends one op under each policy and diffs the
 * prepared user operation. If both produce the same paymaster contract and
 * comparable gas fields, that is evidence for (c) and the gate should fail.
 *
 * This script does not modify the adapter — it constructs the client directly so
 * the gate can run before any production code changes. It relies on the stable
 * owner already being 7702-delegated (true after any prior monitor/probe run).
 *
 * Run: bun --env-file=.env.aws-repro.local run scripts/wallet-bso-policy-probe.ts
 *
 * NOTE: sends real sponsored transactions on Base mainnet under both policies.
 */

import { createSmartWalletClient, alchemyWalletTransport } from '@alchemy/wallet-apis'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from '../src/benchmark/config'
import { resolveChain } from '../src/benchmark/chains'
import { serializeErrorRedacted } from '../src/benchmark/serialize'

const STATUS_CONFIRMED = 200
const POLL_MS = 250
const STATUS_TIMEOUT_MS = 30_000
const SETTLE_MS = 12_000

const jsonSafe = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : jsonSafe(v)
  return s == null ? 'absent' : s.length > 24 ? `${s.slice(0, 24)}…(${s.length} chars)` : s
}

// Fields that reveal *how* the op is being paid for.
const SPONSORSHIP_FIELDS = [
  'paymaster', 'paymasterData', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit',
  'maxFeePerGas', 'maxPriorityFeePerGas', 'preVerificationGas',
  'callGasLimit', 'verificationGasLimit',
] as const

type Outcome = {
  label: string
  policyId: string
  ok: boolean
  error?: string
  fields: Record<string, string>
  callId?: string
  terminalStatus?: number
  minedMs?: number
}

async function main() {
  const config = loadConfig(process.env)
  const alchemy = config.providers.alchemy
  if (!alchemy) throw new Error('Alchemy not configured — set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID')
  if (!alchemy.bsoPolicyId) throw new Error('ALCHEMY_BSO_POLICY_ID is not set — nothing to compare')
  if (!config.ownerPrivateKey) throw new Error('OWNER_PRIVATE_KEY required (stable, already-delegated owner)')

  const redact = (e: unknown) =>
    serializeErrorRedacted(e, config.ownerPrivateKey, [alchemy.apiKey, alchemy.policyId, alchemy.bsoPolicyId!]).message

  const chain = resolveChain(config.network)
  const signer = privateKeyToAccount(config.ownerPrivateKey)
  const request = alchemyWalletTransport({ apiKey: alchemy.apiKey })({ chain }).request
  const getStatus = (callId: string) =>
    request({ method: 'wallet_getCallsStatus', params: [callId] } as never) as Promise<{ status?: number }>

  console.log('Unit 0 — BSO policy through the Wallet API path')
  console.log(`  network   ${config.network}`)
  console.log(`  signer    ${signer.address}`)
  console.log(`  policies  regular=…${alchemy.policyId.slice(-6)}  bso=…${alchemy.bsoPolicyId.slice(-6)}\n`)

  const variants = [
    { label: 'regular (ALCHEMY_POLICY_ID)', policyId: alchemy.policyId },
    { label: 'BSO (ALCHEMY_BSO_POLICY_ID)', policyId: alchemy.bsoPolicyId },
  ]

  const outcomes: Outcome[] = []

  for (const [i, variant] of variants.entries()) {
    console.log(`── ${variant.label} ──`)
    const outcome: Outcome = { label: variant.label, policyId: variant.policyId, ok: false, fields: {} }

    try {
      const client = createSmartWalletClient({
        signer,
        transport: alchemyWalletTransport({ apiKey: alchemy.apiKey }),
        chain,
        paymaster: { policyId: variant.policyId },
      })

      const prepared = await client.prepareCalls({
        calls: [{ to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n }],
        capabilities: { paymaster: { policyId: variant.policyId } },
      })

      // Pull the sponsorship-revealing fields out of the prepared user operation.
      const data = (prepared as Record<string, unknown>).data as Record<string, unknown> | undefined
      const source = data ?? (prepared as Record<string, unknown>)
      for (const f of SPONSORSHIP_FIELDS) {
        outcome.fields[f] = f in source ? short(source[f]) : 'absent'
      }
      console.log(`  prepared keys: ${Object.keys(prepared as object).join(', ')}`)
      for (const [k, v] of Object.entries(outcome.fields)) console.log(`    ${k.padEnd(30)} ${v}`)

      const signed = await client.signPreparedCalls(prepared)
      const t0 = performance.now()
      const sent = await client.sendPreparedCalls(signed)
      outcome.callId = sent.id

      // Confirm it actually mines — a sponsored op that is accepted but never
      // included would otherwise read as success.
      const deadline = performance.now() + STATUS_TIMEOUT_MS
      while (performance.now() < deadline) {
        const res = await getStatus(sent.id)
        if (typeof res?.status === 'number' && res.status >= STATUS_CONFIRMED) {
          outcome.terminalStatus = res.status
          outcome.minedMs = performance.now() - t0
          break
        }
        await sleep(POLL_MS)
      }

      outcome.ok = outcome.terminalStatus === STATUS_CONFIRMED
      console.log(`  sent      callId ${sent.id.slice(0, 18)}…`)
      console.log(`  status    ${outcome.terminalStatus ?? 'no terminal status before timeout'}`)
      console.log(`  mined in  ${outcome.minedMs != null ? `${Math.round(outcome.minedMs)}ms` : '—'}`)
      console.log(`  RESULT    ${outcome.ok ? 'sponsored + mined' : 'DID NOT CONFIRM'}\n`)
    } catch (e) {
      outcome.error = redact(e)
      console.log(`  RESULT    FAILED: ${outcome.error.split('\n')[0]}\n`)
    }

    outcomes.push(outcome)
    if (i < variants.length - 1) await sleep(SETTLE_MS)
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const [regular, bso] = outcomes as [Outcome, Outcome]
  console.log('─'.repeat(74))

  const differing = SPONSORSHIP_FIELDS.filter(f => regular.fields[f] !== bso.fields[f])
  const samePaymaster =
    regular.fields['paymaster'] !== undefined &&
    regular.fields['paymaster'] === bso.fields['paymaster'] &&
    regular.fields['paymaster'] !== 'absent'

  console.log('field-level diff (regular vs BSO):')
  if (!bso.ok && bso.error) {
    console.log('  n/a — BSO variant failed before producing a comparable op')
  } else if (differing.length === 0) {
    console.log('  none — every sponsorship field is identical')
  } else {
    for (const f of differing) console.log(`  ${f.padEnd(30)} ${regular.fields[f]}  ->  ${bso.fields[f]}`)
  }
  console.log('')

  if (!bso.ok) {
    console.log('GATE: FAIL (outcome a) — the BSO policy did not produce a sponsored, mined op')
    console.log('  through the Wallet paymaster path. Unit 1 likely needs the BSO mechanism from')
    console.log('  alchemy-mav2-bso.ts (x-alchemy-policy-id header + zeroed gas fields) rather')
    console.log('  than a paymaster policy ID. Do NOT remove the 4337 monitoring row yet.')
    if (bso.error) console.log(`  error: ${bso.error.split('\n').slice(0, 3).join(' ')}`)
  } else if (samePaymaster && differing.length === 0) {
    console.log('GATE: INCONCLUSIVE, LEANING FAIL (outcome c) — the BSO policy was accepted and')
    console.log('  mined, but the prepared op is byte-for-byte identical in every sponsorship')
    console.log(`  field and uses the same paymaster contract (${regular.fields['paymaster']}).`)
    console.log('  That is consistent with ordinary paymaster sponsorship being applied while we')
    console.log('  label it BSO. Confirm with the Wallet API team what a BSO policy is supposed')
    console.log('  to change here before proceeding — shipping this would mislabel the benchmark.')
  } else {
    console.log('GATE: PASS (outcome b) — the BSO policy produced a sponsored, mined op via the')
    console.log('  Wallet paymaster path, and the prepared op differs from the regular policy in')
    console.log(`  ${differing.length} sponsorship field(s) (listed above). Unit 1 can proceed with a`)
    console.log('  cfg.policyId -> cfg.bsoPolicyId swap. Worth a second pair of eyes on whether')
    console.log('  those differences are what BSO is expected to look like.')
  }

  console.log('')
  console.log('mined latency is incidental here (n=1 per policy, not a benchmark).')
  for (const o of outcomes) {
    console.log(`  ${o.label.padEnd(30)} ${o.ok ? `${Math.round(o.minedMs!)}ms` : 'n/a'}`)
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('probe failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
