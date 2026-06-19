import { generatePrivateKey } from 'viem/accounts'
import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ClientFactory = typeof createLightAccountAlchemyClient
type KeyGen = typeof generatePrivateKey

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyAccountClient implements AccountClient {
  constructor(
    private readonly apiKey: string,
    private readonly policyId: string,
    private readonly createClient: ClientFactory,
    private readonly genKey: KeyGen
  ) {}

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    const privateKey = this.genKey()
    const signer = LocalAccountSigner.privateKeyToAccountSigner(privateKey)

    const client = await this.createClient({
      transport: alchemy({ apiKey: this.apiKey }),
      chain: base,
      signer,
      policyId: this.policyId,
    })

    const tPrepared = performance.now()

    const { hash: userOpHash } = await client.sendUserOperation({
      uo: { target: client.account.address, data: '0x', value: 0n },
    })

    return {
      userOpHash,
      protocolClass: '4337-bundler',
      submitMs: performance.now() - tPrepared,
      accountAddress: client.account.address,
    }
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAlchemyAdapter(deps?: {
  createClient?: ClientFactory
  generateKey?: KeyGen
}): ProviderAdapter {
  const createClient = deps?.createClient ?? createLightAccountAlchemyClient
  const genKey = deps?.generateKey ?? generatePrivateKey

  return {
    id: 'alchemy-light-account',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Light Account v2',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.alchemy
      if (!cfg) {
        throw new Error('Alchemy provider not configured — set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID')
      }
      return new AlchemyAccountClient(cfg.apiKey, cfg.policyId, createClient, genKey)
    },
  }
}

export const alchemyAdapter: ProviderAdapter = createAlchemyAdapter()
