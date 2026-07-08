import type { Config } from '../config.js'
import type { ProtocolClass } from '../contracts.js'
import type { CanonicalResult } from '../oracle/canonical.js'

export type SponsoredResult = {
  userOpHash: `0x${string}`
  protocolClass: ProtocolClass
  submitMs: number
  accountAddress: `0x${string}`
  // Optional decomposition of submitMs into prepare + send stages.
  // When present, submitMs should equal prepareMs + sendMs (compatibility total).
  // Only the Wallet SendCalls adapter populates these (R8/R9).
  prepareMs?: number
  sendMs?: number
  // Set by wallet-sendcalls adapters which resolve canonical timing internally.
  // When present, service.ts skips the neutral canonicalOracle.watch() call.
  inlineCanonical?: CanonicalResult
  // Acceptance timestamp captured inside sendSponsored() (performance.now()).
  // Required when inlineCanonical is set so service.ts can compute canonical stage ms correctly.
  acceptedAtMs?: number
}

export interface AccountClient {
  sendSponsored(): Promise<SponsoredResult>
  // Optional: called once after buildAccountClient and before the timed loop to
  // ensure the account is deployed on-chain (e.g. stable-owner self-bootstrap).
  // When absent, the service skips it. Excluded from all metrics.
  // The service may pass an AbortSignal so a bootstrap timeout can wind down
  // background polling instead of orphaning the promise.
  ensureDeployed?(signal?: AbortSignal): Promise<void>
}

export interface ProviderAdapter {
  readonly id: string
  readonly protocolClass: ProtocolClass
  readonly accountTypeLabel: string
  buildAccountClient(config: Config): Promise<AccountClient>
}
