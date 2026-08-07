import type { Config } from '../config.js'
import type { ProtocolClass } from '../contracts.js'
import type { CanonicalObserver, CanonicalObserverApi, CanonicalResult } from '../oracle/canonical.js'

// Both stages of one status stream, observed by a single poll loop.
//
// They must come from one loop, not two: `firstStatus` and `ttm` differ
// only when the provider emits an early terminal signal (Wallet status 110). In
// every other attempt they describe the SAME response, and two independent
// pollers would disagree about it by up to one poll interval — sometimes
// reporting `firstStatus` as later than `ttm`.
export type StatusStages = {
  // First terminal status the API reported, whatever it was.
  firstStatus: CanonicalResult
  // Confirmed inclusion — status 200 only.
  ttm: CanonicalResult
}

export type StatusStagesObserver = {
  readonly api: CanonicalObserverApi
  watch(identifier: `0x${string}`, timeoutMs: number): Promise<StatusStages>
}

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
  // Adapter-owned observers preserve provider-specific canonical-inclusion
  // semantics and keep downstream observation outside the timed submission.
  // This one produces the `ttm` stage.
  readonly canonicalObserver?: CanonicalObserver
  // Optional. When a provider's status API reports an early terminal signal
  // before confirmation (Wallet status 110), this observer measures both stages
  // in one poll stream. When present the service uses it instead of
  // canonicalObserver, and records the `firstStatus` stage.
  //
  // Neither stage is a preconfirmation signal: for Wallet SendCalls even 110
  // resolves at block level, ~0.7-1.4s behind actual Flashblock inclusion.
  // Flashblock-speed preconfirmation comes only from the neutral oracle feeding
  // the `preconf` stage.
  readonly statusStagesObserver?: StatusStagesObserver
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
