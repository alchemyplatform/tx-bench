import { describe, expect, it } from 'bun:test'
import { pollObserver } from './polling'

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
})
