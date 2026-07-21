export type SerializedError = {
  message: string
  name?: string
  stack?: string
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name !== 'Error' ? err.name : undefined,
      stack: err.stack,
    }
  }
  return { message: String(err) }
}

// ── Private-key redaction ─────────────────────────────────────────────────────

const REDACTED_OWNER_KEY = '[REDACTED_OWNER_PRIVATE_KEY]'
const REDACTED_ALCHEMY_API_KEY = '[REDACTED_ALCHEMY_API_KEY]'
const REDACTED_ALCHEMY_URL = '[REDACTED_ALCHEMY_URL]'

/**
 * Remove occurrences of the configured owner private key from a string.
 * Redacts both the `0x`-prefixed form and the bare (no-`0x`) form so SDK/viem
 * error messages that embed the key either way are sanitized.
 *
 * Matching is case-insensitive: the zod schema allows mixed-case hex keys, and
 * SDKs/viem may normalize hex casing in error messages, so a key configured in
 * one case could appear in another case in an error. A case-sensitive match
 * would leak the key in that scenario.
 *
 * When `ownerPrivateKey` is undefined or empty, the input is returned unchanged.
 */
export function redactPrivateKey(text: string, ownerPrivateKey?: `0x${string}`): string {
  if (!ownerPrivateKey || ownerPrivateKey.length === 0) return text

  let result = text
  // Redact the full 0x-prefixed key (case-insensitive)
  const fullRe = new RegExp(escapeRegExp(ownerPrivateKey), 'gi')
  result = result.replace(fullRe, REDACTED_OWNER_KEY)
  // Redact the bare form (without 0x prefix) if the key is long enough to be
  // a real private key and not a false-positive substring match
  const bare = ownerPrivateKey.slice(2)
  if (bare.length >= 32) {
    const bareRe = new RegExp(escapeRegExp(bare), 'gi')
    result = result.replace(bareRe, REDACTED_OWNER_KEY)
  }
  return result
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Serialize an error and redact the configured owner private key from the
 * message and stack trace. Use this instead of `serializeError` in code paths
 * where the error may contain the private key (stable-owner bootstrap/timed).
 */
export function serializeErrorRedacted(
  err: unknown,
  ownerPrivateKey?: `0x${string}`,
  alchemyApiKeys: readonly string[] = [],
): SerializedError {
  const serialized = serializeError(err)
  const redact = (text: string): string => {
    let result = redactPrivateKey(text, ownerPrivateKey)
    for (const apiKey of alchemyApiKeys) {
      // Short fixture values such as "key" are too ambiguous to redact safely
      // and can corrupt unrelated words or redaction placeholders. Real Alchemy
      // API keys are substantially longer.
      if (apiKey.length < 8) continue
      const keyedUrl = new RegExp(`https?://[^\\s\"'<>]*${escapeRegExp(apiKey)}[^\\s\"'<>]*`, 'gi')
      result = result.replace(keyedUrl, REDACTED_ALCHEMY_URL)
      result = result.replace(new RegExp(escapeRegExp(apiKey), 'gi'), REDACTED_ALCHEMY_API_KEY)
    }
    return result
  }
  return {
    message: redact(serialized.message),
    ...(serialized.name ? { name: serialized.name } : {}),
    ...(serialized.stack ? { stack: redact(serialized.stack) } : {}),
  }
}
