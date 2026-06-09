#!/usr/bin/env bun
/**
 * U11 — Receipt-Lag Premise Spike
 *
 * Sends one sponsored Alchemy Light Account userOp on Base mainnet, then races
 * two inclusion-detection methods concurrently:
 *   (a) Alchemy's own getUserOperationReceipt polling  (bundler RPC)
 *   (b) Neutral node canonical polling via UserOperationEvent log  (independent node)
 *
 * The delta (a - b) isolates receipt-polling lag. If it is multi-second, the
 * core premise holds and Phase A can proceed. If sub-second, the ZeroDev
 * benchmark gap is likely protocol-class or account-weight effects, not
 * receipt-polling lag — pause and revisit the diagnosis before building.
 *
 * Prerequisites (copy .env.example → .env and fill in):
 *   ALCHEMY_API_KEY   — API key for the Alchemy bundler + Gas Manager
 *   ALCHEMY_POLICY_ID — Gas Manager policy ID
 *   NEUTRAL_RPC_URL   — Independent Base mainnet HTTP RPC (must NOT be Alchemy).
 *                       Defaults to https://mainnet.base.org if unset.
 *
 * Run: bun run scripts/premise-spike.ts
 */

import { createPublicClient, http, parseAbiItem } from 'viem'
import { base as viemBase } from 'viem/chains'
import { createBundlerClient, entryPoint07Address } from 'viem/account-abstraction'
import { generatePrivateKey } from 'viem/accounts'
import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'

// ── Config & guards ───────────────────────────────────────────────────────────

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const ALCHEMY_POLICY_ID = process.env.ALCHEMY_POLICY_ID
if (!ALCHEMY_API_KEY) throw new Error('Missing ALCHEMY_API_KEY in environment')
if (!ALCHEMY_POLICY_ID) throw new Error('Missing ALCHEMY_POLICY_ID in environment')

// Narrowed to string after above guard — required for AlchemyTransport config types
const apiKey: string = ALCHEMY_API_KEY
const policyId: string = ALCHEMY_POLICY_ID

const NEUTRAL_RPC = process.env.NEUTRAL_RPC_URL ?? 'https://mainnet.base.org'
const ALCHEMY_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`

// Neutrality guard: catch obvious misconfigurations where neutral == provider
if (NEUTRAL_RPC.includes('alchemy.com') || NEUTRAL_RPC.includes('g.alchemy')) {
  console.error(
    'NEUTRAL_RPC_URL must not be an Alchemy endpoint.\n' +
    'Set an independent Base mainnet RPC (e.g. https://mainnet.base.org).'
  )
  process.exit(1)
}

const POLL_MS = 500
const TIMEOUT_MS = 120_000

const USER_OP_EVENT = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'
)

// ── Clients ───────────────────────────────────────────────────────────────────

// Alchemy bundler client — used only for receipt polling (not account construction)
const bundlerClient = createBundlerClient({ chain: viemBase, transport: http(ALCHEMY_RPC) })

// Neutral canonical node — must not be Alchemy
const neutralClient = createPublicClient({ chain: viemBase, transport: http(NEUTRAL_RPC) })

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function pollAlchemyReceipt(userOpHash: `0x${string}`): Promise<{
  tMs: number
  blockNumber: bigint
  txHash: `0x${string}`
}> {
  const deadline = performance.now() + TIMEOUT_MS
  while (performance.now() < deadline) {
    try {
      const r = await bundlerClient.getUserOperationReceipt({ hash: userOpHash })
      if (r) {
        return {
          tMs: performance.now(),
          blockNumber: r.receipt.blockNumber,
          txHash: r.receipt.transactionHash,
        }
      }
    } catch (e) {
      // viem 2.52 throws when receipt not yet available — treat as pending
      if (!(e instanceof Error) || !e.message.includes('could not be found')) throw e
    }
    await sleep(POLL_MS)
  }
  throw new Error(`Alchemy receipt poll timed out after ${TIMEOUT_MS / 1000}s`)
}

async function pollNeutralInclusion(
  userOpHash: `0x${string}`,
  fromBlock: bigint
): Promise<{
  tMs: number
  blockNumber: bigint
  txHash: `0x${string}`
}> {
  const deadline = performance.now() + TIMEOUT_MS
  let searchFrom = fromBlock

  while (performance.now() < deadline) {
    const latest = await neutralClient.getBlockNumber()
    if (latest >= searchFrom) {
      const logs = await neutralClient.getLogs({
        address: entryPoint07Address,
        event: USER_OP_EVENT,
        args: { userOpHash },
        fromBlock: searchFrom,
        toBlock: latest,
      })
      if (logs.length > 0 && logs[0].blockNumber != null && logs[0].transactionHash != null) {
        return {
          tMs: performance.now(),
          blockNumber: logs[0].blockNumber,
          txHash: logs[0].transactionHash,
        }
      }
      searchFrom = latest + 1n
    }
    await sleep(POLL_MS)
  }
  throw new Error(`Neutral canonical poll timed out after ${TIMEOUT_MS / 1000}s`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('U11 — Receipt-Lag Premise Spike')
  console.log('  Bundler:     Alchemy (Base mainnet, Light Account)')
  console.log(`  Neutral RPC: ${NEUTRAL_RPC}`)
  console.log()

  // Fresh owner per run — no funding needed (sponsored)
  const privateKey = generatePrivateKey()
  const signer = LocalAccountSigner.privateKeyToAccountSigner(privateKey)

  // Light Account client with Alchemy Gas Manager sponsorship
  const akClient = await createLightAccountAlchemyClient({
    transport: alchemy({ apiKey }),
    chain: base,
    signer,
    policyId,
  })

  console.log('  Account:', akClient.account.address)

  // Capture neutral-node block before submission to bound the log search
  const submissionBlock = await neutralClient.getBlockNumber()

  // ── Submit ──────────────────────────────────────────────────────────────────
  console.log('\nSubmitting sponsored userOp (no-op self-call)...')
  const tSubmit = performance.now()

  const { hash: userOpHash } = await akClient.sendUserOperation({
    uo: { target: akClient.account.address, data: '0x', value: 0n },
  })

  const tAccepted = performance.now()
  console.log(`  userOpHash:    ${userOpHash}`)
  console.log(`  submit/accept: ${(tAccepted - tSubmit).toFixed(0)}ms`)
  console.log('\nRacing Alchemy receipt vs neutral canonical inclusion...')

  // ── Race (concurrent) ───────────────────────────────────────────────────────
  const [alchemyResult, neutralResult] = await Promise.all([
    pollAlchemyReceipt(userOpHash),
    pollNeutralInclusion(userOpHash, submissionBlock),
  ])

  // ── Report ───────────────────────────────────────────────────────────────────
  const canonicalMs = neutralResult.tMs - tAccepted
  const receiptMs = alchemyResult.tMs - tAccepted
  const lagMs = alchemyResult.tMs - neutralResult.tMs  // positive = receipt lagged

  console.log()
  console.log('── Results ──────────────────────────────────────────────────────')
  console.log(`  submit/accept lag:            ${(tAccepted - tSubmit).toFixed(0)}ms`)
  console.log(`  neutral canonical detected:   t+${canonicalMs.toFixed(0)}ms  (block ${neutralResult.blockNumber})`)
  console.log(`  alchemy receipt available:    t+${receiptMs.toFixed(0)}ms  (block ${alchemyResult.blockNumber})`)
  console.log(`  receipt lag (receipt-canon):  ${lagMs >= 0 ? '+' : ''}${lagMs.toFixed(0)}ms`)
  console.log()
  console.log(`  tx hash (block explorer):     ${neutralResult.txHash}`)
  console.log(`  userOpHash:                   ${userOpHash}`)
  console.log()

  // ── Premise Verdict ──────────────────────────────────────────────────────────
  console.log('── Premise Verdict ──────────────────────────────────────────────')
  if (lagMs > 2_000) {
    console.log(`✅  PREMISE HOLDS — ${lagMs.toFixed(0)}ms receipt lag (>2s).`)
    console.log('    Provider receipt-polling is a dominant term in the observed')
    console.log('    benchmark gap. Proceed to Phase A.')
  } else if (lagMs > 500) {
    console.log(`⚠️   MARGINAL — ${lagMs.toFixed(0)}ms receipt lag (500ms–2s).`)
    console.log('    Receipt lag exists but may not fully explain a multi-second gap.')
    console.log('    Consider running the spike 2–3 more times before proceeding.')
  } else if (lagMs >= 0) {
    console.log(`❌  WEAK — ${lagMs.toFixed(0)}ms receipt lag (<500ms).`)
    console.log('    Receipt-polling is not the primary driver. The ZeroDev gap is')
    console.log('    likely protocol-class + account-weight effects. Pause and revisit')
    console.log('    the diagnosis before building the full harness.')
  } else {
    console.log(`❌  PREMISE FAILS — Alchemy receipt arrived ${Math.abs(lagMs).toFixed(0)}ms BEFORE`)
    console.log('    neutral detection. Diagnosis is likely wrong — return to brainstorm.')
  }
}

main().catch(err => {
  console.error('\nSpike failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
