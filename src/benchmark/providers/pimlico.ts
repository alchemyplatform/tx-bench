import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { createBundlerClient, entryPoint07Address } from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { toSafeSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type SafeAccountFn = typeof toSafeSmartAccount
type PimlicoClientFn = typeof createPimlicoClient
type KeyGen = typeof generatePrivateKey

// ── AccountClient impl ────────────────────────────────────────────────────────

class PimlicoAccountClient implements AccountClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly publicRpcUrl: string,   // read-only RPC for eth_call — Pimlico URL is bundler-only
    private readonly sponsorshipPolicyId: string,
    private readonly createSafeAccount: SafeAccountFn,
    private readonly createPimlico: PimlicoClientFn,
    private readonly genKey: KeyGen
  ) {}

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    const privateKey = this.genKey()
    const owner = privateKeyToAccount(privateKey)

    // Use read RPC for eth_call — Pimlico bundler URL does not support it
    const publicClient = createPublicClient({ chain: base, transport: http(this.publicRpcUrl) })

    const safeAccount = await this.createSafeAccount({
      client: publicClient,
      owners: [owner],
      version: '1.4.1',
      entryPoint: { address: entryPoint07Address, version: '0.7' },
    })

    const pimlicoClient = this.createPimlico({
      transport: http(this.rpcUrl),
      chain: base,
      entryPoint: { address: entryPoint07Address, version: '0.7' },
    })

    const bundlerClient = createBundlerClient({
      account: safeAccount,
      chain: base,
      transport: http(this.rpcUrl),
      paymaster: pimlicoClient,
      paymasterContext: { sponsorshipPolicyId: this.sponsorshipPolicyId },
      // Pimlico's pm_getPaymasterStubData requires fee fields to be pre-populated
      userOperation: {
        estimateFeesPerGas: async () => {
          const { fast } = await pimlicoClient.getUserOperationGasPrice()
          return fast
        },
      },
    })

    const userOpHash = await bundlerClient.sendUserOperation({
      calls: [{ to: owner.address, value: 0n, data: '0x' }],
    })

    return {
      userOpHash,
      protocolClass: '4337-bundler',
      submitMs: performance.now() - tStart,
      accountAddress: safeAccount.address,
    }
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createPimlicoAdapter(deps?: {
  createSafeAccount?: SafeAccountFn
  createPimlicoClient?: PimlicoClientFn
  generateKey?: KeyGen
}): ProviderAdapter {
  const createSafeAccount = deps?.createSafeAccount ?? toSafeSmartAccount
  const createPimlico = deps?.createPimlicoClient ?? createPimlicoClient
  const genKey = deps?.generateKey ?? generatePrivateKey

  return {
    id: 'pimlico-safe',
    protocolClass: '4337-bundler',
    accountTypeLabel: 'Safe',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.pimlico
      if (!cfg) {
        throw new Error('Pimlico provider not configured — set PIMLICO_API_KEY and PIMLICO_POLICY_ID')
      }
      // Prefer Alchemy for reads: it has higher rate limits and Pimlico's bundler URL
      // doesn't support eth_call. Falls back to neutral if Alchemy isn't configured.
      const readRpcUrl = config.providers.alchemy?.rpcUrl ?? config.neutral.rpcUrl
      return new PimlicoAccountClient(
        cfg.rpcUrl,
        readRpcUrl,
        cfg.policyId,
        createSafeAccount,
        createPimlico,
        genKey
      )
    },
  }
}

export const pimlicoAdapter: ProviderAdapter = createPimlicoAdapter()
