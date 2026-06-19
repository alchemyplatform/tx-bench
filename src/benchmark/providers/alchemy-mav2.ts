import { generatePrivateKey } from 'viem/accounts'
import { createModularAccountV2Client } from '@account-kit/smart-contracts'
import { alchemy, base } from '@account-kit/infra'
import { LocalAccountSigner } from '@aa-sdk/core'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ClientFactory = typeof createModularAccountV2Client
type KeyGen = typeof generatePrivateKey

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyMAv2AccountClient implements AccountClient {
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

    // MAv2 encodeExecute short-circuits when target === accountAddress (passes
    // data through directly), so target: self + data: '0x' produces callData: '0x'
    // and AA23 reverts during validation. Use any non-self target instead.
    const { hash: userOpHash } = await client.sendUserOperation({
      uo: { target: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n },
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

export function createAlchemyMAv2Adapter(deps?: {
  createClient?: ClientFactory
  generateKey?: KeyGen
}): ProviderAdapter {
  const createClient = deps?.createClient ?? createModularAccountV2Client
  const genKey = deps?.generateKey ?? generatePrivateKey

  return {
    id: 'alchemy-modular-account-v2',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Modular Account v2',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.alchemy
      if (!cfg) {
        throw new Error('Alchemy provider not configured — set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID')
      }
      return new AlchemyMAv2AccountClient(cfg.apiKey, cfg.policyId, createClient, genKey)
    },
  }
}

export const alchemyMAv2Adapter: ProviderAdapter = createAlchemyMAv2Adapter()
