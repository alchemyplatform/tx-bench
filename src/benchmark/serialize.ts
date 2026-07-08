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

/**
 * Remove exact occurrences of the configured owner private key from a string.
 * Redacts both the `0x`-prefixed form and the bare (no-`0x`) form so SDK/viem
 * error messages that embed the key either way are sanitized.
 *
 * When `ownerPrivateKey` is undefined or empty, the input is returned unchanged.
 */
export function redactPrivateKey(text: string, ownerPrivateKey?: `0x${string}`): string {
  if (!ownerPrivateKey || ownerPrivateKey.length === 0) return text

  let result = text
  // Redact the full 0x-prefixed key
  result = result.split(ownerPrivateKey).join(REDACTED_OWNER_KEY)
  // Redact the bare form (without 0x prefix) if the key is long enough to be
  // a real private key and not a false-positive substring match
  const bare = ownerPrivateKey.slice(2)
  if (bare.length >= 32) {
    result = result.split(bare).join(REDACTED_OWNER_KEY)
  }
  return result
}

/**
 * Serialize an error and redact the configured owner private key from the
 * message and stack trace. Use this instead of `serializeError` in code paths
 * where the error may contain the private key (stable-owner bootstrap/timed).
 */
export function serializeErrorRedacted(err: unknown, ownerPrivateKey?: `0x${string}`): SerializedError {
  const serialized = serializeError(err)
  return {
    message: redactPrivateKey(serialized.message, ownerPrivateKey),
    ...(serialized.name ? { name: serialized.name } : {}),
    ...(serialized.stack ? { stack: redactPrivateKey(serialized.stack, ownerPrivateKey) } : {}),
  }
}
