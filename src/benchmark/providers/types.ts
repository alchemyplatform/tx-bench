import type { Config } from '../config.js'
import type { ProtocolClass } from '../contracts.js'
import type { CanonicalResult } from '../oracle/canonical.js'

export type SponsoredResult = {
  userOpHash: `0x${string}`
  protocolClass: ProtocolClass
  submitMs: number
  accountAddress: `0x${string}`
  // Set by wallet-sendcalls adapters which resolve canonical timing internally.
  // When present, service.ts skips the neutral canonicalOracle.watch() call.
  inlineCanonical?: CanonicalResult
  // Acceptance timestamp captured inside sendSponsored() (performance.now()).
  // Required when inlineCanonical is set so service.ts can compute canonical stage ms correctly.
  acceptedAtMs?: number
}

export interface AccountClient {
  sendSponsored(): Promise<SponsoredResult>
}

export interface ProviderAdapter {
  readonly id: string
  readonly protocolClass: ProtocolClass
  readonly accountTypeLabel: string
  buildAccountClient(config: Config): Promise<AccountClient>
}
