import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { base } from 'viem/chains'
import { alchemyTransport } from '@alchemy/common'
import { estimateFeesPerGas } from '@alchemy/aa-infra'
import { toModularAccountV2 } from '@alchemy/smart-accounts'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ToMAv2 = typeof toModularAccountV2
type KeyGen = typeof generatePrivateKey

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyMAv2BSOAccountClient implements AccountClient {
  constructor(
    private readonly apiKey: string,
    private readonly bsoPolicyId: string,
    private readonly toAccount: ToMAv2,
    private readonly genKey: KeyGen
  ) {}

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    const key = this.genKey()
    const owner = privateKeyToAccount(key)

    // Read transport (no BSO header — just API key auth for eth_call / getCode)
    const readTransport = alchemyTransport({ apiKey: this.apiKey })
    const publicClient = createPublicClient({ chain: base, transport: readTransport })

    const account = await this.toAccount({ client: publicClient, owner })

    // Bundler transport carries the BSO policy header so the bundler sponsors gas
    const bundlerTransport = alchemyTransport({
      apiKey: this.apiKey,
      fetchOptions: { headers: { 'x-alchemy-policy-id': this.bsoPolicyId } },
    })

    const bundlerClient = createBundlerClient({
      account,
      chain: base,
      transport: bundlerTransport,
      userOperation: { estimateFeesPerGas },
    })

    // Zero gas fields: BSO bundler fills them server-side.
    // Use a non-self target — MAv2 encodeCalls short-circuits when to === accountAddress
    // (passes data through directly), producing callData: '0x' and AA23 reverts.
    const userOpHash = await bundlerClient.sendUserOperation({
      calls: [{ to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n }],
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      preVerificationGas: 0n,
    })

    return {
      userOpHash,
      protocolClass: '4337-bundler',
      submitMs: performance.now() - tStart,
      accountAddress: account.address,
    }
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAlchemyMAv2BSOAdapter(deps?: {
  toAccount?: ToMAv2
  generateKey?: KeyGen
}): ProviderAdapter {
  const toAccount = deps?.toAccount ?? toModularAccountV2
  const genKey = deps?.generateKey ?? generatePrivateKey

  return {
    id: 'alchemy-mav2-bso',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Modular Account v2 (BSO)',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.alchemy
      if (!cfg) {
        throw new Error('Alchemy provider not configured — set ALCHEMY_API_KEY')
      }
      if (!cfg.bsoPolicyId) {
        throw new Error('BSO policy not configured — set ALCHEMY_BSO_POLICY_ID')
      }
      return new AlchemyMAv2BSOAccountClient(cfg.apiKey, cfg.bsoPolicyId, toAccount, genKey)
    },
  }
}

export const alchemyMAv2BSOAdapter: ProviderAdapter = createAlchemyMAv2BSOAdapter()
