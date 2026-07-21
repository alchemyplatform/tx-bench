import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient } from 'viem'
import type { Chain } from 'viem'
import { alchemyTransport } from '@alchemy/common'
import { createSmartWalletClient, alchemyWalletTransport } from '@alchemy/wallet-apis'
import type { Config } from '../config.js'
import type { AccountClient, ProviderAdapter, SponsoredResult } from './types.js'
import type { CanonicalObserver, CanonicalResult } from '../oracle/canonical.js'
import { isRetryableObserverError, pollObserver } from '../oracle/polling.js'
import { serializeErrorRedacted } from '../serialize.js'
import { resolveChain } from '../chains.js'

// ── Dependency types (injectable for testing) ─────────────────────────────────

type ClientFactory = typeof createSmartWalletClient
type KeyGen = typeof generatePrivateKey
type ChainResolver = (network: string) => Chain
type GetCodeFn = (address: `0x${string}`) => Promise<string | undefined>
type SendSetupOpFn = (signer: ReturnType<typeof privateKeyToAccount>) => Promise<void>
type ObserverNow = () => number
type ObserverSleep = (ms: number) => Promise<void>

type WalletCallsStatusResponse = {
  status: number
  receipts?: Array<{
    blockNumber?: bigint | string | null
    transactionHash?: `0x${string}` | null
    [key: string]: unknown
  }>
  [key: string]: unknown
}

type StatusRequest = (request: {
  method: 'wallet_getCallsStatus'
  params: readonly [`0x${string}`]
}) => Promise<WalletCallsStatusResponse>

// ── Bootstrap polling config ──────────────────────────────────────────────────

const BOOTSTRAP_POLL_INTERVAL_MS = 2_000
const BOOTSTRAP_POLL_TIMEOUT_MS = 30_000

// ── AccountClient impl ────────────────────────────────────────────────────────

class AlchemyWalletSendCallsAccountClient implements AccountClient {
  // Only set when a stable owner key is configured; undefined in random mode.
  private readonly stableOwner: ReturnType<typeof privateKeyToAccount> | undefined
  // ensureDeployed is only attached when stableOwner is set (see constructor).
  readonly ensureDeployed?: () => Promise<void>
  readonly canonicalObserver: CanonicalObserver

  constructor(
    private readonly apiKey: string,
    private readonly policyId: string,
    private readonly canonicalTimeoutMs: number,
    private readonly network: string,
    private readonly createClient: ClientFactory,
    private readonly genKey: KeyGen,
    private readonly chainResolver: ChainResolver = resolveChain,
    ownerPrivateKey?: `0x${string}`,
    private readonly getCodeFn?: GetCodeFn,
    private readonly sendSetupOpFn?: SendSetupOpFn,
    private readonly injectedStatusRequest?: StatusRequest,
    private readonly observerNow?: ObserverNow,
    private readonly observerSleep?: ObserverSleep,
  ) {
    if (ownerPrivateKey) {
      this.stableOwner = privateKeyToAccount(ownerPrivateKey)
      // Attach ensureDeployed only when a stable key is set, so the service's
      // `typeof client.ensureDeployed !== 'function'` check skips it in random mode.
      this.ensureDeployed = this._ensureDeployed.bind(this)
    }
    this.canonicalObserver = {
      api: 'wallet_getCallsStatus',
      watch: (identifier, timeoutMs) => this._watchCanonical(identifier, timeoutMs, ownerPrivateKey),
    }
  }

  private async _watchCanonical(
    callId: `0x${string}`,
    timeoutMs: number,
    ownerPrivateKey?: `0x${string}`,
  ): Promise<CanonicalResult> {
    const request = this.injectedStatusRequest ?? this._createStatusRequest()
    const polled = await pollObserver({
      request: () => request({ method: 'wallet_getCallsStatus', params: [callId] }),
      isPending: response => response.status >= 100 && response.status < 200,
      timeoutMs,
      isRetryableError: isRetryableObserverError,
      now: this.observerNow,
      sleep: this.observerSleep,
    })
    const observation = {
      api: 'wallet_getCallsStatus' as const,
      pollCount: polled.pollCount,
    }

    if (polled.kind === 'timed-out') {
      return { status: 'timed-out', observation }
    }
    if (polled.kind === 'error') {
      const serialized = serializeErrorRedacted(polled.error, ownerPrivateKey, [this.apiKey])
      return {
        status: 'observer-error',
        reason: serialized.message,
        observation: {
          ...observation,
          errorClass: polled.error instanceof Error ? polled.error.name : typeof polled.error,
        },
      }
    }

    const response = polled.value
    const terminalStatus = String(response.status)
    if (response.status === 200) {
      const receipt = response.receipts?.[0]
      return {
        status: 'ok',
        ...(receipt?.blockNumber != null ? { blockNumber: BigInt(receipt.blockNumber) } : {}),
        ...(receipt?.transactionHash ? { txHash: receipt.transactionHash } : {}),
        tMs: polled.observedAtMs,
        observation: { ...observation, terminalStatus },
      }
    }
    if (response.status >= 400 && response.status < 700) {
      return {
        status: 'integrity-fail',
        reason: `wallet_getCallsStatus returned terminal status ${response.status}`,
        observation: { ...observation, terminalStatus },
      }
    }
    return {
      status: 'observer-error',
      reason: `wallet_getCallsStatus returned unsupported status ${response.status}`,
      observation: { ...observation, terminalStatus, errorClass: 'UnsupportedStatus' },
    }
  }

  private _createStatusRequest(): StatusRequest {
    const chain = this.chainResolver(this.network)
    const transport = alchemyWalletTransport({ apiKey: this.apiKey })
    const request = transport({ chain }).request
    return async (statusRequest) => request(statusRequest as never) as Promise<WalletCallsStatusResponse>
  }

  // ── Stable-owner self-bootstrap ─────────────────────────────────────────────

  private async _ensureDeployed(signal?: AbortSignal): Promise<void> {
    if (!this.stableOwner) return

    const signerAddress = this.stableOwner.address
    const chain = this.chainResolver(this.network)

    // Resolve the getCode function (injected for tests, real for production).
    const getCode = this.getCodeFn ?? this._makeGetCode(chain)

    // Check if EIP-7702 delegation is already set (non-empty code at the EOA).
    const existingCode = await getCode(signerAddress)
    if (existingCode && existingCode !== '0x') return

    // Not set up — send one untimed setup op via the current sendCalls path.
    const sendSetup = this.sendSetupOpFn ?? ((signer) => this._sendSetupOp(signer))
    await sendSetup(this.stableOwner)

    // Poll until delegation is observable, with a bounded timeout.
    const deadline = Date.now() + BOOTSTRAP_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Bootstrap aborted')
      await sleep(BOOTSTRAP_POLL_INTERVAL_MS)
      // Tolerate transient getCode RPC errors during polling (rate limits,
      // temporary 5xx, network blips) — only the deadline aborts the bootstrap.
      try {
        const code = await getCode(signerAddress)
        if (code && code !== '0x') return
      } catch {
        // transient RPC error — keep polling until the deadline
      }
    }

    throw new Error(
      `Bootstrap timeout: EIP-7702 account ${signerAddress} not delegated within ${BOOTSTRAP_POLL_TIMEOUT_MS / 1000}s`,
    )
  }

  private _makeGetCode(chain: Chain): GetCodeFn {
    const publicClient = createPublicClient({
      chain,
      transport: alchemyTransport({ apiKey: this.apiKey }),
    })
    return (addr) => publicClient.getCode({ address: addr })
  }

  private async _sendSetupOp(signer: ReturnType<typeof privateKeyToAccount>): Promise<void> {
    const chain = this.chainResolver(this.network)
    const client = this.createClient({
      signer,
      transport: alchemyWalletTransport({ apiKey: this.apiKey }),
      chain,
      paymaster: { policyId: this.policyId },
    })

    const { id: callId } = await client.sendCalls({
      calls: [{ to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 0n }],
    })

    // Wait for setup success before returning.
    const status = await client.waitForCallsStatus({
      id: callId,
      timeout: this.canonicalTimeoutMs,
    })

    if (status.status !== 'success') {
      throw new Error(`EIP-7702 setup op failed with status: ${status.status}`)
    }
  }

  // ── Timed send (prepare → sign → send decomposition) ───────────────────────

  async sendSponsored(): Promise<SponsoredResult> {
    // Use the stable owner when configured; fall back to per-call random key.
    const signer = this.stableOwner ?? privateKeyToAccount(this.genKey())

    const chain = this.chainResolver(this.network)

    const client = this.createClient({
      signer,
      transport: alchemyWalletTransport({ apiKey: this.apiKey }),
      chain,
      paymaster: { policyId: this.policyId },
    })

    // Calling to: signer.address (the EIP-7702 smart wallet itself) with empty
    // data invokes the wallet's fallback and fails validation. Use a non-self target.
    const calls = [{ to: '0x000000000000000000000000000000000000dEaD' as const, data: '0x' as const, value: 0n }]

    // ── Stage 1: prepare + sign ──────────────────────────────────────────────
    const tPrepareStart = performance.now()

    // prepareCalls builds the user operation and returns a signature request.
    // The client is already constructed with paymaster caps, but per-call caps
    // are included for explicitness — some SDK versions may require them.
    const prepared = await client.prepareCalls({
      calls,
      capabilities: { paymaster: { policyId: this.policyId } },
    })

    // signPreparedCalls accepts the whole prepareCalls result and returns signed calls.
    const signed = await client.signPreparedCalls(prepared)

    const tPrepareEnd = performance.now()
    const prepareMs = tPrepareEnd - tPrepareStart

    // ── Stage 2: send ─────────────────────────────────────────────────────────
    const tSendStart = performance.now()

    // NOTE: sendPreparedCalls call-pattern ambiguity — the SDK type defs show
    // SendPreparedCallsParams as the signed-call object itself (direct pass:
    // sendPreparedCalls(signed)), while the JSDoc example shows a wrapped form
    // ({ signedCalls }). The direct pass matches the type definition and is used
    // here. This must be verified at runtime against the real SDK — if the
    // wrapped form is required, change to sendPreparedCalls({ ...signed }).
    const { id: callId } = await client.sendPreparedCalls(signed)

    const tSendEnd = performance.now()
    const sendMs = tSendEnd - tSendStart
    const acceptedAtMs = tSendEnd

    // Compatibility total: submitMs = prepareMs + sendMs so downstream consumers
    // that hardcode `submit` keep working (U2 compatibility-total design).
    const submitMs = prepareMs + sendMs

    return {
      userOpHash: callId as `0x${string}`,
      protocolClass: 'wallet-sendcalls',
      submitMs,
      prepareMs,
      sendMs,
      acceptedAtMs,
      accountAddress: signer.address,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createAlchemyWalletSendCallsAdapter(deps?: {
  createClient?: ClientFactory
  generateKey?: KeyGen
  chainResolver?: ChainResolver
  getCodeFn?: GetCodeFn
  sendSetupOpFn?: SendSetupOpFn
  statusRequest?: StatusRequest
  observerNow?: ObserverNow
  observerSleep?: ObserverSleep
}): ProviderAdapter {
  const createClient = deps?.createClient ?? createSmartWalletClient
  const genKey = deps?.generateKey ?? generatePrivateKey
  const chainResolver = deps?.chainResolver ?? resolveChain
  const getCodeFn = deps?.getCodeFn
  const sendSetupOpFn = deps?.sendSetupOpFn
  const statusRequest = deps?.statusRequest
  const observerNow = deps?.observerNow
  const observerSleep = deps?.observerSleep

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
        config.network,
        createClient,
        genKey,
        chainResolver,
        config.ownerPrivateKey,
        getCodeFn,
        sendSetupOpFn,
        statusRequest,
        observerNow,
        observerSleep,
      )
    },
  }
}

export const alchemyWalletSendCallsAdapter: ProviderAdapter = createAlchemyWalletSendCallsAdapter()
