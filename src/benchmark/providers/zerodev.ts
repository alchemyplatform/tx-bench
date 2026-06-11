import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient } from '@zerodev/sdk'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'
import type { ProtocolClass } from '../contracts.js'

// Kernel v3 version to use (latest v3 release)
const KERNEL_VERSION = '0.3.3' as const

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ValidatorFn = typeof signerToEcdsaValidator
type AccountFn = typeof createKernelAccount
type ClientFn = typeof createKernelAccountClient
type PaymasterFn = typeof createZeroDevPaymasterClient
type KeyGen = typeof generatePrivateKey
type HttpFn = typeof http

// ── AccountClient impl ────────────────────────────────────────────────────────

class ZeroDevAccountClient implements AccountClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly publicRpcUrl: string,   // read-only RPC for eth_call
    private readonly protocolClass: ProtocolClass,
    private readonly createValidator: ValidatorFn,
    private readonly createAccount: AccountFn,
    private readonly createClient: ClientFn,
    private readonly createPaymaster: PaymasterFn,
    private readonly genKey: KeyGen,
    private readonly httpFn: HttpFn
  ) {}

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    const privateKey = this.genKey()
    const owner = privateKeyToAccount(privateKey)

    // Use ZeroDev's RPC for eth_call — it's a full node and avoids rate-limiting the public endpoint
    const publicClient = createPublicClient({ chain: base, transport: this.httpFn(this.publicRpcUrl) })

    const ecdsaValidator = await this.createValidator(publicClient, {
      signer: owner,
      entryPoint: { address: entryPoint07Address, version: '0.7' },
      kernelVersion: KERNEL_VERSION,
    })

    const kernelAccount = await this.createAccount(publicClient, {
      plugins: { sudo: ecdsaValidator },
      entryPoint: { address: entryPoint07Address, version: '0.7' },
      kernelVersion: KERNEL_VERSION,
    })

    const paymasterClient = this.createPaymaster({
      transport: this.httpFn(this.rpcUrl),
      chain: base,
    })

    const kernelClient = this.createClient({
      account: kernelAccount,
      chain: base,
      bundlerTransport: this.httpFn(this.rpcUrl),
      paymaster: paymasterClient,
    })

    const userOpHash = await kernelClient.sendUserOperation({
      calls: [{ to: owner.address, value: 0n, data: '0x' }],
    })

    return {
      userOpHash,
      protocolClass: this.protocolClass,
      submitMs: performance.now() - tStart,
      accountAddress: kernelAccount.address,
    }
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

// urlSuffix is appended to the config rpcUrl — used to toggle UltraRelay
// (?provider=ULTRA_RELAY) vs the standard Kernel bundler (empty suffix).
export function createZeroDevAdapter(
  protocolClass: ProtocolClass,
  urlSuffix: string,
  deps?: {
    createValidator?: ValidatorFn
    createAccount?: AccountFn
    createClient?: ClientFn
    createPaymaster?: PaymasterFn
    generateKey?: KeyGen
    httpFn?: HttpFn
  }
): ProviderAdapter {
  const createValidator = deps?.createValidator ?? signerToEcdsaValidator
  const createAccount = deps?.createAccount ?? createKernelAccount
  const createClient = deps?.createClient ?? createKernelAccountClient
  const createPaymaster = deps?.createPaymaster ?? createZeroDevPaymasterClient
  const genKey = deps?.generateKey ?? generatePrivateKey
  const httpFn = deps?.httpFn ?? http

  const id = protocolClass === 'intent-relay' ? 'zerodev-ultrarelay' : 'zerodev-kernel'

  return {
    id,
    protocolClass,
    accountTypeLabel: 'Kernel v3',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.zerodev
      if (!cfg) {
        throw new Error('ZeroDev provider not configured — set ZERODEV_API_KEY and ZERODEV_PROJECT_ID')
      }
      const rpcUrl = cfg.rpcUrl + urlSuffix
      // ZeroDev's RPC is a full node — use it for reads to avoid rate-limiting the public endpoint
      return new ZeroDevAccountClient(
        rpcUrl,
        cfg.rpcUrl,
        protocolClass,
        createValidator,
        createAccount,
        createClient,
        createPaymaster,
        genKey,
        httpFn
      )
    },
  }
}

export const zerodevKernelAdapter: ProviderAdapter = createZeroDevAdapter('4337-bundler', '')
export const zerodevUltraRelayAdapter: ProviderAdapter = createZeroDevAdapter(
  'intent-relay',
  '?provider=ULTRA_RELAY'
)
