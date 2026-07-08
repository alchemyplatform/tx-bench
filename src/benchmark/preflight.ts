import type { Config } from './config.js'
import type { ProviderRow } from './contracts.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PreflightResult =
  | { ok: true; flashblockAvailable: boolean; warnings: string[] }
  | { ok: false; errors: string[]; flashblockAvailable: boolean; warnings: string[] }

// Dependency types (injectable for testing)
export type ChainIdProber = (url: string) => Promise<number>
export type FlashblockProber = (wsUrl: string) => Promise<boolean>

// ── Neutral URL overlap guard ─────────────────────────────────────────────────

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

export function isNeutralOverlap(neutralUrl: string, providerUrls: readonly string[]): boolean {
  const neutralHost = extractHost(neutralUrl)
  return providerUrls.some(u => extractHost(u) === neutralHost)
}

// ── Default probers (production implementations) ──────────────────────────────

export const defaultChainIdProber: ChainIdProber = async (url) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  const json = await res.json() as { result?: string }
  if (!json.result) throw new Error(`eth_chainId returned no result from ${url}`)
  return parseInt(json.result, 16)
}

export const defaultFlashblockProber: FlashblockProber = (wsUrl) =>
  new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => { ws.close(); resolve(false) }, 3_000)
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(true) }
    ws.onerror = () => { clearTimeout(timeout); resolve(false) }
  })

// ── Main preflight ────────────────────────────────────────────────────────────

export async function runPreflight(
  config: Config,
  runnableRows: readonly ProviderRow[],
  deps?: {
    probeChainId?: ChainIdProber
    probeFlashblock?: FlashblockProber
  }
): Promise<PreflightResult> {
  const probeChainId = deps?.probeChainId ?? defaultChainIdProber
  const probeFlashblock = deps?.probeFlashblock ?? defaultFlashblockProber

  const errors: string[] = []
  const warnings: string[] = []

  // ── 1. Collect all provider RPC URLs ─────────────────────────────────────────
  const providerUrls: string[] = []
  if (config.providers.alchemy) providerUrls.push(config.providers.alchemy.rpcUrl)
  if (config.providers.pimlico) providerUrls.push(config.providers.pimlico.rpcUrl)
  if (config.providers.zerodev) providerUrls.push(config.providers.zerodev.rpcUrl)

  // ── 2. Neutrality guard — neutral node must not overlap any provider ──────────
  if (isNeutralOverlap(config.neutral.rpcUrl, providerUrls)) {
    errors.push(
      `Neutral RPC (${config.neutral.rpcUrl}) overlaps a benchmarked provider — ` +
      'use an independent node for the neutral canonical endpoint'
    )
  }

  if (errors.length > 0) {
    return { ok: false, errors, flashblockAvailable: false, warnings }
  }

  // ── 3. Chain ID agreement ─────────────────────────────────────────────────────
  let referenceChainId: number | null = null

  async function checkChainId(url: string, label: string): Promise<void> {
    try {
      const chainId = await probeChainId(url)
      if (referenceChainId === null) {
        referenceChainId = chainId
      } else if (chainId !== referenceChainId) {
        errors.push(
          `Chain ID mismatch: ${label} returned ${chainId} but expected ${referenceChainId}`
        )
      }
    } catch (e) {
      errors.push(`Chain ID probe failed for ${label} (${url}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Check neutral node first (sets the reference)
  await checkChainId(config.neutral.rpcUrl, 'neutral canonical node')

  // Check each runnable provider
  await Promise.all(
    runnableRows
      .filter(r => r.protocolClass === '4337-bundler')
      .map(async row => {
        // Map each 4337 provider row to its RPC URL for the chain-id agreement
        // check. Alchemy adapters (light-account, mav2, mav2-bso) all use the
        // Alchemy RPC; only the id prefix distinguishes the provider.
        const rpcUrl =
          row.id.startsWith('alchemy-')
            ? config.providers.alchemy?.rpcUrl
            : row.id === 'pimlico-safe'
            ? config.providers.pimlico?.rpcUrl
            : config.providers.zerodev?.rpcUrl

        if (rpcUrl) await checkChainId(rpcUrl, row.label)
      })
  )

  if (errors.length > 0) {
    return { ok: false, errors, flashblockAvailable: false, warnings }
  }

  // ── 4. Flashblock probe ────────────────────────────────────────────────────────
  let flashblockAvailable = false

  if (config.neutral.flashblockWsUrl) {
    try {
      flashblockAvailable = await probeFlashblock(config.neutral.flashblockWsUrl)
      if (!flashblockAvailable) {
        warnings.push(
          `Flashblock endpoint (${config.neutral.flashblockWsUrl}) is not reachable — ` +
          'running in canonical-only mode. Preconfirmation timing will not be available.'
        )
      }
    } catch {
      warnings.push('Flashblock probe threw — running in canonical-only mode')
    }
  } else {
    warnings.push(
      'NEUTRAL_FLASHBLOCK_WS_URL not set — running in canonical-only mode. ' +
      'Preconfirmation timing will not be available.'
    )
  }

  return { ok: true, flashblockAvailable, warnings }
}
