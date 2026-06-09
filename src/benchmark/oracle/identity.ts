import { parseAbiItem, keccak256, toHex, type Log } from 'viem'

// ── ABI items ─────────────────────────────────────────────────────────────────

export const USER_OP_EVENT = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'
)

// ERC-7683 Fill event — provisional; needs empirical verification against UltraRelay on Base.
// The indexed orderId corresponds to the relay order hash (the intent-relay identity token).
export const ERC7683_FILL_EVENT = parseAbiItem(
  'event Fill(bytes32 indexed orderId, bytes originData, bytes fillerData)'
)

// Pre-compute topic[0] for fast matching in raw log payloads (flashblock schema)
export const USER_OP_EVENT_TOPIC = keccak256(
  toHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')
)

export const ERC7683_FILL_TOPIC = keccak256(
  toHex('Fill(bytes32,bytes,bytes)')
)

// ── Matchers ──────────────────────────────────────────────────────────────────

export type MatchedLog = {
  blockNumber: bigint
  txHash: `0x${string}`
}

/**
 * Searches a set of decoded viem logs for a UserOperationEvent matching userOpHash.
 * Returns the first match's block/tx coordinates, or null if not found.
 */
export function findUserOpInLogs(
  logs: readonly Log[],
  userOpHash: `0x${string}`
): MatchedLog | null {
  for (const log of logs) {
    if (
      log.blockNumber == null ||
      log.transactionHash == null
    ) continue

    // topics[1] is the indexed userOpHash (topic[0] is the event signature)
    const topic1 = log.topics[1]
    if (topic1?.toLowerCase() === userOpHash.toLowerCase()) {
      return { blockNumber: log.blockNumber, txHash: log.transactionHash }
    }
  }
  return null
}

/**
 * Searches a raw flashblock receipt payload (array of plain log objects) for a
 * UserOperationEvent matching userOpHash. The flashblock schema is in flux; this
 * function is tolerant of missing/unknown fields.
 *
 * rawLog shape (provisional, based on Base Flashblocks API):
 * { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }
 */
export function findUserOpInRawLogs(
  rawLogs: readonly unknown[],
  userOpHash: `0x${string}`
): { blockNumber: bigint; txHash: `0x${string}` } | null {
  for (const rawLog of rawLogs) {
    if (typeof rawLog !== 'object' || rawLog === null) continue
    const log = rawLog as Record<string, unknown>

    const topics = log.topics
    if (!Array.isArray(topics) || topics.length < 2) continue
    if (typeof topics[0] !== 'string' || typeof topics[1] !== 'string') continue

    // Check event signature topic
    if (topics[0].toLowerCase() !== USER_OP_EVENT_TOPIC.toLowerCase()) continue
    // Check userOpHash topic
    if (topics[1].toLowerCase() !== userOpHash.toLowerCase()) continue

    const blockHex = log.blockNumber ?? log.block_number
    const txHash = log.transactionHash ?? log.transaction_hash
    if (typeof blockHex !== 'string' || typeof txHash !== 'string') continue

    return {
      blockNumber: BigInt(blockHex),
      txHash: txHash as `0x${string}`,
    }
  }
  return null
}
