import { findUserOpInRawLogs } from './identity.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FlashblockResult =
  | { status: 'ok'; blockNumber: bigint; flashblockIndex: number; tMs: number }
  | { status: 'not-observed' }          // timed out or schema mismatch
  | { status: 'not-attributable' }      // intent-relay with no observable on-chain identity

type PendingWatch = {
  resolve: (result: FlashblockResult) => void
  deadline: number
}

// Minimal WebSocket surface needed (injectable for testing)
export interface FlashblocksWs {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
}

export type WsFactory = (url: string) => FlashblocksWs

export interface FlashblockOracle {
  /** Watch for a preconf of userOpHash; resolves when observed or timed out. */
  watch(userOpHash: `0x${string}`, timeoutMs: number): Promise<FlashblockResult>
  close(): void
}

// ── Flashblock message schema ─────────────────────────────────────────────────
//
// With eth_subscribe("newFlashblockTransactions", true), each notification's
// params.result is a merged tx+receipt object — logs are top-level, blockNumber
// is camelCase hex. There is no metadata.receipts wrapper.

interface FlashblockPayload {
  blockNumber?: string          // camelCase hex, e.g. "0x1234"
  transactionIndex?: string     // camelCase hex
  logs?: unknown[]              // top-level receipt logs
}

interface SubscriptionMessage {
  method?: string
  params?: {
    result?: FlashblockPayload
  }
}

interface RpcResponse {
  id?: number
  result?: string
  error?: { message: string }
}

// ── Implementation ────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 500
const SUBSCRIBE_TIMEOUT_MS = 5_000

const RECENT_TTL_MS = 15_000   // flashblocks to keep in lookback window
const MAX_RECENT   = 100       // hard cap on ring buffer size

type RecentFlashblock = {
  logs: unknown[]
  blockNumber: bigint
  flashblockIndex: number
  tMs: number
  expiry: number
}

export function createFlashblockOracle(wsUrl: string, deps?: { ws?: WsFactory }): FlashblockOracle {
  const createWs = deps?.ws ?? ((url: string) => new WebSocket(url) as unknown as FlashblocksWs)

  const pending = new Map<string, PendingWatch>()
  const recent: RecentFlashblock[] = []   // lookback ring buffer
  let socket: FlashblocksWs | null = null
  let subscriptionId: string | null = null
  let closed = false
  let reqId = 1

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  function connect() {
    if (closed) return
    socket = createWs(wsUrl)

    socket.onopen = () => subscribe()

    socket.onmessage = ({ data }) => {
      try {
        handleMessage(JSON.parse(data))
      } catch { /* ignore unparseable frames */ }
    }

    socket.onclose = () => {
      subscriptionId = null
      // Always reconnect while not explicitly closed — keeps the socket warm between runs
      if (!closed) {
        setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    socket.onerror = () => {
      // onclose fires after onerror; reconnect is handled there
    }
  }

  function subscribe() {
    if (!socket || closed) return
    const id = reqId++
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['newFlashblockTransactions', true] })
    )
  }

  function handleMessage(msg: SubscriptionMessage | RpcResponse) {
    // Subscription confirmation
    if ('result' in msg && typeof (msg as RpcResponse).result === 'string' && 'id' in msg) {
      subscriptionId = (msg as RpcResponse).result as string
      return
    }

    // Incoming flashblock notification — params.result is a merged tx+receipt object
    const sub = msg as SubscriptionMessage
    if (sub.method !== 'eth_subscription' || !sub.params?.result) return
    const payload = sub.params.result

    const blockNumberRaw = payload.blockNumber
    if (blockNumberRaw == null) return
    const blockNumber = BigInt(blockNumberRaw)
    const flashblockIndex = payload.transactionIndex != null ? Number(BigInt(payload.transactionIndex)) : 0
    const tMs = performance.now()

    const allLogs: unknown[] = Array.isArray(payload.logs) ? payload.logs : []

    // Store in lookback ring buffer so late-registered watches can find already-seen hashes
    if (allLogs.length > 0) {
      recent.push({ logs: allLogs, blockNumber, flashblockIndex, tMs, expiry: tMs + RECENT_TTL_MS })
      while (recent.length > MAX_RECENT) recent.shift()
    }

    // Check each pending watch
    for (const [userOpHash, watch] of pending) {
      if (performance.now() >= watch.deadline) {
        watch.resolve({ status: 'not-observed' })
        pending.delete(userOpHash)
        continue
      }

      const match = findUserOpInRawLogs(allLogs, userOpHash as `0x${string}`)
      if (match) {
        watch.resolve({ status: 'ok', blockNumber, flashblockIndex, tMs })
        pending.delete(userOpHash)
      }
    }
  }

  // ── Timeout sweeper ───────────────────────────────────────────────────────

  function sweepExpired() {
    const now = performance.now()
    for (const [hash, watch] of pending) {
      if (now >= watch.deadline) {
        watch.resolve({ status: 'not-observed' })
        pending.delete(hash)
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  // Eager connect — pre-warm so the socket is ready before the first watch
  connect()

  return {
    watch(userOpHash, timeoutMs) {
      return new Promise<FlashblockResult>(resolve => {
        const key = userOpHash.toLowerCase()
        const now = performance.now()

        // Check lookback buffer — handles the race where the flashblock arrived
        // before this watch was registered (submit latency > WS roundtrip)
        const expiredBefore = now - RECENT_TTL_MS
        for (const fb of recent) {
          if (fb.tMs < expiredBefore) continue
          const match = findUserOpInRawLogs(fb.logs, userOpHash as `0x${string}`)
          if (match) {
            resolve({ status: 'ok', blockNumber: fb.blockNumber, flashblockIndex: fb.flashblockIndex, tMs: fb.tMs })
            return
          }
        }

        pending.set(key, { resolve, deadline: now + timeoutMs })

        // Safety net in case the eager socket was closed/never opened
        if (!socket) connect()

        // Schedule expiry sweep
        setTimeout(() => {
          if (pending.has(key)) {
            pending.get(key)!.resolve({ status: 'not-observed' })
            pending.delete(key)
          }
        }, timeoutMs)
      })
    },

    close() {
      closed = true
      sweepExpired()
      for (const [, watch] of pending) watch.resolve({ status: 'not-observed' })
      pending.clear()
      socket?.close()
      socket = null
    },
  }
}
