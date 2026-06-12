import { describe, expect, it } from 'bun:test'
import { openBrowser } from './open-browser'

describe('openBrowser', () => {
  it('returns ok when the opener exits successfully', async () => {
    const result = await openBrowser('http://127.0.0.1:4173', async command => {
      expect(command.at(-1)).toBe('http://127.0.0.1:4173')
      return 0
    })

    expect(result).toEqual({ ok: true })
  })

  it('returns a non-fatal error when the opener exits non-zero', async () => {
    const result = await openBrowser('http://127.0.0.1:4173', async () => 1)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('exited with code 1')
  })

  it('returns a non-fatal error when spawning throws', async () => {
    const result = await openBrowser('http://127.0.0.1:4173', async () => {
      throw new Error('no opener')
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('no opener')
  })
})
