import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createSmartWalletClient, alchemyWalletTransport } from '@alchemy/wallet-apis'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'
import type { CanonicalResult } from '../oracle/canonical.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ClientFactory = typeof createSmartWalletClient
type KeyGen = typeof generatePrivateKey

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyWalletSendCallsAccountClient implements AccountClient {
  constructor(
    private readonly apiKey: string,
    private readonly policyId: string,
    private readonly canonicalTimeoutMs: number,
    private readonly createClient: ClientFactory,
    private readonly genKey: KeyGen
  ) {}

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    const key = this.genKey()
    const signer = privateKeyToAccount(key)

    // createSmartWalletClient is synchronous; 7702 delegation + gas estimation
    // happen server-side inside sendCalls, so prepareMs reflects only client init.
    const client = this.createClient({
      signer,
      transport: alchemyWalletTransport({ apiKey: this.apiKey }),
      chain: base,
      paymaster: { policyId: this.policyId },
    })

    const tPrepared = performance.now()

    // Calling to: signer.address (the EIP-7702 smart wallet itself) with empty
    // data invokes the wallet's fallback and fails validation. Use a non-self target.
    const { id: callId } = await client.sendCalls({
      calls: [{ to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n }],
    })
    const tAccepted = performance.now()

    // waitForCallsStatus polls until the tx is mined — canonical timing resolves here
    const status = await client.waitForCallsStatus({
      id: callId,
      timeout: this.canonicalTimeoutMs,
    })
    const tCanonical = performance.now()

    const receipt = status.receipts?.[0]
    let inlineCanonical: CanonicalResult
    if (status.status === 'success' && receipt) {
      inlineCanonical = {
        status: 'ok',
        blockNumber: receipt.blockNumber,
        txHash: receipt.transactionHash,
        tMs: tCanonical,
      }
    } else if (status.status === 'failure') {
      inlineCanonical = {
        status: 'integrity-fail',
        blockNumber: receipt?.blockNumber ?? 0n,
        reason: 'wallet_sendCalls bundle failed',
      }
    } else {
      inlineCanonical = { status: 'timed-out' }
    }

    return {
      userOpHash: callId as `0x${string}`,
      protocolClass: 'wallet-sendcalls',
      prepareMs: tPrepared - tStart,
      submitMs: tAccepted - tPrepared,
      acceptedAtMs: tAccepted,
      accountAddress: signer.address,
      inlineCanonical,
    }
  }
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAlchemyWalletSendCallsAdapter(deps?: {
  createClient?: ClientFactory
  generateKey?: KeyGen
}): ProviderAdapter {
  const createClient = deps?.createClient ?? createSmartWalletClient
  const genKey = deps?.generateKey ?? generatePrivateKey

  return {
    id: 'alchemy-wallet-sendcalls',
    protocolClass: 'wallet-sendcalls',
    accountTypeLabel: 'Smart Wallet (EIP-7702)',

    async buildAccountClient(config: Config): Promise<AccountClient> {
      const cfg = config.providers.alchemy
      if (!cfg) {
        throw new Error('Alchemy provider not configured — set ALCHEMY_API_KEY and ALCHEMY_POLICY_ID')
      }
      return new AlchemyWalletSendCallsAccountClient(
        cfg.apiKey,
        cfg.policyId,
        config.timeouts.canonicalMs,
        createClient,
        genKey,
      )
    },
  }
}

export const alchemyWalletSendCallsAdapter: ProviderAdapter = createAlchemyWalletSendCallsAdapter()
