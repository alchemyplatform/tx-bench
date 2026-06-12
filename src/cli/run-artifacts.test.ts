import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { findLatestRunJson, formatRunId, resolveRunDirectoryJson, writeRunArtifact } from './run-artifacts'
import type { RunOutput } from '../benchmark/output'

const tempDirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tx-bench-runs-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function output(generatedAt: string): RunOutput {
  return {
    env: { toolVersion: '0.1.0', gitCommit: 'abc123', runnerRegion: 'local', generatedAt },
    config: { redacted: true },
    preconfAvailable: false,
    results: [],
  }
}

describe('formatRunId', () => {
  it('formats generatedAt timestamps in UTC', () => {
    expect(formatRunId('2026-06-11T14:30:22.123Z')).toBe('run-2026-06-11-143022')
  })

  it('rejects invalid timestamps', () => {
    expect(() => formatRunId('not-a-date')).toThrow('Invalid generatedAt timestamp')
  })
})

describe('writeRunArtifact', () => {
  it('writes a finalized run folder with canonical artifacts', () => {
    const rootDir = tempRoot()
    const artifact = writeRunArtifact({
      rootDir,
      output: output('2026-06-11T14:30:22.123Z'),
      json: '{"results":[]}',
      table: 'table output',
    })

    expect(artifact.runId).toBe('run-2026-06-11-143022')
    expect(readFileSync(artifact.runJsonPath, 'utf8')).toBe('{"results":[]}')
    expect(readFileSync(artifact.tablePath, 'utf8')).toBe('table output')
    expect(JSON.parse(readFileSync(artifact.manifestPath, 'utf8'))).toMatchObject({
      runId: 'run-2026-06-11-143022',
      generatedAt: '2026-06-11T14:30:22.123Z',
      toolVersion: '0.1.0',
      gitCommit: 'abc123',
      files: { runJson: 'run.json', table: 'table.txt' },
    })
  })

  it('does not overwrite when two runs share the same timestamp', () => {
    const rootDir = tempRoot()
    const first = writeRunArtifact({ rootDir, output: output('2026-06-11T14:30:22.123Z'), json: 'first', table: 'first table' })
    const second = writeRunArtifact({ rootDir, output: output('2026-06-11T14:30:22.123Z'), json: 'second', table: 'second table' })

    expect(first.runId).toBe('run-2026-06-11-143022')
    expect(second.runId).toBe('run-2026-06-11-143022-2')
    expect(readFileSync(first.runJsonPath, 'utf8')).toBe('first')
    expect(readFileSync(second.runJsonPath, 'utf8')).toBe('second')
  })
})

describe('findLatestRunJson', () => {
  it('finds the newest finalized run folder', () => {
    const rootDir = tempRoot()
    const first = writeRunArtifact({ rootDir, output: output('2026-06-11T14:30:22.123Z'), json: 'first', table: 'first table' })
    const second = writeRunArtifact({ rootDir, output: output('2026-06-11T14:31:22.123Z'), json: 'second', table: 'second table' })

    expect(findLatestRunJson(rootDir)).toBe(second.runJsonPath)
    expect(resolveRunDirectoryJson(first.runDir)).toBe(first.runJsonPath)
  })

  it('ignores folders without run.json', () => {
    const rootDir = tempRoot()
    const artifact = writeRunArtifact({ rootDir, output: output('2026-06-11T14:30:22.123Z'), json: 'first', table: 'first table' })
    writeFileSync(join(rootDir, 'run-2026-06-11-153022'), '')

    expect(findLatestRunJson(rootDir)).toBe(artifact.runJsonPath)
  })

  it('errors clearly when there are no valid runs', () => {
    expect(() => findLatestRunJson(tempRoot())).toThrow('No valid runs found')
  })
})
