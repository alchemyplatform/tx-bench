import type { Chain } from 'viem'
import { mainnet, base, optimism, arbitrum } from 'viem/chains'

// ── Network → Chain mapping ───────────────────────────────────────────────────
//
// Mirrors the KNOWN_NETWORKS map in src/monitor/loop.ts but lives in the
// benchmark layer so both the CLI and monitor can share it. The adapters use
// this to resolve the viem Chain from config.network instead of hardcoding
// `base`. alchemyTransport derives the chain-specific Alchemy RPC URL from the
// chain passed to the client constructor, so no explicit URL override is needed.

const NETWORK_TO_CHAIN: Record<string, Chain> = {
  'eth-mainnet': mainnet,
  'base-mainnet': base,
  'opt-mainnet': optimism,
  'arb-mainnet': arbitrum,
}

/**
 * Resolve a viem Chain from a network string (e.g. 'base-mainnet').
 * Throws a descriptive error for unknown networks so misconfiguration is loud
 * rather than silently falling back to the wrong chain.
 */
export function resolveChain(network: string): Chain {
  const chain = NETWORK_TO_CHAIN[network]
  if (!chain) {
    throw new Error(
      `Unknown network "${network}". Supported networks: ${Object.keys(NETWORK_TO_CHAIN).join(', ')}`,
    )
  }
  return chain
}
