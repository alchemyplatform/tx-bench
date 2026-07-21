export type PollingDependencies = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ObserverPollResult<T> =
  | { kind: 'value'; value: T; pollCount: number; observedAtMs: number }
  | { kind: 'timed-out'; pollCount: number }
  | { kind: 'error'; error: unknown; pollCount: number }

type PollObserverOptions<T> = PollingDependencies & {
  request: () => Promise<T>
  isPending: (value: T) => boolean
  timeoutMs: number
  isRetryableError?: (error: unknown) => boolean
}

const FAST_POLL_INTERVAL_MS = 250
const FAST_POLL_WINDOW_MS = 8_000
const MAX_POLL_INTERVAL_MS = 2_000

export async function pollObserver<T>(options: PollObserverOptions<T>): Promise<ObserverPollResult<T>> {
  const now = options.now ?? (() => performance.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const startedAt = now()
  let pollCount = 0
  let lastRetryableError: unknown

  while (true) {
    pollCount++
    try {
      const value = await options.request()
      lastRetryableError = undefined
      if (!options.isPending(value)) {
        const observedAtMs = now()
        if (observedAtMs - startedAt >= options.timeoutMs) {
          return { kind: 'timed-out', pollCount }
        }
        return { kind: 'value', value, pollCount, observedAtMs }
      }
    } catch (error) {
      if (!(options.isRetryableError?.(error) ?? false)) {
        return { kind: 'error', error, pollCount }
      }
      lastRetryableError = error
    }

    const elapsedMs = now() - startedAt
    if (elapsedMs >= options.timeoutMs) {
      return lastRetryableError === undefined
        ? { kind: 'timed-out', pollCount }
        : { kind: 'error', error: lastRetryableError, pollCount }
    }

    const delayMs = elapsedMs < FAST_POLL_WINDOW_MS
      ? FAST_POLL_INTERVAL_MS
      : Math.min(
          MAX_POLL_INTERVAL_MS,
          FAST_POLL_INTERVAL_MS * 2 ** (Math.floor((elapsedMs - FAST_POLL_WINDOW_MS) / 2_000) + 1),
        )
    await sleep(Math.min(delayMs, options.timeoutMs - elapsedMs))
  }
}

export function isRetryableObserverError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown }
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : undefined
  if (status != null) {
    return status === 408 || status === 429 || status >= 500
  }
  if (candidate.code === -32600 || candidate.code === -32601 || candidate.code === -32602) {
    return false
  }
  // Transport and upstream errors often do not expose an HTTP status.
  return true
}
