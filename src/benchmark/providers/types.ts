import type { Config } from '../config.js'
import type { ProtocolClass } from '../contracts.js'

export type SponsoredResult = {
  userOpHash: `0x${string}`
  protocolClass: ProtocolClass
  submitMs: number
  accountAddress: `0x${string}`
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
