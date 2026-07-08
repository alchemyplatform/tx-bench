import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import type { Chain } from 'viem'
import { alchemyTransport } from '@alchemy/common'
import { estimateFeesPerGas } from '@alchemy/aa-infra'
import { toModularAccountV2 } from '@alchemy/smart-accounts'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'
import { resolveChain } from '../chains.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ToMAv2 = typeof toModularAccountV2
type KeyGen = typeof generatePrivateKey
type ChainResolver = (network: string) => Chain
type GetCodeFn = (address: `0x${string}`) => Promise<string | undefined>
type SendDeployOpFn = (account: unknown) => Promise<void>

// ── Bootstrap polling config ──────────────────────────────────────────────────

const BOOTSTRAP_POLL_INTERVAL_MS = 2_000
const BOOTSTRAP_POLL_TIMEOUT_MS = 30_000

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyMAv2BSOAccountClient implements AccountClient {
  // Only set when a stable owner key is configured; undefined in random mode.
  private readonly stableOwner: ReturnType<typeof privateKeyToAccount> | undefined
  // ensureDeployed is only attached when stableOwner is set (see constructor).
  readonly ensureDeployed?: () => Promise<void>

  constructor(
    private readonly apiKey: string,
    private readonly bsoPolicyId: string,
    private readonly network: string,
    private readonly toAccount: ToMAv2,
    private readonly genKey: KeyGen,
    private readonly chainResolver: ChainResolver = resolveChain,
    ownerPrivateKey?: `0x${string}`,
    private readonly getCodeFn?: GetCodeFn,
    private readonly sendDeployOpFn?: SendDeployOpFn,
  ) {
    if (ownerPrivateKey) {
      this.stableOwner = privateKeyToAccount(ownerPrivateKey)
      // Attach ensureDeployed only when a stable key is set, so the service's
      // `typeof client.ensureDeployed !== 'function'` check skips it in random mode.
      this.ensureDeployed = this._ensureDeployed.bind(this)
    }
  }

  // ── Stable-owner self-bootstrap ─────────────────────────────────────────────

  private async _ensureDeployed(signal?: AbortSignal): Promise<void> {
    if (!this.stableOwner) return

    const chain = this.chainResolver(this.network)
    const readTransport = alchemyTransport({ apiKey: this.apiKey })
    const publicClient = createPublicClient({ chain, transport: readTransport })

    // Compute the deterministic account address without sending.
    const account = await this.toAccount({ client: publicClient, owner: this.stableOwner })
    const accountAddress = account.address

    // Resolve the getCode function (injected for tests, real for production).
    const getCode = this.getCodeFn ?? ((addr: `0x${string}`) => publicClient.getCode({ address: addr }))

    // Check if already deployed.
    const existingCode = await getCode(accountAddress)
    if (existingCode && existingCode !== '0x') return

    // Not deployed — send one untimed deployment userOp.
    const sendDeploy = this.sendDeployOpFn ?? ((acct: unknown) => this._sendDeployUserOp(acct))
    await sendDeploy(account)

    // Poll until deployment is observable, with a bounded timeout.
    const deadline = Date.now() + BOOTSTRAP_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Bootstrap aborted')
      await sleep(BOOTSTRAP_POLL_INTERVAL_MS)
      // Tolerate transient getCode RPC errors during polling (rate limits,
      // temporary 5xx, network blips) — only the deadline aborts the bootstrap.
      try {
        const code = await getCode(accountAddress)
        if (code && code !== '0x') return
      } catch {
        // transient RPC error — keep polling until the deadline
      }
    }

    throw new Error(
      `Bootstrap timeout: MAv2 account ${accountAddress} not deployed within ${BOOTSTRAP_POLL_TIMEOUT_MS / 1000}s`,
    )
  }

  private async _sendDeployUserOp(account: unknown): Promise<void> {
    const chain = this.chainResolver(this.network)
    const bundlerTransport = alchemyTransport({
      apiKey: this.apiKey,
      fetchOptions: { headers: { 'x-alchemy-policy-id': this.bsoPolicyId } },
    })
    const bundlerClient = createBundlerClient({
      account: account as NonNullable<Parameters<typeof createBundlerClient>[0]['account']>,
      chain,
      transport: bundlerTransport,
      userOperation: { estimateFeesPerGas },
    })
    await bundlerClient.sendUserOperation({
      calls: [{ to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n }],
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      preVerificationGas: 0n,
    })
  }

  // ── Timed send ─────────────────────────────────────────────────────────────

  async sendSponsored(): Promise<SponsoredResult> {
    const tStart = performance.now()

    // Use the stable owner when configured; fall back to per-call random key.
    const owner = this.stableOwner ?? privateKeyToAccount(this.genKey())

    const chain = this.chainResolver(this.network)

    // Read transport (no BSO header — just API key auth for eth_call / getCode)
    const readTransport = alchemyTransport({ apiKey: this.apiKey })
    const publicClient = createPublicClient({ chain, transport: readTransport })

    const account = await this.toAccount({ client: publicClient, owner })

    // Bundler transport carries the BSO policy header so the bundler sponsors gas
    const bundlerTransport = alchemyTransport({
      apiKey: this.apiKey,
      fetchOptions: { headers: { 'x-alchemy-policy-id': this.bsoPolicyId } },
    })

    const bundlerClient = createBundlerClient({
      account,
      chain,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAlchemyMAv2BSOAdapter(deps?: {
  toAccount?: ToMAv2
  generateKey?: KeyGen
  chainResolver?: ChainResolver
  getCodeFn?: GetCodeFn
  sendDeployOpFn?: SendDeployOpFn
}): ProviderAdapter {
  const toAccount = deps?.toAccount ?? toModularAccountV2
  const genKey = deps?.generateKey ?? generatePrivateKey
  const chainResolver = deps?.chainResolver ?? resolveChain
  const getCodeFn = deps?.getCodeFn
  const sendDeployOpFn = deps?.sendDeployOpFn

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
      return new AlchemyMAv2BSOAccountClient(
        cfg.apiKey, cfg.bsoPolicyId, config.network, toAccount, genKey, chainResolver,
        config.ownerPrivateKey, getCodeFn, sendDeployOpFn,
      )
    },
  }
}

export const alchemyMAv2BSOAdapter: ProviderAdapter = createAlchemyMAv2BSOAdapter()
