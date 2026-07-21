import { entryPoint07Address } from 'viem/account-abstraction'
import type { Log } from 'viem'
import { USER_OP_EVENT, findUserOpInLogs } from './identity.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CanonicalObserverApi =
  | 'eth_getUserOperationReceipt'
  | 'wallet_getCallsStatus'
  | 'generic-log-scan'

export type CanonicalObservation = {
  api: CanonicalObserverApi
  pollCount: number
  terminalStatus?: string
  errorClass?: string
}

type CanonicalResultBase = {
  observation?: CanonicalObservation
}

export type CanonicalResult =
  | (CanonicalResultBase & { status: 'ok'; blockNumber?: bigint; txHash?: `0x${string}`; tMs: number })
  | (CanonicalResultBase & { status: 'timed-out' })
  | (CanonicalResultBase & { status: 'integrity-fail'; blockNumber?: bigint; reason: string })
  | (CanonicalResultBase & { status: 'observer-error'; reason: string })

export interface CanonicalObserver {
  readonly api: CanonicalObserverApi
  watch(identifier: `0x${string}`, timeoutMs: number): Promise<CanonicalResult>
}

type PendingWatch = {
  resolve: (result: CanonicalResult) => void
  fromBlock: bigint
  deadline: number
}

// Minimal public-client surface needed by the oracle (injectable for testing)
export interface CanonicalClient {
  getBlockNumber(): Promise<bigint>
  getLogs(params: {
    address: `0x${string}`
    event: typeof USER_OP_EVENT
    fromBlock: bigint
    toBlock: bigint
  }): Promise<Log[]>
  getTransactionReceipt(params: { hash: `0x${string}` }): Promise<{
    blockNumber: bigint
    blockHash: `0x${string}`
    status: 'success' | 'reverted'
  }>
}

export interface CanonicalOracle {
  /** Watch for canonical inclusion of userOpHash, starting search at fromBlock. */
  watch(userOpHash: `0x${string}`, fromBlock: bigint, timeoutMs: number): Promise<CanonicalResult>
  /** Current block number on the neutral node — call before submitting to bound the search. */
  getBlockNumber(): Promise<bigint>
  close(): void
}

// ── Implementation ────────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 500

export function createCanonicalOracle(
  client: CanonicalClient,
  pollIntervalMs = DEFAULT_POLL_MS
): CanonicalOracle {
  const pending = new Map<string, PendingWatch>()
  let running = false
  let loopPromise: Promise<void> | null = null
  // Track lowest fromBlock across all pending watches for the getLogs query range
  let globalSearchFrom = BigInt(Number.MAX_SAFE_INTEGER)

  function startLoop() {
    if (running) return
    running = true
    loopPromise = pollLoop()
  }

  async function pollLoop(): Promise<void> {
    while (running && pending.size > 0) {
      const now = performance.now()

      // Expire timed-out watches
      for (const [hash, watch] of pending) {
        if (now >= watch.deadline) {
          watch.resolve({ status: 'timed-out' })
          pending.delete(hash)
        }
      }

      if (pending.size === 0) break

      try {
        const latest = await client.getBlockNumber()
        if (latest >= globalSearchFrom) {
          const logs = await client.getLogs({
            address: entryPoint07Address,
            event: USER_OP_EVENT,
            fromBlock: globalSearchFrom,
            toBlock: latest,
          })

          for (const log of logs) {
            if (!log.topics[1]) continue
            const userOpHash = log.topics[1] as `0x${string}`
            const watch = pending.get(userOpHash.toLowerCase())
            if (!watch) continue

            // Integrity cross-validation: a second read must agree on block + tx
            const validated = await crossValidate(client, log)
            if (validated.ok) {
              watch.resolve({
                status: 'ok',
                blockNumber: log.blockNumber!,
                txHash: log.transactionHash!,
                tMs: performance.now(),
              })
              pending.delete(userOpHash.toLowerCase())
            } else {
              // Node returned inconsistent data — log and keep searching
              // (Do not resolve; let it retry on the next poll)
              watch.resolve({
                status: 'integrity-fail',
                blockNumber: log.blockNumber ?? 0n,
                reason: validated.reason,
              })
              pending.delete(userOpHash.toLowerCase())
            }
          }

          globalSearchFrom = latest + 1n
        }
      } catch {
        // Network error on getLogs/getBlockNumber — retry on next iteration
      }

      await sleep(pollIntervalMs)
    }
    running = false
  }

  async function crossValidate(
    c: CanonicalClient,
    log: Log
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (log.blockNumber == null || log.transactionHash == null || log.blockHash == null) {
      return { ok: false, reason: 'log missing blockNumber, txHash, or blockHash' }
    }
    try {
      const receipt = await c.getTransactionReceipt({ hash: log.transactionHash })
      if (receipt.blockNumber !== log.blockNumber) {
        return {
          ok: false,
          reason: `block mismatch: log=${log.blockNumber} receipt=${receipt.blockNumber}`,
        }
      }
      if (receipt.blockHash !== log.blockHash) {
        return {
          ok: false,
          reason: `blockHash mismatch — possible reorg`,
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: `receipt fetch failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  return {
    watch(userOpHash, fromBlock, timeoutMs) {
      return new Promise<CanonicalResult>(resolve => {
        const key = userOpHash.toLowerCase()
        pending.set(key, {
          resolve,
          fromBlock,
          deadline: performance.now() + timeoutMs,
        })
        // Update shared search start
        if (fromBlock < globalSearchFrom) globalSearchFrom = fromBlock
        startLoop()
      })
    },

    getBlockNumber() {
      return client.getBlockNumber()
    },

    close() {
      running = false
      // Resolve any remaining watches as timed-out
      for (const [, watch] of pending) watch.resolve({ status: 'timed-out' })
      pending.clear()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
