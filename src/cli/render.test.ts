import { describe, expect, it } from 'bun:test'
import type { RunOutput } from '../benchmark/output'
import { renderTable } from './render'

const OUTPUT: RunOutput = {
  env: {
    toolVersion: '1.0.0',
    gitCommit: 'test',
    runnerRegion: 'local',
    generatedAt: '2026-08-05T00:00:00.000Z',
  },
  config: {},
  preconfAvailable: true,
  results: [],
}

describe('renderTable — metric definitions', () => {
  it('defines Flashblock preconfirmation and ttm L2 inclusion', () => {
    const rendered = renderTable(OUTPUT)

    expect(rendered).toContain(
      'Flashblock: accepted → matching UserOperationEvent in newFlashblockTransactions (executed/preconfirmed; not yet an L2 block).',
    )
    expect(rendered).toContain(
      'Time to mine (ttm): accepted → confirmed L2 inclusion with block number + tx hash (MAv2 BSO: eth_getUserOperationReceipt; not L1 finality).',
    )
  })
})
