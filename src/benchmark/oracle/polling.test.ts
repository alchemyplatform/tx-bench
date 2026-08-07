import { describe, expect, it } from 'bun:test'
import { isRetryableObserverError, pollObserver } from './polling'

describe('pollObserver — shared cadence', () => {
  it('polls every 250ms through 8s and caps later backoff at 2s', async () => {
    let now = 0
    const sleeps: Array<{ at: number; delay: number }> = []

    const result = await pollObserver({
      request: async () => null,
      isPending: value => value === null,
      timeoutMs: 15_000,
      now: () => now,
      sleep: async (delay) => {
        sleeps.push({ at: now, delay })
        now += delay
      },
    })

    expect(result.kind).toBe('timed-out')
    expect(sleeps.filter(entry => entry.at < 8_000).every(entry => entry.delay === 250)).toBe(true)
    expect(Math.max(...sleeps.map(entry => entry.delay))).toBe(2_000)
    expect(sleeps.some(entry => entry.at >= 8_000 && entry.delay > 250)).toBe(true)
  })

  it('rejects a terminal response that arrives after the deadline', async () => {
    let now = 0

    const result = await pollObserver({
      request: async () => {
        now = 501
        return { status: 200 }
      },
      isPending: value => value.status === 100,
      timeoutMs: 500,
      now: () => now,
      sleep: async () => {},
    })

    expect(result).toEqual({ kind: 'timed-out', pollCount: 1 })
  })
})

describe('isRetryableObserverError — fallback narrowing', () => {
  it('retries transport-style errors that carry an HTTP 5xx status', () => {
    expect(isRetryableObserverError(Object.assign(new Error('boom'), { status: 503 }))).toBe(true)
  })

  it('retries status-less object errors that are not programming errors', () => {
    expect(isRetryableObserverError(new Error('upstream connection reset'))).toBe(true)
  })

  it('does not retry a TypeError (serialization / data bug)', () => {
    expect(isRetryableObserverError(new TypeError('Cannot read properties of undefined'))).toBe(false)
  })

  it('does not retry a SyntaxError (parse bug)', () => {
    expect(isRetryableObserverError(new SyntaxError('Unexpected token'))).toBe(false)
  })

  it('does not retry a RangeError (conversion bug)', () => {
    expect(isRetryableObserverError(new RangeError('value out of range'))).toBe(false)
  })

  it('does not retry JSON-RPC invalid request/params/method errors', () => {
    expect(isRetryableObserverError({ code: -32602 })).toBe(false)
  })

  it('does not retry non-object errors', () => {
    expect(isRetryableObserverError('string error')).toBe(false)
    expect(isRetryableObserverError(null)).toBe(false)
  })
})

describe('pollObserver — onPoll', () => {
  it('reports every polled value with the same timestamp the result uses', async () => {
    let clock = 0
    const values = [{ n: 1 }, { n: 2 }, { n: 3 }]
    const seen: Array<{ n: number; atMs: number; pollCount: number }> = []

    const result = await pollObserver({
      request: async () => { clock += 10; return values.shift()! },
      isPending: v => v.n < 3,
      onPoll: (v, atMs, pollCount) => { seen.push({ n: v.n, atMs, pollCount }) },
      timeoutMs: 10_000,
      now: () => clock,
      sleep: async () => { clock += 250 },
    })

    expect(seen.map(s => s.n)).toEqual([1, 2, 3])
    expect(seen.map(s => s.pollCount)).toEqual([1, 2, 3])
    // The terminal poll's onPoll timestamp is the very one reported as
    // observedAtMs — an intermediate signal is on the same clock as the result.
    expect(result.kind).toBe('value')
    if (result.kind !== 'value') throw new Error('expected a value')
    expect(seen[2]!.atMs).toBe(result.observedAtMs)
  })

  it('is optional — polling works without it', async () => {
    const result = await pollObserver({
      request: async () => ({ done: true }),
      isPending: () => false,
      timeoutMs: 1_000,
      now: () => 0,
    })
    expect(result.kind).toBe('value')
  })
})
