import { describe, expect, it } from 'bun:test'
import {
  findUserOpInLogs,
  findUserOpInRawLogs,
  USER_OP_EVENT_TOPIC,
} from './identity'
import type { Log } from 'viem'

const HASH_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`
const HASH_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`
const TX_A = ('0x' + 'cc'.repeat(32)) as `0x${string}`
const TX_B = ('0x' + 'dd'.repeat(32)) as `0x${string}`
const BLOCK_A = 100n
const BLOCK_HASH = ('0x' + 'ee'.repeat(32)) as `0x${string}`

function makeLog(userOpHash: `0x${string}`, blockNumber: bigint, txHash: `0x${string}`): Log {
  return {
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    topics: [USER_OP_EVENT_TOPIC, userOpHash],
    data: '0x',
    blockNumber,
    transactionHash: txHash,
    blockHash: BLOCK_HASH,
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
  } as Log
}

function makeRawLog(userOpHash: `0x${string}`, blockNumber: bigint, txHash: `0x${string}`) {
  return {
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    topics: [USER_OP_EVENT_TOPIC, userOpHash],
    data: '0x',
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: txHash,
  }
}

describe('findUserOpInLogs', () => {
  it('returns block and tx coordinates when a matching log is found', () => {
    const logs = [makeLog(HASH_A, BLOCK_A, TX_A)]
    const result = findUserOpInLogs(logs, HASH_A)
    expect(result).toEqual({ blockNumber: BLOCK_A, txHash: TX_A })
  })

  it('returns null when no log matches the userOpHash', () => {
    const logs = [makeLog(HASH_A, BLOCK_A, TX_A)]
    expect(findUserOpInLogs(logs, HASH_B)).toBeNull()
  })

  it('returns null for an empty log array', () => {
    expect(findUserOpInLogs([], HASH_A)).toBeNull()
  })

  it('distinguishes two concurrent userOps sharing one bundle tx', () => {
    // Two userOps in the same bundle: same txHash, different userOpHashes
    const logs = [
      makeLog(HASH_A, BLOCK_A, TX_A),
      makeLog(HASH_B, BLOCK_A, TX_A),
    ]
    expect(findUserOpInLogs(logs, HASH_A)?.txHash).toBe(TX_A)
    expect(findUserOpInLogs(logs, HASH_B)?.txHash).toBe(TX_A)
  })

  it('skips logs with missing blockNumber or txHash', () => {
    const incomplete = { topics: [USER_OP_EVENT_TOPIC, HASH_A], blockNumber: null, transactionHash: null } as unknown as Log
    expect(findUserOpInLogs([incomplete], HASH_A)).toBeNull()
  })

  it('matches case-insensitively', () => {
    const logs = [makeLog(HASH_A, BLOCK_A, TX_A)]
    expect(findUserOpInLogs(logs, HASH_A.toUpperCase() as `0x${string}`)).not.toBeNull()
  })
})

describe('findUserOpInRawLogs', () => {
  it('finds a userOp in a raw flashblock log payload', () => {
    const rawLogs = [makeRawLog(HASH_A, BLOCK_A, TX_A)]
    const result = findUserOpInRawLogs(rawLogs, HASH_A)
    expect(result).toEqual({ blockNumber: BLOCK_A, txHash: TX_A })
  })

  it('returns null when the topic does not match the UserOperationEvent signature', () => {
    const wrongTopicLog = {
      ...makeRawLog(HASH_A, BLOCK_A, TX_A),
      topics: ['0xdeadbeef', HASH_A],
    }
    expect(findUserOpInRawLogs([wrongTopicLog], HASH_A)).toBeNull()
  })

  it('returns null when userOpHash topic does not match', () => {
    const rawLogs = [makeRawLog(HASH_A, BLOCK_A, TX_A)]
    expect(findUserOpInRawLogs(rawLogs, HASH_B)).toBeNull()
  })

  it('skips non-object entries gracefully', () => {
    expect(findUserOpInRawLogs([null, undefined, 42, 'string'], HASH_A)).toBeNull()
  })

  it('handles block_number in alternative field name', () => {
    const rawLog = {
      topics: [USER_OP_EVENT_TOPIC, HASH_A],
      block_number: '0x64',
      transactionHash: TX_A,
    }
    const result = findUserOpInRawLogs([rawLog], HASH_A)
    expect(result?.blockNumber).toBe(100n)
  })
})
