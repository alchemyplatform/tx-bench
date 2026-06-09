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
