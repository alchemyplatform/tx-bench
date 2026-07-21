import { describe, expect, it } from 'bun:test'
import { serializeError, serializeErrorRedacted, redactPrivateKey } from './serialize'

// ── Test key ──────────────────────────────────────────────────────────────────

const OWNER_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const BARE_KEY = OWNER_KEY.slice(2) // without 0x prefix

// ── redactPrivateKey ──────────────────────────────────────────────────────────

describe('redactPrivateKey', () => {
  it('redacts the 0x-prefixed key from a string', () => {
    const input = `Error signing with key ${OWNER_KEY}`
    const result = redactPrivateKey(input, OWNER_KEY)
    expect(result).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(result).not.toContain(OWNER_KEY)
  })

  it('redacts the bare (non-0x) key form from a string', () => {
    const input = `InvalidPrivateKeyError: key=${BARE_KEY} is not valid`
    const result = redactPrivateKey(input, OWNER_KEY)
    expect(result).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(result).not.toContain(BARE_KEY)
    expect(result).not.toContain(OWNER_KEY)
  })

  it('redacts multiple occurrences in the same string', () => {
    const input = `key1=${OWNER_KEY} key2=${OWNER_KEY} bare=${BARE_KEY}`
    const result = redactPrivateKey(input, OWNER_KEY)
    expect(result).not.toContain(OWNER_KEY)
    expect(result).not.toContain(BARE_KEY)
    expect(result.match(/\[REDACTED_OWNER_PRIVATE_KEY\]/g)?.length).toBe(3)
  })

  it('returns the input unchanged when ownerPrivateKey is undefined', () => {
    const input = `some error message with no key`
    expect(redactPrivateKey(input, undefined)).toBe(input)
  })

  it('returns the input unchanged when ownerPrivateKey is empty', () => {
    // Empty string is not a valid 0x${string} but we test defensively
    const input = `some error message`
    expect(redactPrivateKey(input, '' as `0x${string}`)).toBe(input)
  })

  it('returns the input unchanged when the key is not present', () => {
    const input = `bundler rejected: gas limit too low`
    const result = redactPrivateKey(input, OWNER_KEY)
    expect(result).toBe(input)
  })

  it('redacts case-insensitively (mixed-case key vs lowercased error text)', () => {
    const mixedKey = ('0x' + 'AB'.repeat(32)) as `0x${string}`
    const input = `invalid key 0x${'ab'.repeat(32)} rejected`
    const result = redactPrivateKey(input, mixedKey)
    expect(result).not.toContain('ab'.repeat(32))
    expect(result).not.toContain('AB'.repeat(32))
    expect(result).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
  })
})

// ── serializeErrorRedacted ────────────────────────────────────────────────────

describe('serializeErrorRedacted', () => {
  it('redacts the key from an Error message', () => {
    const err = new Error(`signing failed with key ${OWNER_KEY}`)
    const result = serializeErrorRedacted(err, OWNER_KEY)
    expect(result.message).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(result.message).not.toContain(OWNER_KEY)
  })

  it('redacts the key from an Error stack trace', () => {
    const err = new Error(`bad key ${OWNER_KEY}`)
    const result = serializeErrorRedacted(err, OWNER_KEY)
    expect(result.stack).toBeDefined()
    if (result.stack) {
      expect(result.stack).not.toContain(OWNER_KEY)
      expect(result.stack).not.toContain(BARE_KEY)
    }
  })

  it('redacts the key from a non-Error (string) thrown value', () => {
    const result = serializeErrorRedacted(`key=${OWNER_KEY}`, OWNER_KEY)
    expect(result.message).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(result.message).not.toContain(OWNER_KEY)
  })

  it('redacts the bare key form from a non-Error thrown value', () => {
    const result = serializeErrorRedacted(`bare=${BARE_KEY}`, OWNER_KEY)
    expect(result.message).toContain('[REDACTED_OWNER_PRIVATE_KEY]')
    expect(result.message).not.toContain(BARE_KEY)
  })

  it('preserves the error name', () => {
    const err = new Error(`key ${OWNER_KEY}`)
    err.name = 'InvalidPrivateKeyError'
    const result = serializeErrorRedacted(err, OWNER_KEY)
    expect(result.name).toBe('InvalidPrivateKeyError')
  })

  it('returns unchanged when ownerPrivateKey is undefined', () => {
    const err = new Error('some error without a key')
    const result = serializeErrorRedacted(err, undefined)
    expect(result.message).toBe('some error without a key')
    expect(result.message).not.toContain('[REDACTED')
  })

  it('returns unchanged when the error does not contain the key', () => {
    const err = new Error('bundler rejected: gas limit too low')
    const result = serializeErrorRedacted(err, OWNER_KEY)
    expect(result.message).toBe('bundler rejected: gas limit too low')
  })
})

describe('serializeErrorRedacted — Alchemy credentials', () => {
  it('redacts the API key and the full keyed endpoint URL', () => {
    const apiKey = 'alchemy-secret-api-key'
    const url = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`
    const serialized = serializeErrorRedacted(
      new Error(`request to ${url} rejected with key ${apiKey}`),
      undefined,
      [apiKey],
    )

    expect(serialized.message).toContain('[REDACTED_ALCHEMY_URL]')
    expect(serialized.message).toContain('[REDACTED_ALCHEMY_API_KEY]')
    expect(serialized.message).not.toContain(url)
    expect(serialized.message).not.toContain(apiKey)
  })
})

// ── serializeError (regression — no redaction) ────────────────────────────────

describe('serializeError (unredacted, regression)', () => {
  it('preserves the original message without redaction', () => {
    const err = new Error(`key ${OWNER_KEY}`)
    const result = serializeError(err)
    // The unredacted version should still contain the key
    expect(result.message).toContain(OWNER_KEY)
  })
})
