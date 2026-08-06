import type { Config } from '../config.js'
import type { ProtocolClass } from '../contracts.js'
import type { CanonicalObserver } from '../oracle/canonical.js'

export type SponsoredResult = {
  userOpHash: `0x${string}`
  // Provider-specific identifier used by an adapter-owned status observer.
  // Wallet API writes expose a call ID here while userOpHash retains the
  // underlying UserOperation hash required by chain and Flashblock observers.
  canonicalIdentifier?: `0x${string}`
  protocolClass: ProtocolClass
  submitMs: number
  accountAddress: `0x${string}`
  // Optional decomposition of submitMs into prepare + send stages.
  // When present, submitMs should equal prepareMs + sendMs (compatibility total).
  // Only the Wallet SendCalls adapter populates these (R8/R9).
  prepareMs?: number
  sendMs?: number
  // Acceptance timestamp captured inside sendSponsored() (performance.now()).
  acceptedAtMs?: number
}

export interface AccountClient {
  sendSponsored(): Promise<SponsoredResult>
  // Adapter-owned observers preserve provider-specific canonical semantics and
  // keep downstream observation outside the timed submission operation.
  readonly canonicalObserver?: CanonicalObserver
  // Optional provider-native observer for the earliest inclusion state the write
  // API exposes (for example Wallet status 110). Base monitoring prefers this over
  // the raw Flashblock stream for the `canonical` stage when present.
  //
  // This is NOT a preconfirmation signal: for Wallet SendCalls it resolves at
  // block level, ~0.7-1.4s behind actual Flashblock inclusion. Flashblock-speed
  // preconfirmation comes only from the neutral oracle feeding the `preconf` stage,
  // which is why cross-modality comparisons must use `preconf` and not `canonical`.
  readonly earlyInclusionObserver?: CanonicalObserver
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
